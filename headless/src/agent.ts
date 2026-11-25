/**
 * 页内 Agent —— 无头引擎的「手」。
 *
 * 目标：把扩展里那套已经在真实站点验证过的 DOM 逻辑（探测 / 读消息 / 写输入框 /
 * 发送 / 等待流式回复）原样搬到 Playwright 页面里跑，对外只暴露 **可序列化的 RPC**。
 *
 * 为什么必须这样做：Playwright 的 `page.evaluate()` 无法在 Node 侧持有 DOM 引用，
 * 每次调用都是全新上下文。所以 agent 在页面里维护一个模块级单例（缓存探测结果），
 * Node 侧每次只传/收纯数据（字符串、数字、布尔），不传元素。
 *
 * 注入方式：`window.__CXAI = {...}`，由 `session.mjs` 通过 addInitScript 注入每个 frame。
 */

import { detectChat } from '../../src/content/detector';
import {
  getMessages,
  getMessagesSignature,
  getPageContext,
  looksLikeEnding,
  looksLikeQuestion,
  setOwnSentText,
  waitForNewQuestion,
  waitForStableReply,
} from '../../src/content/observer';
import {
  ensureInputReady,
  fillInput,
  isInputLocked,
  sendMessage,
} from '../../src/content/injector';
import { readFlowState } from '../../src/content/flow-dom';
import type { ChatTargets, SelectorOverrides } from '../../src/types';

/** 探测结果摘要（不含 DOM 引用，可安全序列化）。 */
interface TargetSummary {
  ok: true;
  confidence: number;
  source: ChatTargets['source'];
  matched: ChatTargets['matched'];
  messageCount: number;
  inputLocked: boolean;
  hasSendBtn: boolean;
  hasUnlockBtn: boolean;
  url: string;
}

interface AgentError {
  ok: false;
  error: { code: string; message: string };
}

type AgentResult<T> = T | AgentError;

/* ------------------------------------------------------------------ */
/* 单例状态                                                            */
/* ------------------------------------------------------------------ */

let cached: ChatTargets | null = null;
let overrides: SelectorOverrides = {};

/**
 * 取（或重新探测）当前 frame 的对话窗口。
 *
 * 缓存失效条件：输入框 / 消息列表已从文档里被移除（Vue 重新渲染很常见）。
 */
function targets(): ChatTargets | null {
  if (cached && cached.input?.isConnected && cached.list?.isConnected) return cached;
  cached = detectChat(overrides);
  return cached;
}

function fail(code: string, message: string): AgentError {
  return { ok: false, error: { code, message } };
}

function summary(t: ChatTargets): TargetSummary {
  let messageCount = 0;
  try {
    messageCount = getMessages(t.list).filter((m) => m.text.trim()).length;
  } catch {
    /* 列表结构异常时给 0，不影响主流程 */
  }
  return {
    ok: true,
    confidence: t.confidence,
    source: t.source,
    matched: t.matched,
    messageCount,
    inputLocked: isInputLocked(t.input),
    hasSendBtn: Boolean(t.sendBtn),
    hasUnlockBtn: Boolean(t.unlockBtn),
    url: location.href,
  };
}

function errInfo(err: unknown): { code: string; message: string } {
  const anyErr = err as { code?: string; message?: string } | null;
  return {
    code: anyErr?.code ?? 'UNKNOWN',
    message: anyErr?.message ?? String(err),
  };
}

/* ------------------------------------------------------------------ */
/* 对外 API                                                            */
/* ------------------------------------------------------------------ */

export interface CxaiAgent {
  readonly version: string;
  /** 探测并返回摘要；未探测到返回 {ok:false}。 */
  detect(opts?: { overrides?: SelectorOverrides }): AgentResult<TargetSummary>;
  /** 清空缓存，强制下次重新探测。 */
  reset(): void;
  /** 当前待答问题（最后一条非空消息是 AI 时才算）。 */
  pendingQuestion(): AgentResult<{
    text: string;
    signature: string;
    side: string;
    looksLikeQuestion: boolean;
    looksLikeEnding: boolean;
  } | null>;
  /** 对话之外的整页背景资料。 */
  pageContext(): AgentResult<{ text: string }>;
  /** 解锁 → 写输入框 → 发送。一步到位，内部含三级重试。 */
  answer(text: string): Promise<AgentResult<{ sentText: string }>>;
  /** 等待新的 AI 提问（要求流式输出稳定）。 */
  waitQuestion(
    previousSignature: string | null,
    timeoutMs: number,
  ): Promise<AgentResult<{ text: string; signature: string; side: string }>>;
  /** 等待我方刚发那条之后的 AI 回复稳定。 */
  waitReply(sentText: string | null, timeoutMs: number): Promise<AgentResult<{ text: string }>>;
  /** 任务流状态（节点列表 / 当前节点 / 是否已完成）。 */
  flowState(): AgentResult<unknown>;
  /** 最近若干条消息的侧别与摘要（调试/日志用）。 */
  tail(limit?: number): AgentResult<{ items: { side: string; text: string }[] }>;
}

