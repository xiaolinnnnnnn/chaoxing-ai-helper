/**
 * Web 控制台 —— 零依赖 HTTP 服务（node:http），与 cidaren 的 Flask 面板同一定位：
 * 手机/平板打开网页就能看进度、启停任务、读日志。
 *
 * 接口：
 *   GET  /                控制台页面
 *   GET  /api/status      运行状态 + 最近事件 + 断点
 *   GET  /api/logs        环形日志
 *   GET  /api/reports     报告列表
 *   GET  /api/report?f=   单份报告正文
 *   POST /api/start       { once?, rounds?, url? }
 *   POST /api/stop
 */
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LlmClient } from './llm.mjs';
import { BrowserSession } from './session.mjs';
import { runAiTask, runDialogue, RunState } from './runner.mjs';
import { writeReport } from './report.mjs';
import { createLogger, getRing, startFileLog } from './logger.mjs';
import { applyPatch, publicConfig, saveEnv } from './config.mjs';
import { allFeedback, feedbackOf } from './feedback.mjs';
import { activeAccount, allAccounts, clearAccount, getAccount, publicAccount, removeAccount, saveAccount, setActiveAccount, upsertAccount } from './account.mjs';

const log = createLogger('server');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEBUI = resolve(ROOT, 'webui/index.html');

/** 全局任务状态（单实例：同一时间只跑一个任务）。 */
const runtime = {
  running: false,
  phase: 'idle',
  round: 0,
  limit: 0,
  startedAt: null,
  url: '',
  events: [],
  abort: null,
  lastReport: null,
  error: null,
  /** 登录态缓存：不轮询时反复启浏览器，只在显式检测或任务结束后更新。 */
  loggedIn: null,
  loggedInAt: null,
  /** 课程列表缓存（抓一次要十几秒，别每次轮询都抓）。 */
  courseCache: null,
  aiTaskCache: null,
};

function pushEvent(event) {
  runtime.events.push({ ...event, at: Date.now() });
  if (runtime.events.length > 300) runtime.events.shift();

  if (event.type === 'status') {
    runtime.phase = event.phase;
    runtime.round = event.round ?? runtime.round;
    runtime.limit = event.limit ?? runtime.limit;
  }
  if (event.type === 'done') {
    runtime.running = false;
    runtime.phase = 'done';
    runtime.lastReport = event.report;
  }
  if (event.type === 'error') {
    runtime.error = event.message;
  }
}

async function startTask(config, params = {}) {
  if (runtime.running) throw new Error('已有任务在跑');

  const runConfig = { ...config };
  if (params.url) runConfig.targetUrl = params.url;
  if (params.rounds) runConfig.maxRounds = Number.parseInt(params.rounds, 10) || runConfig.maxRounds;
  if (params.model) runConfig.model = params.model;

  runtime.running = true;
  runtime.phase = 'starting';
  runtime.round = 0;
  runtime.limit = params.once ? 1 : runConfig.maxRounds;
  runtime.startedAt = Date.now();
  runtime.url = runConfig.targetUrl;
  runtime.events = [];
  runtime.error = null;
  runtime.abort = new AbortController();

  const session = new BrowserSession(runConfig);
  const llm = new LlmClient(runConfig);

  try {
    await session.launch();
    await session.goto(runConfig.targetUrl);
    const report = await runDialogue({
      session,
      config: runConfig,
      llm,
      signal: runtime.abort.signal,
      onEvent: pushEvent,
      once: Boolean(params.once),
    });
    report.reportPath = writeReport(report, runConfig);
  } catch (err) {
    runtime.error = err?.message ?? String(err);
    runtime.phase = 'error';
    log.error(runtime.error);
  } finally {
    await session.close();
    runtime.running = false;
    if (runtime.phase !== 'done' && runtime.phase !== 'error') runtime.phase = 'idle';
  }
}

/** 短信验证码登录的临时会话（两步交互，必须共用同一个浏览器）。 */
let smsLogin = null;

/** 关闭短信登录会话。 */
async function closeSmsLogin() {
  if (!smsLogin) return;
  if (smsLogin.timer) clearTimeout(smsLogin.timer);
  try {
    await smsLogin.session.close();
  } catch {
    /* 已关闭 */
  }
  smsLogin = null;
}

