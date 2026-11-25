/**
 * 浏览器会话层 —— 无头引擎的「眼睛和手」。
 *
 * 关键设计：
 * 1. **persistent context**：登录态落在 `.profile/`，首次 `login` 之后后续全部无头，
 *    不需要再打开学习通。
 * 2. **addInitScript 注入 agent**：在 goto 之前注册，保证每个 frame（含子 iframe）
 *    的 document 一创建就拿到 `window.__CXAI`。
 * 3. **frame 仲裁**：学习通的对话在 iframe 里，遍历所有 frame 找能 `detect()` 成功的那个，
 *    只认一个（避免多 frame 抢着干活）。
 * 4. **RPC 只传纯数据**：DOM 元素留在页面里，Node 侧永远只收发字符串/数字。
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createLogger } from './logger.mjs';
import { activeAccount, sessionFileOf } from './account.mjs';

const log = createLogger('session');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_BUNDLE = resolve(ROOT, 'dist/agent.js');

/**
 * 登录态快照文件。
 *
 * 为什么必须单独存：学习通的 `_uid` / `UID` / `uf` 等关键 cookie 都是
 * **session cookie（无 expires）**，persistent context 关闭时不会落盘，
 * 下次启动就丢，于是「登录成功」却在下一个进程里被弹回登录页。
 * 解决：登录后立刻 `storageState()` 导出（它包含 session cookie），
 * 每次启动再 `addCookies()` 灌回去。
 */
const LEGACY_SESSION_FILE = resolve(ROOT, '.session.json');

/** 当前账号对应的 cookie 快照路径。 */
function currentSessionFile(phone) {
  const p = phone || activeAccount()?.phone || '';
  if (p) return sessionFileOf(p);
  return LEGACY_SESSION_FILE;
}

/** 学习通登录页（首次人工登录用）。 */
export const LOGIN_URL =
  'https://passport2.chaoxing.com/login?fid=&newrefer=https%3A%2F%2Fi.chaoxing.com';

/** 验证码（短信）登录页：loginType=2。 */
export const SMS_LOGIN_URL =
  'https://passport2.chaoxing.com/login?loginType=2&newversion=true&fid=-1' +
  '&refer=http%3A%2F%2Fi.mooc.chaoxing.com&retainlogin=2';

export class BrowserSession {
  constructor(config, options = {}) {
    this.config = config;
    /** 目标账号手机号；不传则用账号池里激活的那个。 */
    this.phone = options.phone || '';
    this.context = null;
    this.page = null;
    this.browser = null;
    this.agentSource = null;
  }

  /** 读取打包好的页内 agent 源码。 */
  loadAgentSource() {
    if (this.agentSource) return this.agentSource;
    if (!existsSync(AGENT_BUNDLE)) {
      throw new Error(
        `页内 agent 未构建：缺少 ${AGENT_BUNDLE}\n先运行：node esbuild.agent.mjs`,
      );
    }
    this.agentSource = readFileSync(AGENT_BUNDLE, 'utf8');
    return this.agentSource;
  }