const api: CxaiAgent = {
  version: '1.0.0',

  detect(opts) {
    if (opts?.overrides) overrides = opts.overrides;
    cached = null;
    const t = targets();
    if (!t) return fail('NO_TARGET', '当前 frame 未探测到 AI 实践对话窗口');
    return summary(t);
  },

  reset() {
    cached = null;
  },

  pendingQuestion() {
    const t = targets();
    if (!t) return fail('NO_TARGET', '未探测到对话窗口');
    let messages;
    try {
      messages = getMessages(t.list).filter((m) => m.text.trim());
    } catch (err) {
      return fail('READ_FAILED', errInfo(err).message);
    }
    const last = messages.at(-1);
    if (!last) return { ok: true, text: '', signature: '', side: 'none', looksLikeQuestion: false, looksLikeEnding: false };
    const isAi = last.side !== 'user';
    return {
      ok: true,
      text: last.text,
      signature: last.signature,
      side: last.side,
      looksLikeQuestion: isAi && looksLikeQuestion(last.text),
      looksLikeEnding: isAi && looksLikeEnding(last.text),
    };
  },

  pageContext() {
    const t = targets();
    if (!t) return fail('NO_TARGET', '未探测到对话窗口');
    try {
      return { ok: true, text: getPageContext(t) };
    } catch (err) {
      return fail('CONTEXT_FAILED', errInfo(err).message);
    }
  },

  async answer(text) {
    const t = targets();
    if (!t) return fail('NO_TARGET', '未探测到对话窗口');
    try {
      // 学习通在轮到学生作答前输入框是锁的，必须先点「继续」解锁
      await ensureInputReady(t.input, t.unlockBtn, { timeoutMs: 8000 });
      await fillInput(t.input, text);
      const beforeSignature = getMessagesSignature(t.list);
      setOwnSentText(text);
      await sendMessage(t, { beforeSignature, sentText: text });
      return { ok: true, sentText: text };
    } catch (err) {
      return fail(errInfo(err).code, errInfo(err).message);
    }
  },

  async waitQuestion(previousSignature, timeoutMs) {
    const t = targets();
    if (!t) return fail('NO_TARGET', '未探测到对话窗口');
    try {
      const view = await waitForNewQuestion(t.list, previousSignature, { timeoutMs });
      return { ok: true, text: view.text, signature: view.signature, side: view.side };
    } catch (err) {
      return fail(errInfo(err).code, errInfo(err).message);
    }
  },

  async waitReply(sentText, timeoutMs) {
    const t = targets();
    if (!t) return fail('NO_TARGET', '未探测到对话窗口');
    try {
      const text = await waitForStableReply(t.list, { timeoutMs, sentText });
      return { ok: true, text };
    } catch (err) {
      return fail(errInfo(err).code, errInfo(err).message);
    }
  },

  flowState() {
    try {
      return { ok: true, state: readFlowState() };
    } catch (err) {
      return fail('FLOW_READ_FAILED', errInfo(err).message);
    }
  },

  tail(limit = 6) {
    const t = targets();
    if (!t) return fail('NO_TARGET', '未探测到对话窗口');
    try {
      const items = getMessages(t.list)
        .filter((m) => m.text.trim())
        .slice(-limit)
        .map((m) => ({ side: m.side, text: m.text.slice(0, 200) }));
      return { ok: true, items };
    } catch (err) {
      return fail('READ_FAILED', errInfo(err).message);
    }
  },
};

(window as unknown as { __CXAI: CxaiAgent }).__CXAI = api;
