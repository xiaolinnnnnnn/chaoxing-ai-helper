/**
 * 统一日志 —— 对齐扩展的 `[CX-AI][scope]` 风格，额外支持写文件与环形缓冲。
 *
 * 无头运行时没有 DevTools，日志就是唯一的现场。所以：
 * - 颜色只在 TTY 下启用；
 * - 同时写 `logs/run-<时间戳>.log`；
 * - 保留最近 N 条在内存里，供 Web 控制台 / 报告读取。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const RING_MAX = 500;
const ring = [];
let logFile = null;
let quiet = false;

const COLORS = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
};

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** 开启文件日志。 */
export function startFileLog(dir) {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  logFile = resolve(dir, `run-${stamp}.log`);
  return logFile;
}

export function getLogFile() {
  return logFile;
}

export function setQuiet(value) {
  quiet = value;
}

export function getRing() {
  return ring.slice();
}

function emit(level, scope, message) {
  const entry = { level, scope, message, at: Date.now(), time: ts() };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();

  const line = `${entry.time} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  if (logFile) {
    try {
      appendFileSync(logFile, `${line}\n`);
    } catch {
      /* 日志写失败不能影响主流程 */
    }
  }
  if (quiet) return;
  const color = process.stdout.isTTY ? COLORS[level] ?? '' : '';
  const reset = process.stdout.isTTY ? COLORS.reset : '';
  (level === 'error' ? console.error : console.log)(`${color}${line}${reset}`);
}

/** 创建带 scope 的 logger。 */
export function createLogger(scope) {
  return {
    debug: (m) => emit('debug', scope, m),
    info: (m) => emit('info', scope, m),
    warn: (m) => emit('warn', scope, m),
    error: (m) => emit('error', scope, m),
  };
}
