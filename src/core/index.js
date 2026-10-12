/**
 * 内核出口。这一层**不认识 three、也不认识 DOM** —— 全部规则都能在 Node 里跑完一整局,
 * 渲染层只是把这里的状态画出来。tests 里的分层守卫会检查这条约定没被破坏。
 */
export * from './polycube.js';
export * from './board.js';
export * from './game.js';
export * from './rng.js';
export * from './effects.js';
export * from './music.js';
export * from './modes.js';
export * from './progress.js';
