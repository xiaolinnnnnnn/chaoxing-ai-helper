/**
 * Mock E2E —— 不依赖学习通账号，验证「页内 agent + Node 编排器」的完整链路。
 *
 * 做法（对齐 cidaren-ultimate 的 mock_server 思路）：
 * 1. 本地起 HTTP 服务，serve 一个按真实学习通 DOM 结构复刻的 fixture；
 * 2. Playwright 打开它，注入真实的 agent bundle；
 * 3. 用**假 LLM** 替掉 DeepSeek，只验证 DOM 交互与轮次编排；
 * 4. 断言：探测成功 / 读到提问 / 写入发送成功 / 等到流式回复 / 轮次推进 / 收尾判定。
 *
 * 运行：node test/mock-e2e.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { runDialogue } from '../src/runner.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const AGENT = resolve(ROOT, 'dist/agent.js');

let pass = 0;
let fail = 0;

function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function serveFixture() {
  const html = readFileSync(resolve(HERE, 'fixture/site.html'));
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => resolvePromise({ server, port: server.address().port }));
  });
}

/** 假 LLM：固定回复，不联网。 */
function makeFakeLlm() {
  return {
    usage: { calls: 0, promptTokens: 0, completionTokens: 0 },
    replies: [],
    async chat({ user }) {
      this.usage.calls += 1;
      const n = this.usage.calls;
      const text = `第${n}轮作答：我是初级分析师，会先梳理需求再按里程碑推进，遇到风险及时同步团队。`;
      this.replies.push({ user, text });
      return text;
    },
  };
}

