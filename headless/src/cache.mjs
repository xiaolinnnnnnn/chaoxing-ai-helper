/**
 * 本地结果缓存 —— 避免每次打开都要重查课程 / 任务 / 分数。
 *
 * 抓一次的开销：课程列表 ~15s，任务列表 ~16s，每个分数 ~8s。
 * 全部重查一遍要几分钟，但数据本身变化很慢，缓存完全够用。
 *
 * 布局：
 * ```
 * .cache/courses-<phone>.json    课程列表
 * .cache/tasks-<courseid>.json   任务 + 分数
 * ```
 * 每个文件都带 `at` 时间戳，前端可显示「几分钟前」，也可强制刷新。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger } from './logger.mjs';

const log = createLogger('cache');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, '.cache');

/** 默认有效期：课程 30 分钟，任务 20 分钟。 */
export const TTL = {
  courses: 30 * 60_000,
  tasks: 20 * 60_000,
};

function ensure() {
  mkdirSync(DIR, { recursive: true });
}

/** 稳定的短哈希，避免文件名过长或含特殊字符。 */
function hash(str) {
  return createHash('md5').update(String(str)).digest('hex').slice(0, 12);
}

function pathOf(kind, key) {
  const safe = kind === 'courses' ? String(key || 'default').replace(/[^\dA-Za-z_-]/g, '') : hash(key);
  return resolve(DIR, `${kind}-${safe}.json`);
}

/**
 * 读缓存。
 *
 * @param {'courses'|'tasks'} kind
 * @param {string} key 课程用 phone，任务用 courseHref
 * @param {number} maxAgeMs 有效期；传 0 表示不限
 * @returns {{ data: unknown, at: number, ageMs: number } | null}
 */
export function readCache(kind, key, maxAgeMs = 0) {
  ensure();
  const file = pathOf(kind, key);
  if (!existsSync(file)) return null;
  try {
    const payload = JSON.parse(readFileSync(file, 'utf8'));
    const ageMs = Date.now() - (payload.at || 0);
    if (maxAgeMs > 0 && ageMs > maxAgeMs) return null;
    return { data: payload.data, at: payload.at, ageMs };
  } catch {
    return null;
  }
}

/** 写缓存。 */
export function writeCache(kind, key, data) {
  ensure();
  try {
    writeFileSync(pathOf(kind, key), JSON.stringify({ at: Date.now(), data }), 'utf8');
  } catch (err) {
    log.warn(`缓存写入失败：${err.message}`);
  }
}

/** 清某个缓存。 */
export function dropCache(kind, key) {
  try {
    const f = pathOf(kind, key);
    if (existsSync(f)) unlinkSync(f);
  } catch {
    /* ignore */
  }
}

/** 清全部缓存。 */
export function clearAll() {
  ensure();
  let n = 0;
  for (const f of readdirSync(DIR)) {
    try {
      unlinkSync(resolve(DIR, f));
      n += 1;
    } catch {
      /* ignore */
    }
  }
  log.info(`已清空 ${n} 个缓存文件`);
  return n;
}

/* ------------------------------------------------------------------ */
/* 分数持久化（每跑完一个任务就写一次）                                 */
/* ------------------------------------------------------------------ */

const SCORES = resolve(DIR, 'scores.json');

function loadScores() {
  ensure();
  if (!existsSync(SCORES)) return {};
  try {
    return JSON.parse(readFileSync(SCORES, 'utf8'));
  } catch {
    return {};
  }
}

function saveScores(data) {
  ensure();
  try {
    writeFileSync(SCORES, JSON.stringify(data, null, 0), 'utf8');
  } catch (err) {
    log.warn(`分数保存失败：${err.message}`);
  }
}

/**
 * 记录一个任务的分数（每次运行后调用）。
 *
 * @param {string} stuUrl 任务唯一链接
 * @param {{ score: number|null, attempts?: number, requirement?: number, title?: string }} info
 */
export function saveScore(stuUrl, info) {
  if (!stuUrl) return;
  const all = loadScores();
  all[stuUrl] = {
    score: info.score ?? null,
    attempts: info.attempts ?? 0,
    requirement: info.requirement ?? 80,
    title: info.title || '',
    at: Date.now(),
  };
  saveScores(all);
  log.info(`分数已保存：${info.title || stuUrl.slice(-20)} → ${info.score ?? '未做'}`);
}

/** 读全部已保存分数。 */
export function allScores() {
  return loadScores();
}

/** 把已保存分数合并进任务列表。 */
export function mergeScores(tasks) {
  const all = loadScores();
  return tasks.map((t) => {
    const hit = t.stuUrl ? all[t.stuUrl] : null;
    if (!hit) return t;
    return {
      ...t,
      score: hit.score,
      attempts: hit.attempts,
      lastScoreAt: hit.at,
    };
  });
}

/** 缓存概览（前端展示用）。 */
export function cacheOverview() {
  ensure();
  const out = [];
  for (const f of readdirSync(DIR)) {
    try {
      const p = JSON.parse(readFileSync(resolve(DIR, f), 'utf8'));
      out.push({ file: f, at: p.at, ageMs: Date.now() - (p.at || 0) });
    } catch {
      /* ignore */
    }
  }
  return out.sort((a, b) => b.at - a.at);
}
