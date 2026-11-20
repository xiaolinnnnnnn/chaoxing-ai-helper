/**
 * 任务编排器 —— 状态机的 Node 版。
 *
 * 对应扩展里 `content/state-machine.ts` + `content/index.tsx` 的驱动循环，
 * 但把「浏览器生命周期」换成 Playwright、把「chrome.storage」换成 JSON 文件。
 *
 * 相对扩展额外补齐的健壮性（参考 cidaren-ultimate 的 runner）：
 * - **整体超时保护**：任务级 deadline，永不无限挂起；
 * - **卡住检测**：连续 `stuckLimit` 轮拿到同一个问题签名 → 放弃并说明原因；
 * - **断点恢复**：轮次与签名落盘，进程被杀后 `--resume` 接着跑；
 * - **单轮隔离**：某轮 LLM 失败/发送失败不毁掉整任务，可按策略重试或跳过。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createLogger } from './logger.mjs';
import { feedbackHints, recordFeedback } from './feedback.mjs';

const log = createLogger('runner');

/** 每轮间隔抖动比例（±30%），避免固定节奏。 */
const JITTER = 0.3;

function sleep(ms, signal) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolvePromise, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/** 稳定但带抖动的间隔。 */
function jittered(ms) {
  const delta = ms * JITTER;
  return Math.max(0, Math.round(ms - delta + Math.random() * delta * 2));
}

/* ------------------------------------------------------------------ */
/* 断点状态                                                            */
/* ------------------------------------------------------------------ */

export class RunState {
  constructor(file) {
    this.file = file;
    this.data = {};
    mkdirSync(resolve(file, '..'), { recursive: true });
    if (existsSync(file)) {
      try {
        this.data = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        this.data = {};
      }
    }
  }

  /** 按页面 URL 分桶（同一门课的多个节点互不干扰）。 */
  static key(url) {
    try {
      const u = new URL(url);
      const courseId = u.searchParams.get('courseId') ?? '';
      const chapterId = u.searchParams.get('chapterId') ?? u.searchParams.get('knowledgeId') ?? '';
      return `${u.pathname}?courseId=${courseId}&chapterId=${chapterId}`;
    } catch {
      return url;
    }
  }

  get(url) {
    return this.data[RunState.key(url)] ?? { round: 0, lastSignature: null };
  }

  set(url, patch) {
    const key = RunState.key(url);
    this.data[key] = { ...(this.data[key] ?? {}), ...patch, updatedAt: Date.now() };
    this.flush();
  }

  clear(url) {
    if (url) delete this.data[RunState.key(url)];
    else this.data = {};
    this.flush();
  }

