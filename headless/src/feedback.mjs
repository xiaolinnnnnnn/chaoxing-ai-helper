/**
 * 评分反馈学习库 —— 让项目越跑越准。
 *
 * 学习通在「结束练习并评估」之后会给出分数和评语（优点 / 不足 / 建议）。
 * 这些评语是**免费的监督信号**：同一类任务下次作答时，把历史反馈喂回提示词，
 * 模型就知道该补哪些点。
 *
 * 存储：`data/feedback.json`，按「任务类型键」分桶（同一案例分析重复出现多次时共享）。
 * 键的构造：标题去掉时间/日期等噪声后归一化 —— 同一案例不同批次发布仍能命中。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger } from './logger.mjs';

const log = createLogger('feedback');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = resolve(ROOT, 'data/feedback.json');
const MAX_PER_KEY = 6;

/**
 * 把任务标题归一化成稳定的「类型键」。
 *
 * 例：`疟疾案例分析 剩余:11小时` → `疟疾案例分析`
 *     `细菌全身感染类型病例分析 结束时间：10-31 00:00` → `细菌全身感染类型病例分析`
 */
export function taskKey(title, fallback = '') {
  const base = String(title || fallback)
    .replace(/(剩余|结束时间|截止)[:：].*$/, '')
    .replace(/\s+/g, '')
    .replace(/[（(]\d{4}[-—]\d{4}[-—]\d+[)）]/g, '')
    .trim();
  return base || 'unknown';
}

function loadStore() {
  if (!existsSync(STORE)) return {};
  try {
    return JSON.parse(readFileSync(STORE, 'utf8'));
  } catch {
    return {};
  }
}

function saveStore(data) {
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(STORE, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * 记录一次评分反馈。
 *
 * @param {object} entry
 * @param {string} entry.title 任务标题
 * @param {number|null} entry.score 得分
 * @param {number} [entry.requirement] 达标分
 * @param {string} [entry.review] 评语原文（优点/不足/建议）
 * @param {string} [entry.scene] 情景说明
 * @param {number} [entry.rounds] 本次轮数
 */
export function recordFeedback({ title, score, requirement = 80, review = '', scene = '', rounds = 0 }) {
  if (score === null || score === undefined) return null;
  const key = taskKey(title);
  const store = loadStore();
  const list = Array.isArray(store[key]) ? store[key] : [];

  list.push({
    score,
    requirement,
    review: String(review || '').slice(0, 1200),
    scene: String(scene || '').slice(0, 600),
    rounds,
    at: Date.now(),
  });

  // 只留最近 N 次，且优先保留高分与有评语的
  list.sort((a, b) => (b.score - a.score) || (b.at - a.at));
  store[key] = list.slice(0, MAX_PER_KEY);
  saveStore(store);

  log.info(`记录反馈 ${key}：${score} 分（库中 ${store[key].length} 条）`);
  return key;
}

/**
 * 取历史反馈摘要，拼成交给模型的「经验提示」。
 *
 * 只取**高分且带评语**的条目 —— 低分评语说明的是失败做法，容易把模型带偏；
 * 高分评语里的「亮点」才是可复用的。
 */
export function feedbackHints(title, { minScore = 80 } = {}) {
  const key = taskKey(title);
  const store = loadStore();
  const list = Array.isArray(store[key]) ? store[key] : [];
  const good = list.filter((x) => x.score >= minScore && x.review && x.review.length > 10);
  if (!good.length) return '';

  const seen = new Set();
  const lines = [];
  for (const item of good) {
    const brief = item.review.replace(/\s+/g, ' ').slice(0, 260);
    if (seen.has(brief)) continue;
    seen.add(brief);
    lines.push(`- （${item.score} 分）${brief}`);
    if (lines.length >= 3) break;
  }
  if (!lines.length) return '';

  return (
    '\n\n【同类任务的历史高分评语，请对齐这些亮点】\n' +
    lines.join('\n')
  );
}

/** 读取整库（Web 控制台展示用）。 */
export function allFeedback() {
  const store = loadStore();
  return Object.entries(store).map(([key, list]) => ({
    key,
    best: Math.max(...list.map((x) => x.score), 0),
    count: list.length,
    last: list[0],
  }));
}

/** 某个类型的完整记录。 */
export function feedbackOf(title) {
  const store = loadStore();
  return store[taskKey(title)] ?? [];
}
