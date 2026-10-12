/**
 * 难度模式。方块集、井的尺寸、下落速度、计分表都由模式决定 —— 规则层只认这些数字,
 * 不认识界面,所以每种模式都能在 Node 里跑完整对局做验证。
 *
 * 五立方体模式用的是内核里已经枚举好的 **29 种五立方体**(`enumerateFreePolycubes(5)`),
 * 比经典模式的 8 种四立方体难得多:块更大、姿态更多、井里更容易堆死。
 */

import { PENTACUBES, TETRACUBES } from './polycube.js';

export const MODES = Object.freeze({
  classic: {
    id: 'classic',
    label: '经典(4 格)',
    short: '经典',
    pieces: TETRACUBES,
    /*
     * 井的底面是 10×10(原先 5×5)。注意这一改**游戏性变化很大**:
     * 一层从 25 格变成 100 格,用四格方块填满一层最少要 25 个方块(原先 7 个),
     * 所以消层频率会低一个数量级 —— 这是尺寸本身的后果,不是 bug。
     * (scripts/play-headless.mjs 的无渲染机器人可以直接量出来。)
     */
    width: 10,
    depth: 10,
    height: 12,
    /** 基础下落间隔(秒),越大越慢 */
    baseFallInterval: 0.85,
    /** 一次消 1..4 层的基准分(还要乘等级) */
    scoreTable: [0, 100, 300, 700, 1500],
  },
  hard: {
    id: 'hard',
    label: '高难(5 格)',
    short: '高难',
    pieces: PENTACUBES,
    // 井的尺寸**刻意与经典模式一致**:难度差异全部来自方块本身(更大、姿态更多),
    // 而不是换一个井。这样切模式不需要重建渲染层,层数提示也一直有效。
    width: 10,
    depth: 10,
    height: 12,
    // 下落更慢一点,否则五格方块根本来不及看
    baseFallInterval: 1.15,
    scoreTable: [0, 140, 420, 980, 2100],
  },
});

export const MODE_IDS = Object.freeze(Object.keys(MODES));
export const DEFAULT_MODE_ID = 'classic';

/** 按 id 取模式;非法 id 一律退回默认模式(而不是抛错或返回 undefined) */
export function modeById(id) {
  return MODES[id] ?? MODES[DEFAULT_MODE_ID];
}

/**
 * 由模式生成一份完整的 rules(给 createGame 用)。
 * @param {string} id 模式 id
 * @param {object} [overrides] 额外覆盖(测试与调试用)
 */
export function rulesForMode(id, overrides = {}) {
  const mode = modeById(id);
  return {
    ...overrides,
    width: mode.width,
    depth: mode.depth,
    height: mode.height,
    pieces: mode.pieces,
    baseFallInterval: mode.baseFallInterval,
    scoreTable: [...mode.scoreTable],
    modeId: mode.id,
    modeLabel: mode.label,
  };
}

/** 下一个模式(界面上用一个键循环切换) */
export function nextModeId(id) {
  const index = MODE_IDS.indexOf(modeById(id).id);
  return MODE_IDS[(index + 1) % MODE_IDS.length];
}
