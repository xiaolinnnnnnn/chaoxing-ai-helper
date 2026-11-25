/**
 * 账号池 —— 多账号管理（参考 pace-forge 的 accounts.json 设计）。
 *
 * ```
 * .accounts.json          账号列表 + 当前激活账号
 * .sessions/<phone>.json  每个账号独立的 cookie 快照
 * ```
 *
 * 为什么每个账号单独存 cookie：
 * - 学习通的 `_uid` 是 session cookie，不落盘就丢；
 * - 多账号共用一份快照会互相覆盖，切号后「登录成功但进不去」；
 * - 按手机号分文件，切号只是换文件名，不需要重新登录。
 *
 * 密码是否落盘：只在用户勾选「记住」时才存，且只存本地。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger } from './logger.mjs';

const log = createLogger('accounts');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = resolve(ROOT, '.accounts.json');
const SESSION_DIR = resolve(ROOT, '.sessions');

/** 手机号脱敏：138****8000 */
export function maskPhone(phone) {
  const p = String(phone || '');
  if (!p) return '';
  if (p.length < 7) return '****';
  return `${p.slice(0, 3)}****${p.slice(-4)}`;
}

function ensureDir() {
  mkdirSync(SESSION_DIR, { recursive: true });
}

/** 读账号池。 */
function loadStore() {
  if (!existsSync(FILE)) return { accounts: [], activePhone: '' };
  try {
    const data = JSON.parse(readFileSync(FILE, 'utf8'));
    return {
      accounts: Array.isArray(data.accounts) ? data.accounts : [],
      activePhone: data.activePhone || '',
    };
  } catch {
    return { accounts: [], activePhone: '' };
  }
}

function saveStore(store) {
  writeFileSync(FILE, JSON.stringify(store, null, 2), 'utf8');
}

/** 某账号的 cookie 快照路径。 */
export function sessionFileOf(phone) {
  const key = String(phone || 'default').replace(/[^\dA-Za-z_-]/g, '');
  return resolve(SESSION_DIR, `${key}.json`);
}

/* ------------------------------------------------------------------ */
/* 账号增删改查                                                        */
/* ------------------------------------------------------------------ */

/**
 * 新增或更新账号档案。
 *
 * @param {{ phone: string, password?: string, name?: string, school?: string, uid?: string, avatar?: string }} info
 */
export function upsertAccount(info) {
  const phone = String(info.phone || '').trim();
  if (!phone) throw new Error('缺少手机号');

  const store = loadStore();
  const idx = store.accounts.findIndex((a) => a.phone === phone);
  const prev = idx >= 0 ? store.accounts[idx] : {};

  const merged = {
    phone,
    // 不给新密码就沿用旧的
    password: info.password !== undefined && info.password !== '' ? String(info.password) : prev.password || '',
    name: info.name || prev.name || '',
    school: info.school || prev.school || '',
    uid: info.uid || prev.uid || '',
    avatar: info.avatar || prev.avatar || '',
    savedAt: Date.now(),
  };

  if (idx >= 0) store.accounts[idx] = merged;
  else store.accounts.push(merged);

  if (!store.activePhone) store.activePhone = phone;
  saveStore(store);
  log.info(`账号已保存：${maskPhone(phone)} ${merged.name || ''}`);
  return merged;
}

/** 删除账号（连带删除它的 cookie 快照）。 */
export function removeAccount(phone) {
  const store = loadStore();
  const before = store.accounts.length;
  store.accounts = store.accounts.filter((a) => a.phone !== phone);
  if (store.activePhone === phone) {
    store.activePhone = store.accounts[0]?.phone || '';
  }
  saveStore(store);

  try {
    const f = sessionFileOf(phone);
    if (existsSync(f)) unlinkSync(f);
  } catch {
    /* ignore */
  }
  log.info(`账号已删除：${maskPhone(phone)}（${before - store.accounts.length} 条）`);
}

/** 切换当前激活账号。 */
export function setActiveAccount(phone) {
  const store = loadStore();
  if (!store.accounts.some((a) => a.phone === phone)) {
    throw new Error('账号不存在');
  }
  store.activePhone = phone;
  saveStore(store);
  log.info(`已切换账号：${maskPhone(phone)}`);
}

/** 取当前激活账号。 */
export function activeAccount() {
  const store = loadStore();
  return store.accounts.find((a) => a.phone === store.activePhone) || null;
}

/** 取指定账号。 */
export function getAccount(phone) {
  const store = loadStore();
  return store.accounts.find((a) => a.phone === phone) || null;
}

/** 全部账号（脱敏）。 */
export function allAccounts() {
  const store = loadStore();
  return {
    activePhone: store.activePhone,
    accounts: store.accounts.map((a) => ({
      phone: a.phone,
      phoneMasked: maskPhone(a.phone),
      name: a.name || '',
      school: a.school || '',
      uid: a.uid || '',
      avatar: a.avatar || '',
      hasPassword: Boolean(a.password),
      hasSession: existsSync(sessionFileOf(a.phone)),
      active: a.phone === store.activePhone,
      savedAt: a.savedAt,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* 兼容旧接口（单账号时代）                                            */
/* ------------------------------------------------------------------ */

/** 保存当前账号档案（旧调用点用）。 */
export function saveAccount(info) {
  const acc = activeAccount();
  const phone = info.phone || acc?.phone || 'default';
  return upsertAccount({ ...info, phone });
}

/** 读当前账号档案。 */
export function loadAccount() {
  return activeAccount();
}

/** 清当前账号档案里的身份字段（保留账号本身）。 */
export function clearAccount() {
  const acc = activeAccount();
  if (!acc) return;
  const store = loadStore();
  const target = store.accounts.find((a) => a.phone === acc.phone);
  if (target) {
    target.name = '';
    target.school = '';
    target.uid = '';
    target.avatar = '';
    saveStore(store);
  }
}

/** 供前端展示。 */
export function publicAccount() {
  const acc = activeAccount();
  if (!acc) return null;
  return {
    phone: acc.phone,
    phoneMasked: maskPhone(acc.phone),
    name: acc.name,
    school: acc.school,
    uid: acc.uid,
    avatar: acc.avatar,
    savedAt: acc.savedAt,
  };
}

/** 清理孤儿 session 文件（账号已删但 cookie 还在）。 */
export function pruneSessions() {
  if (!existsSync(SESSION_DIR)) return 0;
  const store = loadStore();
  const keep = new Set(store.accounts.map((a) => sessionFileOf(a.phone).split('/').pop()));
  let removed = 0;
  for (const f of readdirSync(SESSION_DIR)) {
    if (!keep.has(f)) {
      try {
        unlinkSync(resolve(SESSION_DIR, f));
        removed += 1;
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}

/**
 * 一次性迁移：把单账号时代的 `.session.json` 归到对应账号名下。
 *
 * 只在目标文件不存在时复制，不删除旧文件（多一层保险）。
 */
export function migrateLegacySession() {
  const legacy = resolve(ROOT, '.session.json');
  if (!existsSync(legacy)) return null;
  const store = loadStore();
  const phone = store.activePhone || store.accounts[0]?.phone;
  if (!phone) return null;
  const target = sessionFileOf(phone);
  if (existsSync(target)) return null;
  try {
    writeFileSync(target, readFileSync(legacy));
    log.info(`已迁移旧登录态 → ${target.split('/').pop()}`);
    return target;
  } catch {
    return null;
  }
}

ensureDir();
migrateLegacySession();
