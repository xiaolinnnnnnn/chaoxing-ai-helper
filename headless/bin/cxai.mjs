#!/usr/bin/env node
/**
 * cxai —— 学习通 AI 实践无头引擎 CLI。
 *
 * 与 cidaren-ultimate 一样的双入口模式：CLI 为主，`serve` 起 Web 控制台。
 *
 *   cxai login     首次登录（唯一需要打开浏览器的步骤）
 *   cxai test      模型连通性测试
 *   cxai once      只跑一轮（先验证效果）
 *   cxai run       跑到轮数上限 / AI 收尾
 *   cxai status    看断点与登录态
 *   cxai reset     清断点
 *   cxai serve     Web 控制台
 */
import { readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { loadConfig, validateConfig, ROOT } from '../src/config.mjs';
import { LlmClient } from '../src/llm.mjs';
import { BrowserSession, LOGIN_URL } from '../src/session.mjs';
import { runDialogue, RunState } from '../src/runner.mjs';
import { writeReport, renderReport } from '../src/report.mjs';
import { createLogger, startFileLog, setQuiet, getRing } from '../src/logger.mjs';

const log = createLogger('cli');

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
学习通 AI 实践 · 无头引擎

用法：cxai <命令> [选项]

命令：
  login                登录学习通并保存登录态
                       · 在 .env 填了 CXAI_PHONE / CXAI_PASSWORD → 全程无头自动登录
                       · 没填 → 打开浏览器人工登录一次（账号密码或扫码）
  test                 测试模型接口连通性
  once                 只跑一轮（建议第一次先跑这个）
  run                  跑到轮数上限或 AI 收尾
  status               查看登录态与断点
  reset                清空断点（当前页面 / 全部）
  serve                启动 Web 控制台（默认 http://127.0.0.1:5173）

选项：
  --url <URL>          覆盖 CXAI_TARGET_URL
  --rounds <N>         覆盖本轮上限
  --model <NAME>       覆盖模型
  --phone <号码>       账号密码自动登录用
  --password <密码>    账号密码自动登录用
  --no-fallback        自动登录失败时不要转人工
  --headed             有头运行（看得见浏览器，排障用）
  --no-resume          忽略断点，从第 1 轮开始
  --predict            只探测对话框结构，不作答（验证选择器是否还有效）
  --port <N>           serve 端口
  --help               显示帮助

配置文件：${resolve(ROOT, '.env')}   （复制 .env.example 改名即可）
`);
}

/* ------------------------------------------------------------------ */
/* 命令                                                                */
/* ------------------------------------------------------------------ */

async function cmdLogin(config, args) {
  const phone = args.phone || config.phone;
  const password = args.password || config.password;
  const forceManual = args['no-auto'] === true;

  // 给了账号密码 → 先试无头自动登录（不打开任何窗口）
  if (phone && password && !forceManual) {
    const session = new BrowserSession(config);
    try {
      console.log(`自动登录：${phone.replace(/^(\d{3})\d+(\d{4})$/, '$1****$2')}`);
      await session.launch({ headless: true });
      const result = await session.loginWithPassword({ phone, password });

      if (result.ok) {
        console.log('✓ 登录成功，登录态已保存到 profile');
        await session.close();
        return;
      }

      console.log(`✗ 自动登录失败：${result.reason}`);
      if (result.hint) console.log(`  ${result.hint}`);
      await session.close();

      if (args['no-fallback']) {
        process.exitCode = 1;
        return;
      }
      console.log('\n改为有头模式，人工登录一次…\n');
    } finally {
      await session.close();
    }
  }

  // 有头人工登录（账号密码 / 扫码都行）
  // 注意：无图形环境（proot / 容器 / 服务器）起不了有头浏览器，必须走账号密码
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.error('\n✗ 当前环境没有图形界面（DISPLAY 未设置），打不开有头浏览器。');
    console.error('  改用账号密码自动登录：');
    console.error('    1) 在 .env 填 CXAI_PHONE / CXAI_PASSWORD，然后 node bin/cxai.mjs login');
    console.error('    2) 或者直接：node bin/cxai.mjs login --phone 手机号 --password 密码');
    console.error('  也可以在有桌面的电脑登录后，把 storage-state.json 拷过来配 CXAI_STORAGE_STATE。\n');
    process.exitCode = 1;
    return;
  }

  const session = new BrowserSession(config);
  try {
    await session.launch({ headless: false });
    const page = await session.goto(LOGIN_URL);
    console.log('\n──────────────────────────────────────────────');
    console.log(' 浏览器已打开，请在里面完成学习通登录。');
    console.log(' （账号密码或手机 App 扫码都行）');
    console.log(' 登录成功后回到这里按「回车」保存登录态。');
    console.log('──────────────────────────────────────────────\n');

    const rl = createInterface({ input: stdin, output: stdout });
    await rl.question('登录完成后按回车…');
    rl.close();

    const loggedIn = await session.isLoggedIn();
    console.log(loggedIn ? '✓ 登录态已保存' : '⚠ 没检测到登录 cookie，可能没登录成功');
    if (loggedIn) {
      try {
        await session.context.storageState({ path: resolve(ROOT, 'storage-state.json') });
        console.log(`✓ 已导出 cookies → ${resolve(ROOT, 'storage-state.json')}（可拷到别的机器用）`);
      } catch {
        /* 导出失败不影响 persistent profile */
      }
    }
    void page;
  } finally {
    await session.close();
  }
}

async function cmdTest(config) {
  const issues = validateConfig(config);
  if (issues.length) {
    console.error('配置有问题：\n  ' + issues.join('\n  '));
    process.exitCode = 1;
    return;
  }
  const llm = new LlmClient(config);
  console.log(`测试 ${config.baseUrl} · 模型 ${config.model} …`);
  const result = await llm.test();
  console.log(`✓ 连通 ${result.latencyMs}ms · 回复「${result.reply}」`);
  if (result.models.length) console.log(`可用模型：${result.models.slice(0, 12).join(', ')}`);
}

async function cmdRun(config, args, once) {
  const issues = validateConfig(config);
  if (issues.length) {
    console.error('配置有问题：\n  ' + issues.join('\n  '));
    process.exitCode = 1;
    return;
  }

  const targetUrl = args.url || config.targetUrl;
  if (args.model) config.model = args.model;
  if (args.headed) config.headless = false;
  if (args['no-resume']) config.resume = false;
  if (args.rounds) config.maxRounds = Number.parseInt(args.rounds, 10);

  const llm = new LlmClient(config);
  const session = new BrowserSession(config);

  const onEvent = (event) => {
    if (event.type === 'status') {
      const tail = event.round ? ` ${event.round}/${event.limit}` : '';
      process.stdout.write(`\r[${event.phase}]${tail}                    `);
    } else if (event.type === 'round') {
      process.stdout.write(`\r第 ${event.round} 轮完成，AI 回复 ${event.reply.length} 字\n`);
    }
  };

  try {
    await session.launch();
    await session.goto(targetUrl);

    if (args.predict) {
      const found = await session.findChatFrame();
      if (!found) {
        console.error('✗ 没有探测到对话窗口');
        process.exitCode = 1;
        return;
      }
      console.log('\n探测结果：');
      console.log(JSON.stringify(found.summary, null, 2));
      const tail = await session.rpc(found.frame, 'tail', 6);
      if (tail?.ok) {
        console.log('\n最近消息：');
        for (const item of tail.items) console.log(`  [${item.side}] ${item.text.slice(0, 80)}`);
      }
      return;
    }

    const report = await runDialogue({ session, config, llm, onEvent, once, maxRounds: config.maxRounds });
    const path = writeReport(report, config);
    console.log('\n' + renderReport(report, config));
    console.log(`\n报告：${path}`);
    console.log(`日志：${getLogFileHint()}`);
    if (report.stoppedBy === 'NO_CHAT_WINDOW') process.exitCode = 2;
  } finally {
    await session.close();
  }
}

function getLogFileHint() {
  try {
    const dir = resolve(loadConfig().logDir);
    if (!existsSync(dir)) return '(无)';
    const files = readdirSync(dir).filter((f) => f.endsWith('.log')).sort();
    return files.length ? resolve(dir, files.at(-1)) : '(无)';
  } catch {
    return '(无)';
  }
}

async function cmdStatus(config) {
  const session = new BrowserSession(config);
  let loggedIn = false;
  try {
    await session.launch({ headless: true });
    loggedIn = await session.isLoggedIn();
  } catch (err) {
    console.log(`浏览器启动失败：${err.message}`);
  } finally {
    await session.close();
  }

  const state = new RunState(resolve(config.logDir, 'state.json'));
  console.log('\n运行状态');
  console.log('─'.repeat(50));
  console.log(`登录态      ${loggedIn ? '✓ 有效' : '✗ 未登录 / 已过期'}`);
  console.log(`Profile     ${config.userDataDir}`);
  console.log(`目标页面    ${config.targetUrl}`);
  console.log(`模型        ${config.model} @ ${config.baseUrl}`);
  console.log(`轮数上限    ${config.maxRounds}`);
  console.log(`无头模式    ${config.headless ? '是' : '否'}`);
  console.log('\n断点记录');
  console.log('─'.repeat(50));
  const keys = Object.keys(state.data);
  if (!keys.length) console.log('(无)');
  for (const key of keys) {
    const v = state.data[key];
    console.log(`${key}\n  已完成 ${v.round} 轮 · 更新于 ${new Date(v.updatedAt ?? 0).toLocaleString('zh-CN')}`);
  }
}

async function cmdReset(config, args) {
  const state = new RunState(resolve(config.logDir, 'state.json'));
  if (args.url) {
    state.clear(args.url);
    console.log(`已清空：${args.url}`);
  } else {
    state.clear();
    console.log('已清空全部断点');
  }
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const command = args._[0] ?? 'help';

  if (command === 'help' || args.help) {
    printHelp();
    return;
  }

  const config = loadConfig();
  startFileLog(config.logDir);

  switch (command) {
    case 'login':
      await cmdLogin(config, args);
      break;
    case 'test':
      await cmdTest(config);
      break;
    case 'once':
      await cmdRun(config, args, true);
      break;
    case 'run':
      await cmdRun(config, args, false);
      break;
    case 'status':
      await cmdStatus(config);
      break;
    case 'reset':
      await cmdReset(config, args);
      break;
    case 'serve': {
      const { startServer } = await import('../src/server.mjs');
      await startServer({ config, port: Number.parseInt(args.port ?? '5173', 10) });
      break;
    }
    default:
      console.error(`未知命令：${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  setQuiet(false);
  log.error(err?.stack ?? String(err));
  process.exitCode = 1;
});

export { parseArgs, getRing };