/**
 * 账号级并发调度器。
 *
 * 规则（按需求）：
 * - **同一账号内部严格串行** —— 一个账号同时只跑一个任务，避免自己跟自己抢输入框；
 * - **最多 N 个账号并行**（默认 3）—— 不同账号各开各的浏览器，互不干扰；
 * - 其余任务排队，前面完成一个就补一个。
 *
 * 为什么必须用临时浏览器：persistent profile 同一时间只能被一个实例占用，
 * 想并行只能每个账号一个独立 context，登录态从 `.sessions/<phone>.json` 导入。
 *
 * @param {object} config
 * @param {Array<{phone?: string, stuUrl: string, title: string, requirement?: number}>} tasks
 * @param {number} concurrency 同时运行的账号数上限
 */
async function runTasks(config, tasks, concurrency = 3) {
  runtime.running = true;
  runtime.phase = 'queue';
  runtime.round = 0;
  runtime.limit = tasks.length;
  runtime.startedAt = Date.now();
  runtime.error = null;
  runtime.events = [];
  runtime.abort = new AbortController();

  const signal = runtime.abort.signal;
  const llm = new LlmClient(config);

  // 按账号分组；无 phone 的归到当前激活账号
  const fallbackPhone = activeAccount()?.phone || '';
  const groups = new Map();
  for (const t of tasks) {
    const phone = t.phone || fallbackPhone;
    if (!groups.has(phone)) groups.set(phone, { phone, queue: [], done: 0, running: false });
    groups.get(phone).queue.push(t);
  }

  const results = [];
  log.info(`队列启动：${tasks.length} 个任务 / ${groups.size} 个账号，并发上限 ${concurrency}`);

  /** 单个任务执行（用指定账号的临时浏览器）。 */
  const runOne = async (task, phone) => {
    if (signal.aborted) return;
    pushEvent({
      type: 'status', phase: 'task-start',
      round: runtime.round, limit: runtime.limit,
      message: `${task.title}${phone ? ' · ' + phone.slice(-4) : ''}`,
    });

    const session = new BrowserSession(config, { phone });
    const llmOne = new LlmClient(config);
    try {
      await session.launch({ headless: true, ephemeral: true });
      const report = await runAiTask({
        session, config, llm: llmOne, task,
        signal,
        onEvent: pushEvent,
      });
      report.phone = phone;
      results.push(report);
      runtime.round += 1;
      pushEvent({ type: 'task-done', round: runtime.round, limit: runtime.limit, report });
      // 累计用量
      llm.usage.calls += llmOne.usage.calls;
      llm.usage.promptTokens += llmOne.usage.promptTokens;
      llm.usage.completionTokens += llmOne.usage.completionTokens;
    } catch (err) {
      results.push({ title: task.title, phone, stoppedBy: 'ERROR', error: err?.message ?? String(err) });
      runtime.round += 1;
      pushEvent({ type: 'error', message: `${task.title}：${err?.message ?? err}` });
    } finally {
      await session.close();
    }
  };

  /** 一个账号的串行 worker。 */
  const runAccount = async (group) => {
    for (const task of group.queue) {
      if (signal.aborted) break;
      await runOne(task, group.phone);
      group.done += 1;
    }
  };

  try {
    const active = new Map(); // phone -> Promise
    for (;;) {
      if (signal.aborted) break;

      // 补位：还有账号没跑且有任务
      while (active.size < concurrency) {
        const next = [...groups.values()].find(
          (g) => g.done < g.queue.length && !active.has(g.phone),
        );
        if (!next) break;
        const p = runAccount(next).finally(() => {
          active.delete(next.phone);
        });
        active.set(next.phone, p);
      }

      if (!active.size) break;
      await Promise.race([...active.values()]);
    }
    await Promise.allSettled([...active.values()]);
  } finally {
    runtime.running = false;
    runtime.phase = signal.aborted ? 'idle' : 'done';
    runtime.lastReport = {
      tasks: results,
      usage: llm.usage,
      accounts: [...groups.values()].map((g) => ({
        phone: g.phone ? g.phone.slice(-4) : '',
        total: g.queue.length,
        done: g.done,
      })),
    };
    pushEvent({
      type: 'done',
      report: {
        tasks: results,
        totalRounds: results.length,
        stoppedBy: signal.aborted ? 'ABORTED' : 'ALL_DONE',
        accounts: runtime.lastReport.accounts,
      },
    });
    log.info(`队列结束：完成 ${results.length}/${tasks.length}`);
  }
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolvePromise) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolvePromise(raw ? JSON.parse(raw) : {});
      } catch {
        resolvePromise({});
      }
    });
  });
}