  /**
   * 启动浏览器。
   *
   * @param {{ headless?: boolean, userDataDir?: string }} options
   */
  async launch({ headless = this.config.headless, ephemeral = false } = {}) {
    const agent = this.loadAgentSource();

    /* ---- 临时模式：独立 browser + context，不碰主 profile ---- */
    // 用途：任务正在跑（占着 persistent profile）时，仍要能查课程/任务列表。
    // 登录态靠 .session.json 里的 cookie 导入。
    if (ephemeral) {
      this.browser = await chromium.launch({
        headless,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
      });
      this.context = await this.browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      });
      const ephFile = currentSessionFile(this.phone);
      if (existsSync(ephFile)) {
        try {
          const snap = JSON.parse(readFileSync(ephFile, 'utf8'));
          if (Array.isArray(snap.cookies) && snap.cookies.length) {
            await this.context.addCookies(snap.cookies);
          }
        } catch {
          /* cookie 坏了就当未登录 */
        }
      }
      await this.context.addInitScript({ content: agent });
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(30_000);
      log.info('浏览器已启动（临时模式，不占用主 profile）');
      return this.context;
    }

    const userDataDir = this.config.userDataDir;
    mkdirSync(userDataDir, { recursive: true });

    const launchOptions = {
      headless,
      // 无头下也需要真实 UA / 视口，学习通前端会读
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    };
    if (this.config.executablePath) launchOptions.executablePath = this.config.executablePath;

    this.context = await chromium.launchPersistentContext(userDataDir, launchOptions);

    // 可选：从导出的 storageState 导入 cookies（换机器用）
    if (this.config.storageState && existsSync(this.config.storageState)) {
      try {
        const state = JSON.parse(readFileSync(this.config.storageState, 'utf8'));
        if (Array.isArray(state.cookies) && state.cookies.length) {
          await this.context.addCookies(state.cookies);
          log.info(`已导入 ${state.cookies.length} 条 cookies`);
        }
      } catch (err) {
        log.warn(`storageState 导入失败：${err.message}`);
      }
    }

    // 关键：goto 之前注册，所有后续 frame 自动带 agent
    await this.context.addInitScript({ content: agent });

    // 恢复上次登录态快照（含 session cookie，persistent profile 存不下这些）
    await this.restoreSession();

    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    this.page.setDefaultTimeout(30_000);
    log.info(`浏览器已启动 headless=${headless} profile=${userDataDir}`);
    return this.context;
  }

  /** 把上次保存的 cookie 快照灌回 context。 */
  async restoreSession() {
    const file = currentSessionFile(this.phone);
    if (!existsSync(file)) return;
    try {
      const snap = JSON.parse(readFileSync(file, 'utf8'));
      const cookies = Array.isArray(snap.cookies) ? snap.cookies : [];
      if (!cookies.length) return;
      // storageState 导出时 expires=-1 表示 session cookie，addCookies 认这个值
      await this.context.addCookies(cookies);
      const ago = snap.savedAt ? Math.round((Date.now() - snap.savedAt) / 60000) : null;
      log.info(`已恢复 ${cookies.length} 条 cookie${ago !== null ? `（${ago} 分钟前保存）` : ''}`);
    } catch (err) {
      log.warn(`登录态快照恢复失败：${err.message}`);
    }
  }

  /**
   * 彻底清空登录态：删快照 + 清 context 里的所有 cookie。
   *
   * 为什么需要：登录前若保留旧账号的快照，`launch()` 会把它灌回去，
   * 换账号时会出现「登录了新账号，实际还是旧身份」的鬼打墙。
   */
  async clearSession() {
    const file = currentSessionFile(this.phone);
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {
      /* 文件不存在或删不掉都继续 */
    }
    try {
      const cookies = await this.context.cookies();
      await this.context.clearCookies();
      log.info(`已清除 ${cookies.length} 条旧 cookie`);
    } catch {
      /* context 未就绪 */
    }
  }

  /** 导出当前 cookie 快照（含 session cookie）。 */
  async saveSession() {
    if (!this.context) return null;
    if (this.browser) return null; // 临时模式不覆盖主快照
    try {
      const state = await this.context.storageState();
      const payload = { cookies: state.cookies ?? [], savedAt: Date.now(), phone: this.phone || '' };
      const file = currentSessionFile(this.phone);
      writeFileSync(file, JSON.stringify(payload), 'utf8');
      log.info(`登录态快照已保存（${payload.cookies.length} 条 cookie → ${file.split('/').pop()}）`);
      return file;
    } catch (err) {
      log.warn(`登录态快照保存失败：${err.message}`);
      return null;
    }
  }

  /** 打开目标页面。 */
  async goto(url) {
    if (!this.page) throw new Error('浏览器未启动');
    log.info(`打开 ${url}`);
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    return this.page;
  }

  /** 当前页面是否停在登录页（登录态失效的判定）。 */
  isLoginPage() {
    if (!this.page) return false;
    const url = this.page.url();
    return /passport|login|sso/i.test(url);
  }

  /**
   * 在所有 frame 里找「能探测到对话窗口」的那个。
   *
   * @param {{ timeoutMs?: number, intervalMs?: number }} options
   * @returns {Promise<{ frame: import('playwright').Frame, summary: object, url: string } | null>}
   */
  async findChatFrame({ timeoutMs = this.config.detectTimeoutMs, intervalMs = 1500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastReport = 0;

    for (;;) {
      const frames = this.page.frames();
      for (const frame of frames) {
        let result;
        try {
          result = await frame.evaluate(() => {
            const api = window.__CXAI;
            if (!api) return { ok: false, error: { code: 'NO_AGENT', message: 'agent 未注入' } };
            return api.detect();
          });
        } catch {
          continue; // 跨域/已销毁的 frame 直接跳过
        }
        if (result?.ok) {
          log.info(
            `命中对话窗口 confidence=${result.confidence} source=${result.source} ` +
              `消息数=${result.messageCount} 输入框${result.inputLocked ? '锁定' : '可用'} url=${frame.url()}`,
          );
          return { frame, summary: result, url: frame.url() };
        }
      }

      if (Date.now() - lastReport > 10_000) {
        lastReport = Date.now();
        log.info(`等待对话窗口…（已扫描 ${frames.length} 个 frame，剩余 ${Math.round((deadline - Date.now()) / 1000)}s）`);
      }
      if (Date.now() >= deadline) {
        log.warn('超时：没有找到可用的对话窗口');
        return null;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /**
   * 对页内 agent 发一次 RPC。
   *
   * @param {import('playwright').Frame} frame 目标 frame
   * @param {string} method agent 方法名
   * @param {...unknown} args 参数（必须可序列化）
   */
  async rpc(frame, method, ...args) {
    return frame.evaluate(
      async ({ m, a }) => {
        const api = window.__CXAI;
        if (!api) return { ok: false, error: { code: 'NO_AGENT', message: 'agent 未注入' } };
        const fn = api[m];
        if (typeof fn !== 'function') {
          return { ok: false, error: { code: 'NO_METHOD', message: `agent 无方法 ${m}` } };
        }
        try {
          return await fn.apply(api, a);
        } catch (err) {
          return {
            ok: false,
            error: { code: err?.code ?? 'RPC_THROW', message: err?.message ?? String(err) },
          };
        }
      },
      { m: method, a: args },
    );
  }

  /** 出错时留一张截图（存 logs/）。 */
  async screenshot(name, dir = this.config.logDir) {
    if (!this.page) return null;
    try {
      mkdirSync(dir, { recursive: true });
      const path = resolve(dir, `${name}-${Date.now()}.png`);
      await this.page.screenshot({ path, fullPage: false });
      return path;
    } catch (err) {
      log.warn(`截图失败：${err.message}`);
      return null;
    }
  }

  /**
   * 校验登录态。
   *
   * 注意：**不能用 `fid`** —— 那是学校/机构 ID，未登录时也可能已存在，
   * 用它判定会伪造出「登录成功」。真正的用户凭证是 `_uid` / `UID` / `uf`。
   */
  async isLoggedIn() {
    const cookies = await this.context.cookies();
    return cookies.some(
      (c) => /^(_?uid|uf|_d)$/i.test(c.name) && String(c.value ?? '').trim().length > 0,
    );
  }

  /**
   * 抓某门课的作业列表（含完成状态与截止时间）。
   *
   * 作业在课程页的「作业」tab，iframe 是 `mooc1.chaoxing.com/mooc2/work/list`。
   * 每行 `onclick="goTask(this)"`，行文本形如：
   *   「7-课前作业-职业环境与健康  未完成  截止 12-06」
   *
   * @param {string} courseHref
   */
  async listHomeworks(courseHref) {
    if (!this.page) throw new Error('浏览器未启动');
    const page = this.page;

    await page.goto(courseHref, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(5000);

    // 点「作业」，带重试
    let frame = null;
    for (let attempt = 0; attempt < 3 && !frame; attempt += 1) {
      const ok = await page
        .evaluate(() => {
          const el = [...document.querySelectorAll('a,li,div,span')].filter(
            (e) => (e.textContent || '').trim() === '作业',
          );
          if (!el.length) return false;
          el[0].click();
          return true;
        })
        .catch(() => false);
      if (!ok) {
        await page.waitForTimeout(2000);
        continue;
      }
      for (let i = 0; i < 10; i += 1) {
        await page.waitForTimeout(2000);
        frame = page.frames().find((f) => /work\/list/.test(f.url()));
        if (frame) break;
      }
    }
    if (!frame) return [];

    // 等列表渲染
    for (let i = 0; i < 8; i += 1) {
      const n = await frame.evaluate(() => document.querySelectorAll('[onclick*=goTask], li').length).catch(() => 0);
      if (n > 0) break;
      await page.waitForTimeout(2000);
    }

    return frame.evaluate(() => {
      const out = [];
      const seen = new Set();
      for (const el of document.querySelectorAll('[onclick*=goTask]')) {
        const raw = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!raw || raw.length < 5) continue;
        const title = raw.replace(/(已完成|未完成|待提交|进行中|已过期).*$/, '').trim();
        if (!title || seen.has(title)) continue;
        seen.add(title);

        const done = /已完成/.test(raw);
        const deadlineM = raw.match(/(?:截止|剩余)\s*[:：]?\s*([0-9\-: \u4e00-\u9fa5]+)/);
        out.push({
          title,
          done,
          raw: raw.slice(0, 100),
          deadline: deadlineM ? deadlineM[1].trim() : '',
          href: (el.querySelector('a')?.getAttribute('href') || '').slice(0, 200),
          onclick: (el.getAttribute('onclick') || '').slice(0, 60),
        });
      }
      return out;
    });
  }

  /**
   * 点开某条作业，返回新页面 URL（可能是新窗口）。
   *
   * @param {string} courseHref
   * @param {string} title 作业标题，用来定位点哪一条
   */
  async openHomework(courseHref, title) {
    const page = this.page;
    await this.listHomeworks(courseHref); // 确保停在作业列表

    const frame = page.frames().find((f) => /work\/list/.test(f.url()));
    if (!frame) return null;

    const popupPromise = this.context.waitForEvent('page', { timeout: 15_000 }).catch(() => null);
    const clicked = await frame.evaluate((t) => {
      const el = [...document.querySelectorAll('[onclick*=goTask]')].find((e) =>
        (e.innerText || '').includes(t),
      );
      if (!el) return false;
      el.click();
      return true;
    }, title);
    if (!clicked) return null;

    const popup = await popupPromise;
    const target = popup || page;
    await target.waitForTimeout(6000);
    return { page: target, url: target.url() };
  }

  /**
   * 取任务的「评分要点」。
   *
   * 学习通不给文字评语，但 `load-data` 接口的 `requirement` 字段里写着
   * 这次实践要覆盖哪几个方面（形如「① xxx；② yyy；③ zzz」）——
   * 这就是打分的维度，照着答比什么都准。
   *
   * @param {{courseid: string, clazzid: string, cpi: string, uuid: string}} args
   * @returns {Promise<{ requirement: string, title: string, scene: string } | null>}
   */
  async fetchTaskRequirement({ courseid, clazzid, cpi, uuid }) {
    if (!this.page || !uuid) return null;
    try {
      const url =
        'https://mooc2-ans.chaoxing.com/mooc2-ans/ai-evaluate/v2/answer/load-data' +
        `?courseid=${courseid}&clazzid=${clazzid}&cpi=${cpi}&publishRelationUuid=${uuid}`;
      return await this.page.evaluate(async (u) => {
        const r = await fetch(u, { credentials: 'include' });
        const j = await r.json();
        const d = j?.data || {};
        return {
          requirement: d.requirement || '',
          title: d.title || '',
          scene: d.scene || '',
        };
      }, url);
    } catch {
      return null;
    }
  }

  /**
   * 读当前登录账号的档案（姓名 / 学校 / uid / 头像）。
   *
   * 学习通个人空间把昵称放在 `.user-name`，学校名是首屏第一段文字，
   * uid 在 `_uid` cookie 里，头像走 `photo.chaoxing.com/p/<uid>_80`。
   */
  async fetchUserInfo() {
    if (!this.page) return null;
    const page = this.page;
    try {
      await page
        .goto('https://i.chaoxing.com/', { waitUntil: 'domcontentloaded', timeout: 40_000 })
        .catch(() => {});
      await page.waitForTimeout(4500);
      return await page.evaluate(() => {
        const name =
          document.querySelector('.user-name')?.textContent?.trim() ||
          document.querySelector('[class*=userName]')?.textContent?.trim() ||
          '';
        const text = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
        // 首屏第一段一般是学校名
        const school = text.split(/\s{1,}/)[0] || '';
        const uidM = document.cookie.match(/_uid=(\d+)/);
        const avatarEl = document.querySelector('.head-img') || document.querySelector('.icon-head');
        return {
          name: String(name).slice(0, 30),
          school: String(school).slice(0, 40),
          uid: uidM ? uidM[1] : '',
          avatar: avatarEl?.getAttribute('src') || '',
        };
      });
    } catch {
      return null;
    }
  }

  /**
   * 账号密码自动登录（实测可行：登录页就是 `#phone` + `#pwd` + `#loginBtn`，
   * 初始状态**没有图形验证码**，协议也无需勾选）。
   *
   * @param {{ phone: string, password: string, timeoutMs?: number }} args
   * @returns {Promise<{ ok: boolean, reason?: string, hint?: string }>}
   */
  async loginWithPassword({ phone, password, timeoutMs = 25_000 }) {
    if (!this.page) throw new Error('浏览器未启动');
    const page = this.page;

    // 先清旧账号残留，再从干净状态登录
    this.phone = String(phone || this.phone || '');
    await this.clearSession();

    await this.goto(LOGIN_URL);
    await page.waitForSelector('#phone', { timeout: 20_000 });
    await page.waitForSelector('#pwd', { timeout: 10_000 });

    await page.fill('#phone', phone);
    await page.fill('#pwd', password);

    // 「下次自动登录」= 延长 cookie 有效期，对长期挂机有用；点不到就算了
    try {
      await page.click('text=下次自动登录', { timeout: 1500 });
    } catch {
      /* 非关键 */
    }

    await page.click('#loginBtn');

    // 服务端有多快回多快：**只认用户凭证 cookie**，不看 URL。
    // （早期版本用「URL 离开登录页」判定，会在跳转中途误报成功，
    //   随后浏览器关闭，cookie 还没落盘 → 假成功。）
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(600);

      if (await this.isLoggedIn()) {
        // 再等一拍，让会话稳定后导出（session cookie 必须显式存）
        await page.waitForTimeout(900);
        await this.saveSession();
        const user = await this.fetchUserInfo();
        return { ok: true, user };
      }

      const errText = await page
        .locator('.err-tip')
        .first()
        .textContent({ timeout: 400 })
        .catch(() => null);
      if (errText && errText.trim()) {
        const msg = errText.trim();
        const needsCaptcha = /验证码|二次|安全验证|异常/i.test(msg);
        return {
          ok: false,
          reason: msg,
          hint: needsCaptcha
            ? '该账号触发了验证码/二次验证，请改用 Web 控制台的「验证码登录」'
            : /密码|账号|手机号/.test(msg)
              ? '账号或密码不对；若该账号只开了短信验证码登录，请改用「验证码登录」'
              : '登录被拒绝，请换「验证码登录」试试',
        };
      }

      // 出现图形验证码 input → 密码登录走不通
      const hasCaptcha = await page
        .locator('input[id*=captcha], input[name*=captcha], img[id*=captcha]')
        .count()
        .catch(() => 0);
      if (hasCaptcha > 0) {
        return {
          ok: false,
          reason: '页面要求输入图形验证码',
          hint: '改用 Web 控制台的「验证码登录」（短信）',
        };
      }
    }

    return { ok: false, reason: '等待登录结果超时', hint: '改用「验证码登录」' };
  }

  /* ------------------------------------------------------------------ */
  /* 短信验证码登录（两步：发码 → 填码）                                  */
  /* ------------------------------------------------------------------ */

  /**
   * 第一步：打开验证码登录页，填手机号，点「获取验证码」。
   *
   * 注意：**不关闭浏览器**。短信验证码是两步交互，同一个 page 实例必须活着，
   * 否则第二步的 `#vercode` 就不在同一个会话里了。
   *
   * @param {string} phone 手机号
   */
  async openSmsLogin(phone) {
    if (!this.page) throw new Error('浏览器未启动');
    const page = this.page;

    this.phone = String(phone || this.phone || '');
    await this.clearSession();

    await this.goto(SMS_LOGIN_URL);
    await page.waitForSelector('#phone', { timeout: 20_000 });

    await page.fill('#phone', phone);
    // 让前端完成手机号校验（blur 才触发）
    await page.locator('#phone').press('Tab').catch(() => {});
    await page.waitForTimeout(400);

    await page.click('#sendCodeBtn');

    // 等按钮进入倒计时或出现错误
    await page.waitForTimeout(2800);

    const errText = await page
      .locator('.err-tip')
      .first()
      .textContent({ timeout: 800 })
      .catch(() => null);

    if (errText && errText.trim()) {
      return { ok: false, reason: errText.trim() };
    }

    // 发码成功时按钮通常会变成「60s」「重新获取」之类
    const btnText = (await page
      .locator('#sendCodeBtn')
      .textContent({ timeout: 800 })
      .catch(() => '')) || '';

    // 出现了滑块/图形验证 → 短信发不出去
    const needCaptcha = await page
      .locator('[class*=captcha], [class*=slider], [id*=captcha], iframe[src*=captcha]')
      .count()
      .catch(() => 0);

    return {
      ok: true,
      btnText: btnText.trim(),
      needCaptcha: needCaptcha > 0,
      hint: needCaptcha > 0 ? '页面要求滑块/图形验证，短信可能发不出去，请改用密码登录' : '',
    };
  }

  /**
   * 第二步：在同一个会话里填验证码并提交。
   *
   * @param {{ code: string, timeoutMs?: number }} args
   */
  async submitSmsCode({ code, timeoutMs = 25_000 }) {
    if (!this.page) throw new Error('浏览器未启动或会话已结束，请重新获取验证码');
    const page = this.page;

    await page.waitForSelector('#vercode', { timeout: 10_000 });
    await page.fill('#vercode', code);
    await page.click('#loginBtn');

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(700);

      if (await this.isLoggedIn()) {
        await page.waitForTimeout(900);
        await this.saveSession();
        const user = await this.fetchUserInfo();
        return { ok: true, user };
      }

      const errText = await page
        .locator('.err-tip')
        .first()
        .textContent({ timeout: 500 })
        .catch(() => null);
      if (errText && errText.trim()) {
        return { ok: false, reason: errText.trim() };
      }
    }
    return { ok: false, reason: '等待登录结果超时（验证码可能已过期）' };
  }

  /* ------------------------------------------------------------------ */
  /* 课程列表 / 课程任务                                                 */
  /* ------------------------------------------------------------------ */

  /** 抓「我学的课」列表。 */
  async listCourses() {
    if (!this.page) throw new Error('浏览器未启动');
    await this.goto('https://mooc1.chaoxing.com/visit/interaction');
    await this.page.waitForTimeout(3500);

    return this.page.evaluate(() => {
      const seen = new Set();
      const out = [];
      for (const a of document.querySelectorAll('a[href*="stucoursemiddle"]')) {
        const u = new URL(a.href, location.href);
        const courseid = u.searchParams.get('courseid');
        if (!courseid || seen.has(courseid)) continue;
        seen.add(courseid);

        // 标题在卡片容器里，往上找有文本的祖先
        let card = a;
        for (let i = 0; i < 4 && card.parentElement; i += 1) {
          card = card.parentElement;
          if ((card.innerText || '').trim().length > 3) break;
        }
        const raw = (card.innerText || '').replace(/\s+/g, ' ').trim();
        const parts = raw.split(' ');
        const title = (parts[0] || '').slice(0, 40);

        out.push({
          title,
          brief: raw.slice(0, 70),
          courseid,
          clazzid: u.searchParams.get('clazzid'),
          cpi: u.searchParams.get('cpi'),
          href: a.href,
        });
      }
      return out;
    });
  }

  /**
   * 进某门课，读「任务」与「章节」两个 tab 的内容。
   *
   * 注意：这两个 tab 都是 iframe，且跨到子域（mobilelearn / mooc2-ans），
   * 所以必须拿到对应 frame 再读它的 DOM —— 主文档里只有空壳。
   *
   * @param {string} courseHref 课程卡片上的真实链接（自带动态 enc，不能手工拼）
   */
  async courseDetail(courseHref) {
    if (!this.page) throw new Error('浏览器未启动');
    const page = this.page;

    await page.goto(courseHref, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(4500);

    const clickTab = async (name) => {
      const ok = await page.evaluate((n) => {
        const els = [...document.querySelectorAll('a,li,div,span')]
          .filter((e) => (e.textContent || '').trim() === n);
        if (!els.length) return false;
        els[0].click();
        return true;
      }, name);
      if (ok) await page.waitForTimeout(7000);
      return ok;
    };

    const out = { url: page.url(), title: await page.title(), tasks: [], chapters: [], errors: [] };

    /* ---- 任务 tab ---- */
    if (await clickTab('任务')) {
      const frame = page.frames().find((f) => /stuActiveList|active\/stu/i.test(f.url()));
      if (frame) {
        try {
          const d = await frame.evaluate(() => {
            const rows = [...document.querySelectorAll('li, .item, [class*=item]')]
              .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim())
              .filter((t) => t.length > 4 && t.length < 200);
            return {
              text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 600),
              rows: [...new Set(rows)].slice(0, 40),
            };
          });
          out.tasks = d.rows;
          out.taskText = d.text;
        } catch (err) {
          out.errors.push('任务 iframe 读取失败：' + err.message);
        }
      } else {
        out.errors.push('没有找到任务 iframe');
      }
    }

    /* ---- 章节 tab ---- */
    if (await clickTab('章节')) {
      const frame = page.frames().find((f) => /studentcourse/i.test(f.url()));
      if (frame) {
        try {
          const d = await frame.evaluate(() => {
            const items = [...document.querySelectorAll('[class*=chapter], .chapter_item, li')]
              .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim())
              .filter((t) => t.length > 2 && t.length < 160);
            const links = [...document.querySelectorAll('a')]
              .map((a) => ({
                t: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 34),
                h: (a.href || '').slice(0, 200),
              }))
              .filter((x) => x.t);
            return {
              text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 800),
              items: [...new Set(items)].slice(0, 40),
              links: links.slice(0, 30),
            };
          });
          out.chapters = d.items;
          out.chapterText = d.text;
          out.chapterLinks = d.links;
        } catch (err) {
          out.errors.push('章节 iframe 读取失败：' + err.message);
        }
      } else {
        out.errors.push('没有找到章节 iframe');
      }
    }

    return out;
  }

  /* ------------------------------------------------------------------ */
  /* AI 实践任务（activetype=77）                                        */
  /* ------------------------------------------------------------------ */

  /**
   * 抓某门课「任务」tab 里的全部 AI 实践任务。
   *
   * 学习通把 AI 实践标记为 `activetype="77"`，任务行上有 `content` JSON，
   * 内含 `stuUrl`（学生作答入口）与 `sourceConfig.publishRelationUuid`。
   *
   * @param {string} courseHref 课程真实链接
   */
  async listAiTasks(courseHref) {
    if (!this.page) throw new Error('浏览器未启动');
    const page = this.page;

    await page.goto(courseHref, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(5000);

    /* ---- 点「任务」，带重试 ---- */
    let frame = null;
    for (let attempt = 0; attempt < 3 && !frame; attempt += 1) {
      const clicked = await page
        .evaluate(() => {
          const el = [...document.querySelectorAll('a,li,div,span')]
            .filter((e) => (e.textContent || '').trim() === '任务');
          if (!el.length) return false;
          el[0].click();
          return true;
        })
        .catch(() => false);
      if (!clicked) {
        await page.waitForTimeout(2500);
        continue;
      }
      // 等 iframe 出现（页面慢时要十几秒）
      for (let i = 0; i < 10; i += 1) {
        await page.waitForTimeout(2000);
        frame = page.frames().find((f) => /stuActiveList/.test(f.url()));
        if (frame) break;
      }
    }
    if (!frame) {
      log.warn('没有等到任务 iframe');
      return [];
    }

    /* ---- 等任务行渲染出来（列表是异步拉的） ---- */
    let rows = 0;
    for (let i = 0; i < 10; i += 1) {
      rows = await frame
        .evaluate(() => document.querySelectorAll('[activetype]').length)
        .catch(() => 0);
      if (rows > 0) break;
      await page.waitForTimeout(2000);
    }
    if (!rows) log.warn('任务 iframe 里没有渲染出任何任务行');

    return frame.evaluate(() => {
      const out = [];
      for (const n of document.querySelectorAll('[activetype]')) {
        if (n.getAttribute('activetype') !== '77') continue;
        let content = {};
        try { content = JSON.parse(n.getAttribute('content') || '{}'); } catch { /* ignore */ }
        let cfg = {};
        try { cfg = JSON.parse(content.sourceConfig || '{}'); } catch { /* ignore */ }
        const raw = (n.innerText || '').replace(/\s+/g, ' ').trim();
        const title = raw.replace(/剩余[:：].*$/, '').replace(/结束时间[:：].*$/, '').trim();
        out.push({
          title,
          activeid: n.getAttribute('activeid'),
          userstatus: n.getAttribute('userstatus'),
          stuUrl: content.stuUrl || '',
          uuid: cfg.publishRelationUuid || '',
          endTime: cfg.endTime || 0,
        });
      }
      return out;
    });
  }

  /**
   * 打开一个 AI 实践任务，读出分数与情景设定。
   *
   * @param {string} stuUrl 任务行里的 stuUrl
   */
  async aiTaskInfo(stuUrl) {
    if (!this.page) throw new Error('浏览器未启动');
    const page = this.page;

    await page.goto(stuUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(6000);

    const info = await page.evaluate(() => {
      const text = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
      const url = location.href;
      // 任务形态判定：不同类型页面完全不同
      let kind = 'unknown';
      if (/situationalDialogue/i.test(url)) kind = 'dialogue';
      else if (/think-ladder|thinkLadder/i.test(url)) kind = 'ladder';
      else if (/阶梯闯关/.test(text)) kind = 'ladder';
      else if (/开始对话|医患情景|情景对话/.test(text)) kind = 'dialogue';

      const scoreM = text.match(/最终得分\s*(\d+)\s*分/);
      const avgM = text.match(/(?:平均分|最高分)[^\d]{0,6}(\d+)\s*分/);
      const timesM = text.match(/已练习\s*(\d+)\s*次/);
      const reqM = text.match(/达标标准[:：]?\s*([^。]{0,40}?分)/);
      // 情景说明：通常在「情景生成」之后
      const scenarioIdx = text.indexOf('情景生成');
      const scenario = scenarioIdx >= 0 ? text.slice(scenarioIdx + 4, scenarioIdx + 500).trim() : '';
      return {
        url,
        kind,
        score: scoreM ? Number(scoreM[1]) : (avgM ? Number(avgM[1]) : null),
        attempts: timesM ? Number(timesM[1]) : 0,
        requirementText: reqM ? reqM[1] : '',
        requirement: (reqM && Number((reqM[1].match(/(\d+)/) || [])[1])) || 80,
        scenario,
        text: text.slice(0, 400),
        hasStartBtn: /开始对话/.test(text),
      };
    });

    return info;
  }

  async close() {
    try {
      await this.context?.close();
    } catch {
      /* 已关闭 */
    }
    try {
      await this.browser?.close();
    } catch {
      /* 已关闭 */
    }
    this.context = null;
    this.page = null;
    this.browser = null;
  }
}