async function main() {
  if (!existsSync(AGENT)) {
    console.error('缺少 dist/agent.js，先运行 node esbuild.agent.mjs');
    process.exit(1);
  }

  const { server, port } = await serveFixture();
  const url = `http://127.0.0.1:${port}/`;
  const agentSource = readFileSync(AGENT, 'utf8');

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  await context.addInitScript({ content: agentSource });
  const page = await context.newPage();

  try {
    console.log(`\n[1] 加载 fixture ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    /* ---------- agent 是否存在 ---------- */
    console.log('\n[2] 页内 agent 注入');
    const hasAgent = await page.evaluate(() => typeof window.__CXAI === 'object');
    check('window.__CXAI 已注入', hasAgent);

    /* ---------- 探测 ---------- */
    console.log('\n[3] 对话窗口探测');
    const detected = await page.evaluate(() => window.__CXAI.detect());
    check('detect() 成功', detected?.ok === true, JSON.stringify(detected?.error));
    check('识别到 1 条消息', detected?.messageCount === 1, `实际 ${detected?.messageCount}`);
    check('输入框可用', detected?.inputLocked === false);
    check('命中发送按钮', detected?.hasSendBtn === true);

    /* ---------- 读提问 ---------- */
    console.log('\n[4] 读取待答问题');
    const pending = await page.evaluate(() => window.__CXAI.pendingQuestion());
    check('取到 AI 提问', pending?.ok && pending.side === 'ai', pending?.side);
    check(
      '提问内容正确',
      (pending?.text || '').includes('介绍一下你自己'),
      pending?.text?.slice(0, 60),
    );
    // 关键：只取 .agentAnswer 正文，不能把 .agentName（发言人名）拼进来。
    // 判据：文本不应以「测评专家」开头（fixture 正文里天然含这四个字，故不能直接 includes）
    check(
      '未混入发言人名（非 .agent 整条文本）',
      !(pending?.text || '').trimStart().startsWith('测评专家'),
      pending?.text?.slice(0, 40),
    );

    /* ---------- 页面背景资料 ---------- */
    console.log('\n[5] 页面背景资料提取');
    const ctxRes = await page.evaluate(() => window.__CXAI.pageContext());
    check('背景资料非空', ctxRes?.ok && ctxRes.text.length > 0);
    check('不重复喂对话正文', !ctxRes.text.includes('测评专家'));

    /* ---------- 写入 + 发送 ---------- */
    console.log('\n[6] 写入并发送');
    const answerText = '我是初级分析师，负责数据梳理与结论输出。';
    const sent = await page.evaluate((t) => window.__CXAI.answer(t), answerText);
    check('answer() 成功', sent?.ok === true, JSON.stringify(sent?.error));

    const afterSend = await page.evaluate(() => window.__CXAI.tail(6));
    const userMsg = afterSend?.items?.find((i) => i.side === 'user');
    check('消息里出现我方作答', Boolean(userMsg), JSON.stringify(afterSend?.items));
    check('我方文本一致', userMsg?.text === answerText, userMsg?.text);

    /* ---------- 等回复 ---------- */
    console.log('\n[7] 等待流式回复稳定');
    const reply = await page.evaluate(
      (t) => window.__CXAI.waitReply(t, 30000),
      answerText,
    );
    check('waitReply() 成功', reply?.ok === true, JSON.stringify(reply?.error));
    check('回复长度合理', (reply?.text || '').length > 6, `${reply?.text?.length} 字`);
    check(
      '回复不是流式中间态（含完整句读）',
      /[。？！]$/.test((reply?.text || '').trim()) || (reply?.text || '').length > 15,
      reply?.text,
    );

    /* ---------- 端到端跑编排器 ---------- */
    console.log('\n[8] 编排器端到端（假 LLM，跑 2 轮）');
    const config = {
      systemPrompt: 'test',
      maxRounds: 2,
      roundIntervalMs: 100,
      replyTimeoutMs: 30000,
      questionTimeoutMs: 30000,
      detectTimeoutMs: 15000,
      taskTimeoutMs: 120000,
      resume: false,
      logDir: resolve(ROOT, 'logs/test'),
      userDataDir: resolve(ROOT, '.profile-test'),
      headless: true,
      model: 'fake',
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'test',
      targetUrl: url,
    };

    // 复用同一个 page，构造最小 session 桩
    const frame = page.mainFrame();
    const sessionStub = {
      session: null,
      isLoginPage: () => false,
      screenshot: async () => null,
      findChatFrame: async () => ({ frame, summary: detected, url }),
      rpc: (f, method, ...args) =>
        f.evaluate(
          async ({ m, a }) => {
            const api = window.__CXAI;
            return api[m](...a);
          },
          { m: method, a: args },
        ),
    };

    const llm = makeFakeLlm();
    const events = [];
    const report = await runDialogue({
      session: sessionStub,
      config,
      llm,
      onEvent: (e) => events.push(e),
      maxRounds: 2,
    });

    check('报告完成 2 轮', report.totalRounds === 2, `实际 ${report.totalRounds}`);
    check('结束原因是轮数上限', report.stoppedBy === 'MAX_ROUNDS', report.stoppedBy);
    check('每轮都有问答记录', report.rounds.length === 2 && report.rounds.every((r) => r.question && r.answer));
    check('LLM 被调用 2 次', llm.usage.calls === 2, `实际 ${llm.usage.calls}`);
    check('轮次事件已推送', events.filter((e) => e.type === 'round').length === 2);
    check(
      '第 2 轮问题确实换了',
      report.rounds[0].question !== report.rounds[1].question,
      report.rounds.map((r) => r.question.slice(0, 20)).join(' | '),
    );

    /* ---------- 收尾判定 ---------- */
    console.log('\n[9] AI 收尾语判定');
    const endingDetected = await page.evaluate(async () => {
      // 等到 mock 打出最后一条收尾语
      for (let i = 0; i < 40; i += 1) {
        const p = window.__CXAI.pendingQuestion();
        if (p?.ok && p.looksLikeEnding) return { ok: true, text: p.text };
        await new Promise((r) => setTimeout(r, 300));
      }
      return { ok: false };
    });
    check('识别到收尾语', endingDetected.ok === true, JSON.stringify(endingDetected).slice(0, 120));
  } finally {
    await context.close();
    await browser.close();
    server.close();
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('\n测试异常：', err);
  process.exitCode = 1;
});
