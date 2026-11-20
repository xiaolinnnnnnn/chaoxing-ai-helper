/**
 * 配置层 —— 对齐 cidaren-ultimate 的模式：`.env` + 环境变量覆盖 + 默认值 + 校验。
 *
 * 优先级：环境变量 > .env 文件 > 内置默认值。
 * 不引入 dotenv，自己解析（几十行，省一个依赖）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 极简 .env 解析：支持 KEY=VALUE / 注释 / 引号。 */
function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = parseEnvFile(resolve(ROOT, '.env'));

/** 读配置：env > .env > 默认值。 */
function read(key, fallback = '') {
  const v = process.env[key] ?? fileEnv[key];
  return v === undefined || v === '' ? fallback : v;
}

function readInt(key, fallback) {
  const n = Number.parseInt(read(key, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function readBool(key, fallback) {
  const v = read(key, '').toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

/** 默认 System Prompt（与扩展保持一致）。 */
export const DEFAULT_SYSTEM_PROMPT =
  '你是学习通 AI 实践课的对话助手。请用简洁、口语化、符合学生身份的中文回答，' +
  '控制在 100-200 字，不要使用 Markdown 列表。';

export function loadConfig(overrides = {}) {
  const config = {
    /* ---- LLM ---- */
    baseUrl: read('CXAI_BASE_URL', 'https://api.deepseek.com'),
    apiKey: read('CXAI_API_KEY', ''),
    model: read('CXAI_MODEL', 'deepseek-chat'),
    temperature: Number.parseFloat(read('CXAI_TEMPERATURE', '1.0')),
    llmTimeoutMs: readInt('CXAI_LLM_TIMEOUT_MS', 60_000),

    /* ---- 学习通 ---- */
    targetUrl: read(
      'CXAI_TARGET_URL',
      'https://mooc2-ans.chaoxing.com/mooc2-ans-vue/taskChain/student/answer',
    ),
    /** 登录态持久化目录（Playwright persistent context）。 */
    userDataDir: read('CXAI_USER_DATA_DIR', resolve(ROOT, '.profile')),
    /** 导出的 cookies 文件（可选，替代首次登录）。 */
    storageState: read('CXAI_STORAGE_STATE', ''),

    /* ---- 账号密码自动登录（可选）---- */
    phone: read('CXAI_PHONE', ''),
    password: read('CXAI_PASSWORD', ''),

    /* ---- 行为 ---- */
    systemPrompt: read('CXAI_SYSTEM_PROMPT', DEFAULT_SYSTEM_PROMPT),
    maxRounds: readInt('CXAI_MAX_ROUNDS', 30),
    /** 每轮间隔（毫秒），前后再加 ±30% 抖动，避免固定节奏。 */
    roundIntervalMs: readInt('CXAI_ROUND_INTERVAL_MS', 3000),
    replyTimeoutMs: readInt('CXAI_REPLY_TIMEOUT_MS', 120_000),
    questionTimeoutMs: readInt('CXAI_QUESTION_TIMEOUT_MS', 180_000),
    /** 等对话窗口出现的上限。 */
    detectTimeoutMs: readInt('CXAI_DETECT_TIMEOUT_MS', 45_000),
    /** 单次任务总上限，防止挂死。 */
    taskTimeoutMs: readInt('CXAI_TASK_TIMEOUT_MS', 3 * 3600_000),

    /* ---- 运行 ---- */
    headless: readBool('CXAI_HEADLESS', true),
    /** 浏览器可执行文件路径（默认用 Playwright 自带 Chromium）。 */
    executablePath: read('CXAI_CHROMIUM', ''),
    /** 日志目录。 */
    logDir: read('CXAI_LOG_DIR', resolve(ROOT, 'logs')),
    /** 中断后从断点继续。 */
    resume: readBool('CXAI_RESUME', true),
  };

  Object.assign(config, overrides);
  return config;
}

/** 校验配置，返回问题列表（空数组 = 通过）。 */
export function validateConfig(config, { requireApiKey = true } = {}) {
  const issues = [];
  if (requireApiKey && !config.apiKey) {
    issues.push('缺少 CXAI_API_KEY（在 .env 里填，或设置同名环境变量）');
  }
  try {
    const u = new URL(config.baseUrl);
    if (!/^https?:$/.test(u.protocol)) issues.push(`CXAI_BASE_URL 协议不支持：${u.protocol}`);
  } catch {
    issues.push(`CXAI_BASE_URL 不是合法 URL：${config.baseUrl}`);
  }
  if (!config.model) issues.push('缺少 CXAI_MODEL');
  if (!(config.maxRounds > 0)) issues.push('CXAI_MAX_ROUNDS 必须是正整数');
  return issues;
}

export { ROOT };

/* ------------------------------------------------------------------ */
/* 写回 .env                                                           */
/* ------------------------------------------------------------------ */

const ENV_PATH = resolve(ROOT, '.env');

/**
 * 把若干键值写回 `.env`（保留注释与原有顺序）。
 *
 * 已存在的 `KEY=...` 就地替换；不存在的追加到文件末尾。
 * 值为空字符串时写 `KEY=`（视为清空，而不是删除行）。
 *
 * @param {Record<string, string|number|boolean>} patch
 */
export function saveEnv(patch) {
  let lines = [];
  if (existsSync(ENV_PATH)) {
    lines = readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
  }

  const pending = new Map(
    Object.entries(patch).map(([k, v]) => [k, v === undefined || v === null ? '' : String(v)]),
  );

  const out = lines.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (!m) return line;
    const key = m[1];
    if (!pending.has(key)) return line;
    const value = pending.get(key);
    pending.delete(key);
    return `${key}=${value}`;
  });

  // 剩下没写过的追加
  if (pending.size) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    for (const [key, value] of pending) out.push(`${key}=${value}`);
  }

  writeFileSync(ENV_PATH, out.join('\n').replace(/\n+$/, '') + '\n', 'utf8');
  return ENV_PATH;
}

/** 把页面提交的配置合并进内存 config 对象（不落盘）。 */
export function applyPatch(config, patch) {
  const map = {
    baseUrl: 'CXAI_BASE_URL',
    apiKey: 'CXAI_API_KEY',
    model: 'CXAI_MODEL',
    targetUrl: 'CXAI_TARGET_URL',
    phone: 'CXAI_PHONE',
    password: 'CXAI_PASSWORD',
    maxRounds: 'CXAI_MAX_ROUNDS',
    roundIntervalMs: 'CXAI_ROUND_INTERVAL_MS',
    temperature: 'CXAI_TEMPERATURE',
    systemPrompt: 'CXAI_SYSTEM_PROMPT',
  };
  const envPatch = {};
  for (const [field, envKey] of Object.entries(map)) {
    if (!(field in patch)) continue;
    const value = patch[field];
    config[field] = value;
    envPatch[envKey] = value;
  }
  // 数值型字段统一转一下
  for (const k of ['maxRounds', 'roundIntervalMs']) {
    if (k in patch) config[k] = Number.parseInt(String(patch[k]), 10) || config[k];
  }
  if ('temperature' in patch) config.temperature = Number.parseFloat(String(patch.temperature)) || 1;
  return envPatch;
}

/** 供前端展示的配置快照（密钥脱敏）。 */
export function publicConfig(config) {
  const mask = (s) => {
    if (!s) return '';
    if (s.length <= 8) return '****';
    return `${s.slice(0, 5)}${'*'.repeat(Math.min(12, s.length - 9))}${s.slice(-4)}`;
  };
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    apiKeyMasked: mask(config.apiKey),
    hasApiKey: Boolean(config.apiKey),
    hasPhone: Boolean(config.phone),
    phoneMasked: config.phone ? config.phone.replace(/^(\d{3})\d+(\d{4})$/, '$1****$2') : '',
    targetUrl: config.targetUrl,
    maxRounds: config.maxRounds,
    roundIntervalMs: config.roundIntervalMs,
    temperature: config.temperature,
    systemPrompt: config.systemPrompt,
  };
}