function listReports(config) {
  const dir = resolve(config.logDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('report-') && f.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, 30)
    .map((f) => {
      const full = join(dir, f);
      const stat = existsSync(full) ? readFileSync(full, 'utf8') : '';
      return { file: f, size: stat.length, title: (stat.split('\n')[0] ?? '').replace(/^#\s*/, '') };
    });
}

export async function startServer({ config, port = 5173 }) {
  startFileLog(config.logDir);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    try {
      /* ---------- 页面 ---------- */
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        if (!existsSync(WEBUI)) {
          res.writeHead(500).end('缺少 webui/index.html');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(readFileSync(WEBUI));
        return;
      }

      /* ---------- 状态 ---------- */
      /* ---------- 运行中拒绝占用浏览器的操作 ---------- */
      const needsBrowser = ['/api/login', '/api/send-code', '/api/detect'];
      if (runtime.running && needsBrowser.includes(url.pathname)) {
        return json(res, {
          ok: false,
          busy: true,
          error: '任务正在运行，浏览器被占用。先到「④ 任务」点停止，再来这里操作（persistent profile 同一时间只能开一个浏览器）',
        }, 409);
      }

      if (url.pathname === '/api/status') {
        const state = new RunState(resolve(config.logDir, 'state.json'));
        return json(res, {
          runtime: {
            running: runtime.running,
            phase: runtime.phase,
            round: runtime.round,
            limit: runtime.limit,
            startedAt: runtime.startedAt,
            url: runtime.url,
            error: runtime.error,
          },
          config: {
            targetUrl: config.targetUrl,
            model: config.model,
            baseUrl: config.baseUrl,
            maxRounds: config.maxRounds,
            hasApiKey: Boolean(config.apiKey),
          },
          loggedIn: runtime.loggedIn,
          loggedInAt: runtime.loggedInAt,
          account: publicAccount(),
          checkpoints: state.data,
          events: runtime.events.slice(-40),
        });
      }

      /* ---------- 课程列表（任何课程都可能含 AI 实践） ---------- */
      if (url.pathname === '/api/courses') {
        const force = url.searchParams.get('refresh') === '1';
        if (force || !runtime.courseCache || Date.now() - runtime.courseCache.at > 10 * 60_000) {
          const session = new BrowserSession(config);
          try {
            await session.launch({ headless: true, ephemeral: true });
            const courses = await session.listCourses();
            runtime.courseCache = { at: Date.now(), courses };
            log.info(`抓到 ${courses.length} 门课程`);
          } catch (err) {
            return json(res, { ok: false, error: err?.message ?? String(err) }, 200);
          } finally {
            await session.close();
          }
        }
        return json(res, { ok: true, courses: runtime.courseCache.courses, cachedAt: runtime.courseCache.at });
      }

      /* ---------- 单门课程的任务 / 章节 ---------- */
      if (url.pathname === '/api/course/detail' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.href) return json(res, { ok: false, error: '缺少课程链接' }, 400);
        const session = new BrowserSession(config);
        try {
          await session.launch({ headless: true, ephemeral: true });
          const detail = await session.courseDetail(body.href);
          return json(res, { ok: true, ...detail });
        } catch (err) {
          return json(res, { ok: false, error: err?.message ?? String(err) }, 200);
        } finally {
          await session.close();
        }
      }

      /* ---------- AI 实践任务列表（含分数） ---------- */
      if (url.pathname === '/api/ai/tasks' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.courseHref) return json(res, { ok: false, error: '缺少课程链接' }, 400);
        const probeScores = body.scores !== false; // 默认查分数
        const limit = Number.parseInt(body.limit ?? '40', 10);

        const session = new BrowserSession(config);
        try {
          await session.launch({ headless: true, ephemeral: true });
          let tasks = await session.listAiTasks(body.courseHref);
          log.info(`抓到 ${tasks.length} 个 AI 实践任务`);

          // 按截止时间过滤：过期的任务不用花 6 秒去查分数
          const now = Date.now();
          for (const t of tasks) {
            t.expired = Boolean(t.endTime && t.endTime > 0 && t.endTime < now);
          }
          const active = tasks.filter((t) => !t.expired);
          const expired = tasks.filter((t) => t.expired);
          for (const t of expired) {
            t.done = true;          // 过期的不做，前端按「已结束」展示
            t.expiredNote = true;
          }
          log.info(`AI 任务：进行中 ${active.length} / 过期 ${expired.length}`);

          if (probeScores) {
            const target = active.slice(0, limit);
            for (let i = 0; i < target.length; i += 1) {
              const t = target[i];
              if (!t.stuUrl) continue;
              try {
                const info = await session.aiTaskInfo(t.stuUrl);
                Object.assign(t, {
                  score: info.score,
                  attempts: info.attempts,
                  requirement: info.requirement,
                  scenario: info.scenario,
                  hasStartBtn: info.hasStartBtn,
                  probed: true,
                });
                // 已达标 → 不用做
                t.done = info.score !== null && info.score >= (info.requirement || 80);
              } catch (err) {
                t.probeError = err.message;
              }
              pushEvent({
                type: 'progress',
                phase: 'skill-scan',
                round: i + 1,
                limit: target.length,
                message: `扫描 ${t.title}`,
              });
            }
          }

          runtime.aiTaskCache = { at: Date.now(), course: body.courseHref, tasks };
          return json(res, { ok: true, tasks });
        } catch (err) {
          return json(res, { ok: false, error: err?.message ?? String(err) }, 200);
        } finally {
          await session.close();
        }
      }

      /* 登录态检测单独一个接口：会起一次浏览器，所以只在用户点按钮时调 */
      /* ---------- 查单个任务的分数（手动扫描用） ---------- */
      if (url.pathname === '/api/ai/task-score' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.stuUrl) return json(res, { ok: false, error: '缺少任务链接' }, 400);
        const session = new BrowserSession(config);
        try {
          await session.launch({ headless: true, ephemeral: true });
          const info = await session.aiTaskInfo(body.stuUrl);
          const req2 = info.requirement || 80;
          return json(res, {
            ok: true,
            score: info.score,
            attempts: info.attempts,
            requirement: req2,
            done: info.score !== null && info.score >= req2,
          });
        } catch (err) {
          return json(res, { ok: false, error: err?.message ?? String(err) }, 200);
        } finally {
          await session.close();
        }
      }

      /* ---------- 跑单个 AI 实践任务 ---------- */
      if (url.pathname === '/api/run-task' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.stuUrl) return json(res, { ok: false, error: '缺少任务链接' }, 400);
        if (runtime.running) return json(res, { ok: false, error: '已有任务在跑' }, 409);
        runTasks(config, [{
          stuUrl: body.stuUrl,
          title: body.title || '任务',
          requirement: body.requirement,
          phone: body.phone || '',
        }]).catch(() => {});
        return json(res, { ok: true, started: true });
      }

      /* ---------- 批量跑所有未达标任务 ---------- */
      if (url.pathname === '/api/run-todo' && req.method === 'POST') {
        const body = await readBody(req);
        const tasks = (Array.isArray(body.tasks) ? body.tasks : []).map((t) => ({
          ...t,
          phone: t.phone || body.phone || '',
        }));
        if (!tasks.length) return json(res, { ok: false, error: '没有待做的任务' }, 400);
        if (runtime.running) return json(res, { ok: false, error: '已有任务在跑' }, 409);
        runTasks(config, tasks).catch(() => {});
        return json(res, { ok: true, started: true, count: tasks.length });
      }

      /* ---------- 账号池 ---------- */
      if (url.pathname === '/api/accounts') {
        return json(res, { ok: true, ...allAccounts(), model: config.model });
      }

      if (url.pathname === '/api/accounts/switch' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          setActiveAccount(body.phone);
          // 切号后清掉运行态里的登录标记，避免 UI 显示旧账号
          runtime.loggedIn = null;
          runtime.loggedInAt = null;
          return json(res, { ok: true, account: publicAccount() });
        } catch (err) {
          return json(res, { ok: false, error: err.message }, 200);
        }
      }

      if (url.pathname === '/api/accounts/delete' && req.method === 'POST') {
        const body = await readBody(req);
        removeAccount(body.phone);
        return json(res, { ok: true, ...allAccounts() });
      }

      /* ---------- 账号档案 ---------- */
      if (url.pathname === '/api/account') {
        return json(res, { ok: true, account: publicAccount() });
      }

      if (url.pathname === '/api/account/refresh' && req.method === 'POST') {
        const session = new BrowserSession(config);
        try {
          await session.launch({ headless: true, ephemeral: true });
          const user = await session.fetchUserInfo();
          if (!user || (!user.name && !user.uid)) {
            return json(res, { ok: false, error: '没取到账号信息，可能登录已失效' }, 200);
          }
          const acc = saveAccount({ ...user, phone: config.phone });
          runtime.loggedIn = true;
          runtime.loggedInAt = Date.now();
          return json(res, { ok: true, account: publicAccount(), raw: acc.name });
        } catch (err) {
          return json(res, { ok: false, error: err?.message ?? String(err) }, 200);
        } finally {
          await session.close();
        }
      }

      if (url.pathname === '/api/logout' && req.method === 'POST') {
        const session = new BrowserSession(config);
        try {
          await session.launch({ headless: true });
          await session.clearSession();
          clearAccount();
          runtime.loggedIn = false;
          runtime.loggedInAt = Date.now();
          log.info('已登出并清除登录态');
          return json(res, { ok: true });
        } catch (err) {
          return json(res, { ok: false, error: err?.message ?? String(err) }, 200);
        } finally {
          await session.close();
        }
      }

      /* ---------- 评分反馈学习库 ---------- */
      if (url.pathname === '/api/feedback') {
        const title = url.searchParams.get('title');
        if (title) return json(res, { ok: true, records: feedbackOf(title) });
        return json(res, { ok: true, items: allFeedback() });
      }

      /* ---------- 多账号任务队列（排队刷） ---------- */
      if (url.pathname === '/api/run-queue' && req.method === 'POST') {
        const body = await readBody(req);
        const items = Array.isArray(body.items) ? body.items : [];
        const flat = [];
        for (const it of items) {
          const phone = it.phone || '';
          for (const t of it.tasks || []) {
            if (t?.stuUrl) flat.push({ ...t, phone });
          }
        }
        if (!flat.length) return json(res, { ok: false, error: '队列为空' }, 400);
        if (runtime.running) return json(res, { ok: false, error: '已有任务在跑' }, 409);
        runTasks(config, flat).catch(() => {});
        return json(res, { ok: true, started: true, count: flat.length, accounts: items.length });
      }

      /* ---------- 批量刷多门课程 ---------- */
      if (url.pathname === '/api/run-courses' && req.method === 'POST') {
        const body = await readBody(req);
        const courses = (Array.isArray(body.courses) ? body.courses : [])
          .filter((c) => c && c.href)
          .map((c) => ({ ...c, phone: c.phone || body.phone || '' }));
        if (!courses.length) return json(res, { ok: false, error: '没有选中课程' }, 400);
        if (runtime.running) return json(res, { ok: false, error: '已有任务在跑' }, 409);
        runCourses(config, courses).catch(() => {});
        return json(res, { ok: true, started: true, count: courses.length });
      }

      if (url.pathname === '/api/check-login') {
        const session = new BrowserSession(config);
        let loggedIn = null;
        try {
          await session.launch({ headless: true, ephemeral: true });
          loggedIn = await session.isLoggedIn();
        } catch (err) {
          runtime.error = `检测登录态失败：${err.message}`;
        } finally {
          await session.close();
        }
        runtime.loggedIn = loggedIn;
        runtime.loggedInAt = Date.now();
        return json(res, { loggedIn, checkedAt: runtime.loggedInAt });
      }

      if (url.pathname === '/api/logs') {
        return json(res, { logs: getRing().slice(-200) });
      }

      /* ---------- 配置读写 ---------- */
      if (url.pathname === '/api/config' && req.method === 'GET') {
        return json(res, { config: publicConfig(config) });
      }

      if (url.pathname === '/api/config' && req.method === 'POST') {
        const body = await readBody(req);
        const envPatch = applyPatch(config, body);
        const where = saveEnv(envPatch);
        log.info(`配置已保存（${Object.keys(envPatch).join(', ')}）`);
        return json(res, { ok: true, path: where, config: publicConfig(config) });
      }

      /* ---------- 测接口 ---------- */
      if (url.pathname === '/api/test-llm' && req.method === 'POST') {
        const body = await readBody(req);
        if (body?.baseUrl || body?.apiKey || body?.model) {
          applyPatch(config, {
            ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
            ...(body.apiKey ? { apiKey: body.apiKey } : {}),
            ...(body.model ? { model: body.model } : {}),
          });
        }
        try {
          const llm = new LlmClient(config);
          const result = await llm.test();
          return json(res, { ok: true, ...result });
        } catch (err) {
          return json(res, { ok: false, error: err?.message ?? String(err) }, 200);
        }
      }

      /* ---------- 登录 ---------- */
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const body = await readBody(req);
        const phone = body.phone || config.phone;
        const password = body.password || config.password;
        if (!phone || !password) {
          return json(res, { ok: false, error: '请填写手机号和学习通密码' }, 400);
        }
        // 勾选"记住"才落盘，避免把密码写进 .env 却不想留
        if (body.remember) {
          applyPatch(config, { phone, password });
          saveEnv({ CXAI_PHONE: phone, CXAI_PASSWORD: password });
        }
        const session = new BrowserSession(config);
        try {
          await session.launch({ headless: true });
          const result = await session.loginWithPassword({ phone, password });
          runtime.loggedIn = result.ok;
          runtime.loggedInAt = Date.now();
          if (result.ok) {
            upsertAccount({
              phone,
              password: body.remember ? password : undefined,
              ...(result.user || {}),
            });
            setActiveAccount(phone);
            log.info(`Web 端登录成功：${result.user?.name || phone}`);
          }
          else log.warn(`Web 端登录失败：${result.reason}`);
          return json(res, { ...result, loggedIn: result.ok });
        } catch (err) {
          return json(res, { ok: false, error: err?.message ?? String(err) }, 200);
        } finally {
          await session.close();
        }
      }

      /* ---------- 短信验证码登录（两步） ---------- */
      if (url.pathname === '/api/send-code' && req.method === 'POST') {
        const body = await readBody(req);
        const phone = String(body.phone || '').trim();
        if (!/^1\d{10}$/.test(phone)) {
          return json(res, { ok: false, error: '手机号格式不对（需要 11 位）' }, 400);
        }
        if (runtime.running) {
          return json(res, { ok: false, error: '任务运行中，先停止再登录' }, 409);
        }

        await closeSmsLogin();

        const session = new BrowserSession(config);
        try {
          await session.launch({ headless: true });
          const result = await session.openSmsLogin(phone);
          if (!result.ok) {
            await session.close();
            return json(res, { ok: false, error: result.reason }, 200);
          }

          smsLogin = {
            session,
            phone,
            at: Date.now(),
            // 5 分钟没填验证码就自动关，别占着 profile
            timer: setTimeout(() => {
              closeSmsLogin().catch(() => {});
            }, 5 * 60_000),
          };
          smsLogin.timer.unref?.();

          log.info(`已向 ${phone.replace(/^(\d{3})\d+(\d{4})$/, '$1****$2')} 请求验证码`);
          return json(res, {
            ok: true,
            btnText: result.btnText,
            needCaptcha: result.needCaptcha,
            hint: result.hint,
            expiresInSec: 300,
          });
        } catch (err) {
          await session.close().catch(() => {});
          return json(res, { ok: false, error: err?.message ?? String(err) }, 200);
        }
      }

      if (url.pathname === '/api/login-code' && req.method === 'POST') {
        const body = await readBody(req);
        const code = String(body.code || '').trim();
        if (!/^\d{4,8}$/.test(code)) {
          return json(res, { ok: false, error: '验证码应为 4-8 位数字' }, 400);
        }
        if (!smsLogin) {
          return json(res, { ok: false, error: '登录会话已过期，请重新获取验证码' }, 400);
        }

        try {
          const result = await smsLogin.session.submitSmsCode({ code });
          runtime.loggedIn = result.ok;
          runtime.loggedInAt = Date.now();

          if (result.ok) {
            if (result.user) saveAccount({ ...result.user, phone: smsLogin.phone });
            if (body.remember) {
              applyPatch(config, { phone: smsLogin.phone });
              saveEnv({ CXAI_PHONE: smsLogin.phone });
            }
            log.info('验证码登录成功');
            await closeSmsLogin();
            return json(res, { ok: true, loggedIn: true });
          }

          log.warn(`验证码登录失败：${result.reason}`);
          // 保留会话，让用户还能重填一次
          return json(res, { ok: false, error: result.reason }, 200);
        } catch (err) {
          await closeSmsLogin();
          return json(res, { ok: false, error: err?.message ?? String(err) }, 200);
        }
      }

      /* ---------- 探测（只诊断，不作答） ---------- */
      if (url.pathname === '/api/detect' && req.method === 'POST') {
        const body = await readBody(req);
        const target = body.url || config.targetUrl;
        if (body.url) {
          applyPatch(config, { targetUrl: body.url });
          saveEnv({ CXAI_TARGET_URL: body.url });
        }
        const session = new BrowserSession(config);
        try {
          await session.launch({ headless: true, ephemeral: true });
          await session.goto(target);
          const found = await session.findChatFrame({ timeoutMs: 20_000 });
          if (!found) {
            return json(res, {
              ok: false,
              loggedIn: await session.isLoggedIn(),
              error: '没有探测到 AI 实践对话窗口（检查 URL 是否带 courseId，或该节点不是情景对话）',
            });
          }
          const tail = await session.rpc(found.frame, 'tail', 4);
          return json(res, {
            ok: true,
            summary: found.summary,
            frameUrl: found.url,
            recent: tail?.ok ? tail.items : [],
          });
        } catch (err) {
          return json(res, { ok: false, error: err?.message ?? String(err) }, 200);
        } finally {
          await session.close();
        }
      }

      if (url.pathname === '/api/reports') {
        return json(res, { reports: listReports(config) });
      }

      if (url.pathname === '/api/report') {
        const file = url.searchParams.get('f') ?? '';
        if (!/^report-[\w.-]+\.md$/.test(file)) return json(res, { error: '非法文件名' }, 400);
        const full = join(resolve(config.logDir), file);
        if (!existsSync(full)) return json(res, { error: '文件不存在' }, 404);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(readFileSync(full));
        return;
      }

      /* ---------- 启停 ---------- */
      if (req.method === 'POST' && url.pathname === '/api/start') {
        const body = await readBody(req);
        if (runtime.running) return json(res, { error: '已有任务在跑' }, 409);
        startTask(config, body).catch(() => {});
        return json(res, { ok: true, started: true });
      }

      if (req.method === 'POST' && url.pathname === '/api/stop') {
        if (!runtime.running) return json(res, { ok: true, alreadyStopped: true });
        runtime.abort?.abort();
        return json(res, { ok: true, stopping: true });
      }

      if (req.method === 'POST' && url.pathname === '/api/reset') {
        const body = await readBody(req);
        const state = new RunState(resolve(config.logDir, 'state.json'));
        state.clear(body.url);
        return json(res, { ok: true });
      }

      json(res, { error: 'not found' }, 404);
    } catch (err) {
      json(res, { error: err?.message ?? String(err) }, 500);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    log.info(`Web 控制台 http://127.0.0.1:${port}`);
    console.log(`\n控制台已启动：http://127.0.0.1:${port}\n（手机同一局域网可用 http://<本机IP>:${port}，需把监听地址改成 0.0.0.0）\n`);
  });

  return server;
}
