/**
 * 本机成绩与统计。
 *
 * 设计原则和上一个项目一致:**所有输入都当作脏数据**。存档可能来自旧版本、手改、或者
 * 上一个游戏留下的同名键 —— 任何一条脏数据都不能让游戏崩,也不能悄悄把成绩变成 NaN。
 * 所以读写都要过一遍 sanitize,而且**读进来的任何异常都被吞掉**。
 *
 * 存储是可注入的(默认用 localStorage,不可用时退回内存版),
 * 这样这一层在 Node 里也能完整测试,不需要浏览器。
 */

import { DEFAULT_MODE_ID, MODE_IDS } from './modes.js';

export const PROGRESS_KEY = 'blockout3d.progress.v1';
const VERSION = 1;

export function emptyProgress() {
  const best = {};
  const bestLayers = {};
  for (const id of MODE_IDS) {
    best[id] = 0;
    bestLayers[id] = 0;
  }
  return {
    version: VERSION,
    best,
    bestLayers,
    games: 0,
    /** 是否看过新手引导 —— 只让第一次玩的人看到说明 */
    seenTutorial: false,
    totalLayers: 0,
    totalScore: 0,
    lastMode: DEFAULT_MODE_ID,
  };
}

function toCount(value, fallback = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/** 把任意东西洗成一份合法成绩。**永远不抛错。** */
export function sanitizeProgress(raw) {
  const clean = emptyProgress();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return clean;

  for (const id of MODE_IDS) {
    clean.best[id] = toCount(raw.best?.[id]);
    clean.bestLayers[id] = toCount(raw.bestLayers?.[id]);
  }
  clean.games = toCount(raw.games);
  clean.seenTutorial = raw.seenTutorial === true;
  clean.totalLayers = toCount(raw.totalLayers);
  clean.totalScore = toCount(raw.totalScore);
  clean.lastMode = MODE_IDS.includes(raw.lastMode) ? raw.lastMode : DEFAULT_MODE_ID;
  return clean;
}

/**
 * 记一局的结果。
 * @returns {{progress:object, record:{score:boolean, layers:boolean}}}
 */
export function recordRun(progress, { mode, score, layers } = {}) {
  const clean = sanitizeProgress(progress);
  const id = MODE_IDS.includes(mode) ? mode : clean.lastMode;
  const runScore = toCount(score);
  const runLayers = toCount(layers);

  const record = {
    score: runScore > clean.best[id],
    layers: runLayers > clean.bestLayers[id],
  };
  if (record.score) clean.best[id] = runScore;
  if (record.layers) clean.bestLayers[id] = runLayers;
  clean.games += 1;
  clean.totalLayers += runLayers;
  clean.totalScore += runScore;
  clean.lastMode = id;
  return { progress: clean, record };
}

/** 内存版存储:Node 测试与浏览器禁用存储时的兜底 */
export function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    get size() { return map.size; },
  };
}

/** 挑一个能用的存储:浏览器 localStorage 优先(隐私模式下可能直接抛错),否则内存版 */
export function pickStorage(candidate) {
  const store = candidate ?? (typeof globalThis !== 'undefined' ? globalThis.localStorage : undefined);
  if (!store) return createMemoryStorage();
  try {
    const probe = '__blockout_probe__';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return createMemoryStorage();
  }
}

export function loadProgress(storage, key = PROGRESS_KEY) {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return emptyProgress();
    return sanitizeProgress(JSON.parse(raw));
  } catch {
    // 解析失败(手改、旧格式、被别的程序写过)就当作没有存档,而不是崩掉
    return emptyProgress();
  }
}

/** @returns {boolean} 是否真的写进去了(没有存储、配额满、隐私模式都会返回 false) */
export function saveProgress(storage, progress, key = PROGRESS_KEY) {
  // 注意:没有存储时必须返回 false。只靠 try/catch 会漏掉这一种情况 ——
  // `storage?.setItem(...)` 在没有存储时安静地什么也不做,然后返回 true,
  // 调用方会以为存好了(测试就是这么抓出来的)。
  if (!storage || typeof storage.setItem !== 'function') return false;
  try {
    storage.setItem(key, JSON.stringify(sanitizeProgress(progress)));
    return true;
  } catch {
    return false;
  }
}