  flush() {
    try {
      writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      log.warn(`断点写入失败：${err.message}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 主循环                                                              */
/* ------------------------------------------------------------------ */

/**
 * 跑完一个页面的对话任务。
 *
 * @param {object} args
 * @param {import('./session.mjs').BrowserSession} args.session
 * @param {object} args.config
 * @param {import('./llm.mjs').LlmClient} args.llm
 * @param {AbortSignal} [args.signal]
 * @param {(event: object) => void} [args.onEvent] 事件回调（Web 控制台 / CLI 进度条）
 * @param {boolean} [args.once] 只跑一轮
 * @param {number} [args.maxRounds] 覆盖配置里的轮数上限
 * @returns {Promise<object>} 运行报告
 */
export async function runDialogue({ session, config, llm, signal, onEvent, once = false, maxRounds }) {
  const emit = onEvent ?? (() => {});
  const state = new RunState(resolve(config.logDir, 'state.json'));
  const limit = once ? 1 : maxRounds ?? config.maxRounds;
  const startedAt = Date.now();
  const deadline = startedAt + config.taskTimeoutMs;

  const report = {
    startedAt,
    finishedAt: null,
    url: '',
    rounds: [],
    totalRounds: 0,
    stoppedBy: '',
    usage: null,
    error: null,
    pageContext: '',
  };

  emit({ type: 'status', phase: 'detecting', message: '正在定位对话窗口' });

  const found = await session.findChatFrame({ timeoutMs: config.detectTimeoutMs });
  if (!found) {
    report.stoppedBy = 'NO_CHAT_WINDOW';
    report.error = session.isLoginPage()
      ? '停在登录页：登录态失效，先跑 `node bin/cxai.mjs login` 重新登录'
      : '没有找到 AI 实践对话窗口：确认目标 URL 是 taskChain/student/answer 页面，且该节点是「情景对话」';
    report.finishedAt = Date.now();
    emit({ type: 'error', message: report.error });
    return report;
  }

  let { frame, url } = found;
  report.url = url;

  const persisted = config.resume ? state.get(url) : { round: 0, lastSignature: null };
  let round = persisted.round ?? 0;
  let lastSignature = persisted.lastSignature ?? null;
  let stuck = 0;
  let stuckSignature = null;

  log.info(`对话窗口就绪，起始轮次 ${round}/${limit}（resume=${config.resume}）`);
  emit({ type: 'status', phase: 'running', round, limit, url });

  // 整任务的 abort 与外部 signal 联动
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const abortSignal = controller.signal;

  try {
    while (round < limit) {
      if (abortSignal.aborted) {
        report.stoppedBy = 'ABORTED';
        break;
      }
      if (Date.now() > deadline) {
        report.stoppedBy = 'TASK_TIMEOUT';
        report.error = `任务总时长超过 ${Math.round(config.taskTimeoutMs / 60000)} 分钟，已停止`;
        break;
      }

      const roundNo = round + 1;
      emit({ type: 'status', phase: 'waiting-question', round: roundNo, limit });

      /* ---------- 1. 取问题 ---------- */
      let question = null;
      const pending = await session.rpc(frame, 'pendingQuestion');
      if (pending?.ok && pending.side !== 'user' && pending.text && pending.signature !== lastSignature) {
        question = pending;
        log.info(`页面上已有待答问题（${pending.text.length} 字），直接作答`);
      } else {
        const waited = await session.rpc(frame, 'waitQuestion', lastSignature, config.questionTimeoutMs);
        if (!waited?.ok) {
          if (waited?.error?.code === 'QUESTION_TIMEOUT') {
            report.stoppedBy = 'NO_MORE_QUESTION';
            log.info('等待新提问超时 —— 判定实践已结束');
            break;
          }
          throw new Error(`读取提问失败：${waited?.error?.message ?? '未知错误'}`);
        }
        question = waited;
      }

      /* ---------- 2. 收尾判定 ---------- */
      if (question.looksLikeEnding && !question.looksLikeQuestion) {
        report.stoppedBy = 'AI_FINISHED';
        log.info('AI 给出收尾语，任务完成');
        break;
      }

      /* ---------- 3. 卡住检测 ---------- */
      if (question.signature === stuckSignature) {
        stuck += 1;
        if (stuck >= 3) {
          report.stoppedBy = 'STUCK';
          report.error = `连续 ${stuck} 轮拿到同一个问题（签名 ${question.signature}），已停止以免空转`;
          break;
        }
      } else {
        stuckSignature = question.signature;
        stuck = 0;
      }

      log.info(`第 ${roundNo} 轮 · 问题：${question.text.slice(0, 60).replace(/\s+/g, ' ')}…`);
      emit({ type: 'question', round: roundNo, text: question.text });

      /* ---------- 4. 生成回答 ---------- */
      emit({ type: 'status', phase: 'thinking', round: roundNo, limit });
      const ctxRes = await session.rpc(frame, 'pageContext');
      const pageContext = ctxRes?.ok ? ctxRes.text : '';

      let answerText;
      try {
        answerText = await llm.chat({
          system: config.systemPrompt,
          user: buildPrompt(question.text, pageContext),
        });
      } catch (err) {
        log.error(`LLM 调用失败：${err.message}`);
        report.stoppedBy = 'LLM_ERROR';
        report.error = err.message;
        break;
      }

      /* ---------- 5. 写入并发送 ---------- */
      emit({ type: 'status', phase: 'sending', round: roundNo, limit });
      const sent = await session.rpc(frame, 'answer', answerText);
      if (!sent?.ok) {
        log.error(`发送失败：${sent?.error?.code} ${sent?.error?.message}`);
        const shot = await session.screenshot(`send-fail-r${roundNo}`);
        report.stoppedBy = 'SEND_FAILED';
        report.error = `${sent?.error?.message ?? '未知'}${shot ? `（截图 ${shot}）` : ''}`;
        break;
      }
      const sentText = sent.sentText ?? answerText;

      /* ---------- 6. 等回复 ---------- */
      emit({ type: 'status', phase: 'waiting-reply', round: roundNo, limit });
      const reply = await session.rpc(frame, 'waitReply', sentText, config.replyTimeoutMs);
      const replyText = reply?.ok ? reply.text : '';

      round += 1;
      lastSignature = question.signature;
      state.set(url, { round, lastSignature });

      report.rounds.push({
        round: roundNo,
        question: question.text,
        answer: sentText,
        reply: replyText,
        at: Date.now(),
      });
      report.totalRounds = round;
      emit({
        type: 'round',
        round: roundNo,
        limit,
        question: question.text,
        answer: sentText,
        reply: replyText,
      });

      if (!reply?.ok) {
        log.warn(`本轮回复等待失败（${reply?.error?.code}），继续下一轮`);
      }

      /* ---------- 7. 轮间隔 ---------- */
      if (round < limit) {
        await sleep(jittered(config.roundIntervalMs), abortSignal);
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      report.stoppedBy = 'ABORTED';
    } else {
      report.stoppedBy = 'ERROR';
      report.error = err?.message ?? String(err);
      log.error(`运行异常：${report.error}`);
      await session.screenshot('run-error');
    }
  }

  if (round >= limit && !report.stoppedBy) report.stoppedBy = 'MAX_ROUNDS';

  report.finishedAt = Date.now();
  report.durationMs = report.finishedAt - startedAt;
  report.totalRounds = round;
  report.usage = llm.usage;
  report.pageContext = '';

  log.info(
    `结束：${report.stoppedBy} · 完成 ${report.totalRounds} 轮 · 耗时 ${Math.round(report.durationMs / 1000)}s`,
  );
  emit({ type: 'done', report });

  return report;
}

/**
 * 组装给模型的 user 消息。
 *
 * 把对话之外的整页文字（任务说明 / 出场角色 / 完成条件）一并给它 —— 这是扩展
 * 验证过的有效做法，回答贴合任务要求。
 */
export function buildPrompt(question, pageContext) {
  const parts = [];
  if (pageContext && pageContext.trim() && pageContext.trim() !== question.trim()) {
    parts.push(`【当前页面背景资料】\n${pageContext.trim().slice(0, 2500)}`);
  }
  parts.push(`【AI 提问】\n${question.trim()}`);
  parts.push('请直接给出你的回答正文，不要复述问题，不要加「答：」前缀。');
  return parts.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* AI 实践任务（situationalDialogue / chat）                            */
/* ------------------------------------------------------------------ */

/**
 * 跑一个 AI 实践任务。
 *
 * 与普通对话流程的区别：
 * 1. 入口是 `stuUrl`（ai-evaluate 重定向到 situationalDialogue）；
 * 2. 需要先点「开始对话」才进 chat；
 * 3. **角色不固定** —— 有的情景 AI 先开口（扮演患者等我们问诊），
 *    有的必须先开口。所以要探测「有没有 AI 消息」，没有就自己起头。
 * 4. 结束时看分数是否达标，而不是看轮数。
 *
 * @param {object} args
 * @param {import('./session.mjs').BrowserSession} args.session
 * @param {object} args.config
 * @param {import('./llm.mjs').LlmClient} args.llm
 * @param {{ stuUrl: string, title: string, requirement?: number }} args.task
 * @param {(e: object) => void} [args.onEvent]
 * @param {AbortSignal} [args.signal]
 */
export async function runAiTask({ session, config, llm, task, onEvent, signal }) {
  const emit = onEvent ?? (() => {});
  const page = session.page;
  const requirement = task.requirement || 80;
  const report = {
    title: task.title,
    stuUrl: task.stuUrl,
    scoreBefore: null,
    scoreAfter: null,
    rounds: 0,
    stoppedBy: '',
    error: null,
  };

  /* ---- 1. 进任务，看现状 ---- */
  emit({ type: 'status', phase: 'detecting', message: `打开 ${task.title}` });
  const info = await session.aiTaskInfo(task.stuUrl);
  report.scoreBefore = info.score;
  log.info(`${task.title}：当前得分 ${info.score ?? '未做'}，达标 ${requirement}`);

  if (info.score !== null && info.score >= requirement) {
    report.stoppedBy = 'ALREADY_DONE';
    log.info('已达标，跳过');
    return report;
  }

  /* ---- 2. 进对话 ---- */
  const startClicked = await page.evaluate(() => {
    const cands = [...document.querySelectorAll('button,div,span,a')].filter((e) => {
      const t = (e.textContent || '').trim();
      return /^开始对话$|^继续对话$|^开始练习$/.test(t) && e.children.length < 3;
    });
    if (!cands.length) return false;
    cands[cands.length - 1].click();
    return true;
  });
  emit({ type: 'status', phase: 'running', message: startClicked ? '已进入对话' : '未找到「开始对话」' });
  await page.waitForTimeout(8000);

  const found = await session.findChatFrame({ timeoutMs: 25_000 });
  if (!found) {
    report.stoppedBy = 'NO_CHAT';
    report.error = '进入对话后没有找到聊天窗口';
    return report;
  }
  const { frame } = found;

  /* ---- 3. 判断谁先开口 ---- */
  const scenario = info.scenario || '';
  // 同类任务的历史高分评语 → 直接注入提示词，越跑越准
  const hints = feedbackHints(task.title);
  if (hints) log.info('已注入历史高分评语作为参考');
  emit({ type: 'status', phase: 'waiting-question' });

  let hasMessage = false;
  for (let i = 0; i < 6; i += 1) {
    await sleep(2500, signal);
    const tail = await session.rpc(frame, 'tail', 3);
    if (tail?.ok && tail.items?.length) {
      hasMessage = true;
      break;
    }
  }

  if (!hasMessage) {
    // 我方先开口：按情景里给定的身份说话
    log.info('AI 未先开口，由我方起头');
    emit({ type: 'status', phase: 'thinking' });
    const opening = await llm.chat({
      system: config.systemPrompt,
      user:
        `【任务情景】\n${scenario || task.title}\n\n` +
        '你正在扮演情景中要求你扮演的角色。请说出**第一句**开场话，' +
        '要自然、口语化、符合身份，不超过 80 字，直接输出这一句话。',
    });
    const sent = await session.rpc(frame, 'answer', opening);
    if (!sent?.ok) {
      report.stoppedBy = 'SEND_FAILED';
      report.error = sent?.error?.message ?? '开场白发送失败';
      return report;
    }
    report.rounds += 1;
    emit({ type: 'round', round: 1, question: '(我方开场)', answer: opening, reply: '' });
  }

  /* ---- 4. 主循环：问 → 答 ---- */
  let lastSignature = null;
  const deadline = Date.now() + config.taskTimeoutMs;

  while (Date.now() < deadline && !signal?.aborted) {
    if (report.rounds >= config.maxRounds) {
      report.stoppedBy = 'MAX_ROUNDS';
      break;
    }

    emit({ type: 'status', phase: 'waiting-question', round: report.rounds });
    const waited = await session.rpc(frame, 'waitQuestion', lastSignature, config.questionTimeoutMs);

    if (!waited?.ok) {
      report.stoppedBy = waited?.error?.code === 'QUESTION_TIMEOUT' ? 'NO_MORE_QUESTION' : 'WAIT_FAIL';
      if (waited?.error?.message) report.error = waited.error.message;
      break;
    }

    const question = { text: waited.text, signature: waited.signature, side: waited.side };
    lastSignature = question.signature;
    log.info(`第 ${report.rounds + 1} 轮 · AI：${question.text.slice(0, 50)}…`);
    emit({ type: 'question', round: report.rounds + 1, text: question.text });

    const ctxRes = await session.rpc(frame, 'pageContext');
    const pageContext = ctxRes?.ok ? ctxRes.text : '';

    emit({ type: 'status', phase: 'thinking', round: report.rounds + 1 });
    let answerText;
    try {
      // 末尾两轮引导收束：给出诊断结论与防治建议，评分看的是覆盖度
      const finishingSoon = report.rounds >= config.maxRounds - 2;
      const guide = finishingSoon
        ? '\n\n【本轮要求】对话即将结束，请在这一轮给出**明确的诊断结论 + 治疗与防治建议**，' +
          '把病原体形态、生活史、致病机制、临床表现、诊断、流行与防治六个方面串起来说清楚。'
        : '\n\n【评分要点】回答要有专业深度，逐步覆盖：病原体形态、生活史、致病机制、' +
          '临床表现、诊断方法、流行与防治。像真实医生一样追问、解释、给建议。';

      answerText = await llm.chat({
        system: config.systemPrompt,
        user: buildPrompt(question.text, pageContext || scenario) + guide + hints,
      });
    } catch (err) {
      report.stoppedBy = 'LLM_ERROR';
      report.error = err.message;
      break;
    }

    emit({ type: 'status', phase: 'sending', round: report.rounds + 1 });
    const sent = await session.rpc(frame, 'answer', answerText);
    if (!sent?.ok) {
      report.stoppedBy = 'SEND_FAILED';
      report.error = sent?.error?.message ?? '发送失败';
      break;
    }
    report.rounds += 1;

    emit({ type: 'status', phase: 'waiting-reply', round: report.rounds });
    const reply = await session.rpc(frame, 'waitReply', sent.sentText ?? answerText, config.replyTimeoutMs);
    emit({
      type: 'round',
      round: report.rounds,
      question: question.text,
      answer: answerText,
      reply: reply?.ok ? reply.text : '',
    });

    // 清空后等下一轮
    await sleep(jittered(config.roundIntervalMs), signal);
  }

  /* ---- 5. 结束练习并评估 ---- */
  // 关键：学习通**不会自动评估**，必须点「结束练习并评估」（button.finish-button）。
  // 该按钮只在「对话里已有消息」后才出现 —— 所以空对话时点不到是正常的。
  emit({ type: 'status', phase: 'finishing', message: '结束练习并评估' });
  let finished = false;
  for (let attempt = 0; attempt < 3 && !finished; attempt += 1) {
    finished = await frame
      .evaluate(() => {
        const btn = document.querySelector('button.finish-button');
        if (!btn) return false;
        btn.click();
        return true;
      })
      .catch(() => false);

    if (!finished) {
      await page.waitForTimeout(2500);
      continue;
    }

    // 可能弹二次确认
    await page.waitForTimeout(2500);
    await frame
      .evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((e) =>
          /^(确认|确定|提交|继续)$/.test((e.textContent || '').trim()),
        );
        if (b) {
          b.click();
          return true;
        }
        return false;
      })
      .catch(() => {});
    break;
  }

  if (finished) {
    log.info('已点击「结束练习并评估」，等待评分');
    emit({ type: 'status', phase: 'grading' });
    for (let i = 0; i < 12; i += 1) {
      await page.waitForTimeout(3000);
      const state = await page
        .evaluate(() => {
          const t = (document.body.innerText || '').replace(/\s+/g, ' ');
          return {
            hasScore: /最终得分|本次得分|得分[:：]/.test(t),
            // 评语段落：优点 / 不足 / 建议 / 亮点 / 改进
            review: (t.match(/(优点|亮点|不足|欠缺|建议|改进|提升)[\s\S]{0,600}/) || [''])[0],
            text: t.slice(0, 2500),
          };
        })
        .catch(() => ({ hasScore: false, review: '', text: '' }));
      if (state.hasScore) {
        report.review = (state.review || '').trim();
        report.gradeText = state.text;
        break;
      }
    }
  } else {
    report.error = '没有找到「结束练习并评估」按钮';
    log.warn('未找到结束按钮，可能对话里还没有消息');
  }

  /* ---- 6. 回任务页看分数 ---- */
  await page.waitForTimeout(2000);
  try {
    await page.goto(task.stuUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(5000);
    const after = await page.evaluate(() => {
      const t = (document.body.innerText || '').replace(/\s+/g, ' ');
      const m = t.match(/最终得分\s*(\d+)\s*分/);
      return m ? Number(m[1]) : null;
    });
    report.scoreAfter = after;
  } catch {
    /* 拿不到分数不影响结论 */
  }

  // 落库：评分 + 评语 → 供下次同类任务复用
  const finalScore = report.scoreAfter ?? report.scoreBefore;
  if (finalScore !== null) {
    recordFeedback({
      title: task.title,
      score: finalScore,
      requirement,
      review: report.review || report.gradeText || '',
      scene: scenario,
      rounds: report.rounds,
    });
  }

  if (!report.stoppedBy) {
    report.stoppedBy = report.scoreAfter !== null && report.scoreAfter >= requirement
      ? 'REACHED'
      : 'ROUNDS_DONE';
  }

  log.info(`${task.title} 结束：${report.stoppedBy}，得分 ${report.scoreBefore ?? '-'} → ${report.scoreAfter ?? '-'}`);
  return report;
}
