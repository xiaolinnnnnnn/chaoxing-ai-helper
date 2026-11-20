/**
 * LLM 客户端 —— 移植自扩展的 `src/background/llm-client.ts`，去掉 chrome 依赖。
 *
 * 能力对齐：Base URL 规整、超时、指数退避重试、`/models` 列表、OpenAI 兼容协议。
 * 额外加了：HTTP 状态分类（401/429/5xx 分别给出可操作提示）、用量统计。
 */
import { createLogger } from './logger.mjs';

const log = createLogger('llm');

/** 规整 Base URL：去掉尾部斜杠与 `/chat/completions`、`/models` 后缀。 */
export function normalizeBaseUrl(baseUrl) {
  let base = String(baseUrl || '').trim().replace(/\/+$/, '');
  base = base.replace(/\/chat\/completions$/i, '');
  base = base.replace(/\/models$/i, '');
  return base;
}

export function chatCompletionsUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

export function modelsUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/models`;
}

const RETRY_DELAYS_MS = [1200, 3000, 6000];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 把 HTTP 状态码翻译成可操作的中文提示。 */
function describeHttp(status, bodyText) {
  const snippet = (bodyText || '').slice(0, 300);
  switch (status) {
    case 401:
    case 403:
      return `鉴权失败（HTTP ${status}）：API Key 无效或无该模型权限。${snippet}`;
    case 404:
      return `接口不存在（HTTP 404）：检查 CXAI_BASE_URL，是否少了/多了 /v1。${snippet}`;
    case 429:
      return `触发限流（HTTP 429）：降低并发或稍后重试。${snippet}`;
    case 400:
      return `请求被拒（HTTP 400）：多为模型名错误或上下文超长。${snippet}`;
    default:
      return status >= 500
        ? `服务端错误（HTTP ${status}）：可重试。${snippet}`
        : `请求失败（HTTP ${status}）。${snippet}`;
  }
}

function retryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

export class LlmClient {
  constructor(config) {
    this.config = config;
    this.usage = { promptTokens: 0, completionTokens: 0, calls: 0 };
  }

  get headers() {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  async request(url, init, { timeoutMs, retry = true } = {}) {
    const attempts = retry ? RETRY_DELAYS_MS.length + 1 : 1;
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new DOMException('Timeout', 'TimeoutError')),
        timeoutMs ?? this.config.llmTimeoutMs,
      );
      try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const err = new Error(describeHttp(res.status, body));
          err.retryable = retryableStatus(res.status);
          err.status = res.status;
          throw err;
        }
        return await res.json();
      } catch (err) {
        lastError = err;
        const isAbort = err?.name === 'AbortError' || err?.name === 'TimeoutError';
        const canRetry = isAbort || err?.retryable !== false;
        if (!retry || !canRetry || attempt === attempts) break;
        const delay = RETRY_DELAYS_MS[attempt - 1] ?? 6000;
        log.warn(`第 ${attempt} 次请求失败：${err.message}；${delay}ms 后重试`);
        await sleep(delay);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  /**
   * 发起一次对话补全。
   *
   * @param {{ system: string, user: string, signal?: AbortSignal }} args
   * @returns {Promise<string>} 助手回复正文
   */
  async chat({ system, user }) {
    const payload = {
      model: this.config.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: this.config.temperature,
      stream: false,
    };

    const started = Date.now();
    const data = await this.request(chatCompletionsUrl(this.config.baseUrl), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(payload),
    });

    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error(`模型返回空内容：${JSON.stringify(data).slice(0, 300)}`);
    }

    if (data.usage) {
      this.usage.promptTokens += data.usage.prompt_tokens ?? 0;
      this.usage.completionTokens += data.usage.completion_tokens ?? 0;
    }
    this.usage.calls += 1;
    log.info(`作答完成 ${Date.now() - started}ms / ${text.length} 字`);
    return text.trim();
  }

  /** 拉取可用模型列表（配置面板用）。 */
  async listModels() {
    const data = await this.request(
      modelsUrl(this.config.baseUrl),
      { method: 'GET', headers: this.headers },
      { timeoutMs: 20_000 },
    );
    const list = Array.isArray(data?.data) ? data.data : [];
    return list.map((m) => m.id).filter(Boolean);
  }

  /** 连通性测试：一次最小对话 + 尝试拉模型列表。 */
  async test() {
    const started = Date.now();
    const reply = await this.chat({ system: '你是连通性测试助手。', user: '回复「ok」两个字符即可。' });
    let models = [];
    try {
      models = await this.listModels();
    } catch {
      /* 部分中转端点不实现 /models，不影响主流程 */
    }
    return { ok: true, latencyMs: Date.now() - started, reply: reply.slice(0, 50), models };
  }
}
