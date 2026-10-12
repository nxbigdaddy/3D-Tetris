/**
 * 打击感的**纯数学**部分:震屏与粒子。
 *
 * 为什么放在 core 而不是渲染层:这两件事全是数值运算(衰减、重力、生命周期),
 * 放在这里就能用单元测试钉死「震屏必须收敛到 0」「粒子必须会过期」「不能出 NaN」这类不变量,
 * 而不是靠在浏览器里盯着看。渲染层只负责把结果画出来。
 */

import { createRng } from './rng.js';

/** 震屏:一次冲击给一个随时间衰减的偏移 */
export function createShake() {
  return { magnitude: 0, decay: 6.5, phase: 0, total: 0 };
}

/**
 * 施加一次冲击。多次冲击取**较大值**而不是累加 —— 累加会让连续消层把画面晃到看不清。
 */
export function addShake(shake, magnitude) {
  if (!Number.isFinite(magnitude) || magnitude <= 0) return shake;
  shake.magnitude = Math.min(0.6, Math.max(shake.magnitude, magnitude));
  shake.total += magnitude;
  return shake;
}

/** 推进一帧,返回这一帧的相机偏移(已按衰减缩放) */
export function stepShake(shake, dt) {
  const step = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
  shake.magnitude *= Math.exp(-shake.decay * step);
  if (shake.magnitude < 1e-4) shake.magnitude = 0;
  shake.phase += step * 42;

  // 用两个不同频率的正弦叠出「不规律」的抖动,并且保证是 0 均值的
  const m = shake.magnitude;
  return {
    x: Math.sin(shake.phase) * m,
    y: Math.sin(shake.phase * 1.7 + 1.1) * m * 0.7,
    z: Math.cos(shake.phase * 1.3) * m * 0.6,
    magnitude: m,
  };
}

/**
 * 某个格子被消掉时炸出的碎块。
 * @param {number[][]} cells 被消掉的格子
 * @param {number} color 颜色编号
 * @param {number} seed 随机种子(保证可复现)
 * @param {number} perCell 每格炸出几个
 */
export function burstParticles(cells, color, seed = 1, perCell = 3) {
  const rng = createRng(seed);
  const list = [];
  const count = Math.max(0, Math.min(6, Math.floor(perCell)));
  for (const [x, y, z] of cells) {
    for (let i = 0; i < count; i++) {
      list.push({
        x: x + 0.5 + (rng.next() - 0.5) * 0.8,
        y: y + 0.5 + rng.next() * 0.6,
        z: z + 0.5 + (rng.next() - 0.5) * 0.8,
        vx: (rng.next() - 0.5) * 5.5,
        vy: 1.5 + rng.next() * 5,
        vz: (rng.next() - 0.5) * 5.5,
        life: 0.45 + rng.next() * 0.5,
        age: 0,
        size: 0.12 + rng.next() * 0.16,
        color,
      });
    }
  }
  return list;
}

export const PARTICLE_GRAVITY = 15;
export const MAX_PARTICLES = 900;

/** 推进粒子:重力、寿命、出界剔除。就地修改并返回同一个数组(渲染层每帧都要用) */
export function stepParticles(list, dt, options = {}) {
  const step = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
  const gravity = Number.isFinite(options.gravity) ? options.gravity : PARTICLE_GRAVITY;
  const floorY = Number.isFinite(options.floorY) ? options.floorY : 0;

  let write = 0;
  for (let read = 0; read < list.length; read++) {
    const p = list[read];
    p.age += step;
    if (p.age >= p.life) continue;

    p.vy -= gravity * step;
    p.x += p.vx * step;
    p.y += p.vy * step;
    p.z += p.vz * step;
    if (p.y < floorY) {
      p.y = floorY;
      p.vy *= -0.35;
      p.vx *= 0.7;
      p.vz *= 0.7;
    }
    list[write++] = p;
  }
  list.length = write;
  return list;
}

export function particleCount(list) {
  return list.length;
}

/** 粒子的剩余寿命比例(渲染层拿它做淡出) */
export function particleFade(p) {
  const t = p.life > 0 ? p.age / p.life : 1;
  return Math.max(0, Math.min(1, 1 - t));
}
