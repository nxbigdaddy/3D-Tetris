/**
 * 入口:把内核状态、输入、渲染、HUD 接起来。
 * 规则一行都不在这里 —— 这里只做「把状态画出来」和「把按键翻译成内核调用」。
 */

import * as THREE from 'three';
import {
  createGame, updateGame, movePiece, rotatePiece, hardDrop, softDrop,
  ghostCells, dropDistance, fallIntervalForLevel, layerFillRatios, drainEvents, DEFAULT_RULES,
  createShake, addShake, stepShake, burstParticles, stepParticles, particleCount, intensityFor,
  MODES, modeById, nextModeId, rulesForMode, emptyProgress, loadProgress, saveProgress, pickStorage, recordRun,
} from './core/index.js';
import { createView } from './game/render.js';
import { createAudio } from './game/audio.js';
import './style.css';

const canvas = document.getElementById('scene');
const scoreEl = document.getElementById('score');
const layersEl = document.getElementById('layers');
const levelEl = document.getElementById('level');
const nextEl = document.getElementById('next');
const bestEl = document.getElementById('best');
const modeEl = document.getElementById('mode');
const barsEl = document.getElementById('layersBars');
const toastEl = document.getElementById('toast');
const overlayEl = document.getElementById('overlay');
const overlayTitleEl = document.getElementById('overlayTitle');
const overlayTextEl = document.getElementById('overlayText');
const overlayButtonEl = document.getElementById('overlayButton');

/**
 * 存储与成绩:存储是可注入的,拿不到 localStorage 时自动退回内存版(隐私模式、file:// 限制等)。
 * 成绩读取时全量 sanitize,所以旧版本/手改/别的游戏留下的同名键都不会把游戏搞崩。
 */
const storage = pickStorage();
let progress = loadProgress(storage);
let modeId = progress.lastMode;

const view = createView(canvas, modeById(modeId));
const audio = createAudio();

/** 打击感状态:震屏 + 粒子(数据在 core/effects.js 里算,这里只负责驱动与绘制) */
const shake = createShake();
let particles = [];
let rngSeed = 1;

let game = createGame({ ...rulesForMode(modeId), seed: (Date.now() % 100000) | 0 });
let paused = false;
let started = false;
let softDropping = false;
let toastTimer = 0;

/** 各层填充率的柱条:一次性建好,切换模式(井高可能不同)时重建 */
let layerRows = [];

function buildLayerRows() {
  barsEl.innerHTML = '';
  layerRows = [];
  for (let y = 0; y < game.rules.height; y++) {
    const row = document.createElement('div');
    row.className = 'layerRow';
    row.innerHTML = `<span class="idx">${y}</span><span class="bar"><span class="fill"></span></span>`;
    barsEl.appendChild(row);
    layerRows.push({ row, fill: row.querySelector('.fill') });
  }
}

function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.remove('hidden');
  toastTimer = 1.4;
}

let hudSignature = '';

function updateHud() {
  // 每帧都调用,但只在内容真的变了的时候才写 DOM。
  // 为什么必须每帧:硬降/旋转是**按键处理里直接调用内核**的,它们产生的事件会在下一次
  // updateGame 开头被清空,那时再刷新就已经晚了 —— 现象就是「硬降之后 HUD 的分数不动」。
  const signature = `${game.score}|${game.layers}|${game.level}|${game.nextId}|${game.status}`;
  if (signature === hudSignature) return;
  hudSignature = signature;

  scoreEl.textContent = String(game.score);
  layersEl.textContent = String(game.layers);
  levelEl.textContent = String(game.level);
  nextEl.textContent = game.nextId ?? '—';
  bestEl.textContent = String(progress.best[modeId] ?? 0);
  modeEl.textContent = modeById(modeId).short;

  const ratios = layerFillRatios(game.board);
  ratios.forEach((ratio, y) => {
    const entry = layerRows[y];
    if (!entry) return;
    entry.fill.style.width = `${Math.round(ratio * 100)}%`;
    entry.row.classList.toggle('full', ratio >= 1);
  });
}

function showOverlay(title, text, button) {
  overlayTitleEl.textContent = title;
  overlayTextEl.textContent = text;
  overlayButtonEl.textContent = button;
  overlayEl.classList.remove('hidden');
}

function hideOverlay() {
  overlayEl.classList.add('hidden');
}

function restart(seed) {
  // 无论从哪条路径开局(按钮、空格、R 键),都算「引导已经看过」
  if (!progress.seenTutorial) {
    progress = { ...progress, seenTutorial: true };
    saveProgress(storage, progress);
  }
  game = createGame({ ...rulesForMode(modeId), seed: seed ?? ((Math.random() * 100000) | 0) });
  buildLayerRows();
  paused = false;
  started = true;
  hideOverlay();
  updateHud();
}

/** 切换难度模式。会重开一局 —— 换方块集中途接着打没有意义 */
function setMode(id) {
  modeId = modeById(id).id;
  progress = { ...progress, lastMode: modeId };
  saveProgress(storage, progress);
  syncModeButton();
  restart();
  toast(`模式:${modeById(modeId).label}`);
}

/** 一局结束:记成绩、存盘,并把结果写给玩家看 */
function finishRun() {
  const { progress: next, record } = recordRun(progress, {
    mode: modeId, score: game.score, layers: game.layers,
  });
  progress = next;
  const saved = saveProgress(storage, progress);
  const best = progress.best[modeId];
  const note = saved ? '' : '(成绩无法写入本机存储,本次记录只在本页有效)';
  showOverlay(
    record.score ? '新纪录!' : '堆到井口了',
    `分数 ${game.score} · 消层 ${game.layers} · 等级 ${game.level} · 最高分 ${best} ${note}`.trim(),
    '再来一局',
  );
}

// ---------------------------------------------------------------- 输入

/**
 * 全部可执行动作**只在这里定义一次**:键盘与屏幕按键都调 doAction(名字)。
 * 两套逻辑各写一遍必然漂移(移动端少一次踢墙、桌面端少一次音效之类)。
 */
const ACTIONS = {
  left: () => movePiece(game, [-1, 0, 0]),
  right: () => movePiece(game, [1, 0, 0]),
  forward: () => movePiece(game, [0, 0, -1]),
  back: () => movePiece(game, [0, 0, 1]),
  yawLeft: () => rotatePiece(game, 'y', 1),
  yawRight: () => rotatePiece(game, 'y', -1),
  pitchUp: () => rotatePiece(game, 'x', 1),
  pitchDown: () => rotatePiece(game, 'x', -1),
  rollLeft: () => rotatePiece(game, 'z', 1),
  rollRight: () => rotatePiece(game, 'z', -1),
  hardDrop: () => {
    const distance = dropDistance(game);
    hardDrop(game);
    if (distance > 0) toast(`硬降 ${distance} 格`);
  },
  softDrop: () => softDrop(game),
  pause: () => {
    if (!started) return;
    paused = !paused;
    audio.play('pause');
    if (paused) showOverlay('已暂停', '按 P 或点下面的按钮继续。', '继续');
    else hideOverlay();
  },
  restart: () => { restart(); toast('已重开'); },
  mute: () => { audio.unlock(); audio.setMuted(!audio.isMuted()); syncMuteButton(); },
  resetCamera: () => { view.resetCamera(); toast('视角已复位'); },
  modeClassic: () => { if (modeId !== 'classic') setMode('classic'); },
  modeHard: () => { if (modeId !== 'hard') setMode('hard'); },
  modeNext: () => setMode(nextModeId(modeId)),
};

/** 这些动作需要一个正在进行的对局 */
const NEEDS_PLAYING = new Set(['left', 'right', 'forward', 'back', 'yawLeft', 'yawRight',
  'pitchUp', 'pitchDown', 'rollLeft', 'rollRight', 'hardDrop', 'softDrop']);

function doAction(name) {
  const action = ACTIONS[name];
  if (!action) return false;
  if (NEEDS_PLAYING.has(name) && (!started || paused)) return false;
  action();
  return true;
}

/** 键盘 → 动作名(和屏幕按键共用同一张表) */
const KEY_ACTIONS = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'forward',
  ArrowDown: 'back',
  KeyQ: 'yawLeft',
  KeyE: 'yawRight',
  KeyW: 'pitchUp',
  KeyS: 'pitchDown',
  KeyA: 'rollLeft',
  KeyD: 'rollRight',
  KeyP: 'pause',
  KeyR: 'restart',
  KeyM: 'mute',
  Digit1: 'modeClassic',
  Digit2: 'modeHard',
};

window.addEventListener('keydown', (event) => {
  // 浏览器要求音频必须由用户手势唤醒;音乐也跟着开始
  if (audio.unlock()) audio.startMusic();
  if (event.repeat && !(event.code === 'ShiftLeft' || event.code === 'ShiftRight')) return;

  if (event.code === 'Space' || event.code === 'Enter') {
    event.preventDefault();
    if (!started) { doAction('restart'); return; }
    if (paused) { doAction('pause'); return; }
    doAction('hardDrop');
    return;
  }
  if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
    softDropping = true;
    return;
  }

  const action = KEY_ACTIONS[event.code];
  if (action) {
    event.preventDefault();
    doAction(action);
  }
});

window.addEventListener('keyup', (event) => {
  if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') softDropping = false;
});

// 屏幕按键(手机):和键盘完全同一条通道
for (const button of document.querySelectorAll('#touchPad button')) {
  const action = button.dataset.action;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    audio.unlock();
    audio.startMusic();
    button.blur();
    doAction(action);
  });
}

overlayButtonEl.addEventListener('click', () => {
  if (!started) restart();
  else { paused = false; hideOverlay(); }
});

document.getElementById('pause').addEventListener('click', () => doAction('pause'));

document.getElementById('restart').addEventListener('click', () => doAction('restart'));

const muteButton = document.getElementById('mute');
function syncMuteButton() { muteButton.textContent = audio.isMuted() ? '音效关 (M)' : '音效开 (M)'; }
muteButton.addEventListener('click', () => doAction('mute'));
syncMuteButton();

document.getElementById('camera').addEventListener('click', () => doAction('resetCamera'));

const modeButton = document.getElementById('modeButton');
function syncModeButton() {
  modeButton.textContent = `模式:${modeById(modeId).short} (1/2)`;
}
modeButton.addEventListener('click', () => doAction('modeNext'));
syncModeButton();

// 拖拽转视角 / 滚轮缩放
let dragging = null;
canvas.addEventListener('pointerdown', (event) => {
  dragging = { id: event.pointerId, x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', (event) => {
  if (!dragging || event.pointerId !== dragging.id) return;
  const dx = event.clientX - dragging.x;
  const dy = event.clientY - dragging.y;
  dragging.x = event.clientX;
  dragging.y = event.clientY;
  view.orbitBy(dx * 0.006, dy * 0.005);
});
const endDrag = (event) => {
  if (dragging && event.pointerId === dragging.id) dragging = null;
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  view.zoomBy(event.deltaY > 0 ? 1.08 : 0.92);
}, { passive: false });

function applySafeArea() {
  const pad = document.getElementById('touchPad');
  const padHeight = pad && getComputedStyle(pad).display !== 'none'
    ? window.innerHeight - pad.getBoundingClientRect().top
    : 0;
  view.setSafeArea(padHeight / window.innerHeight);
}

window.addEventListener('resize', () => { view.resize(); applySafeArea(); });

/**
 * 切出窗口/切到别的标签页时自动暂停。
 * 不这么做的话,玩家去回一条消息回来就发现已经输了 —— 这是实际的体验问题,不是洁癖。
 */
function autoPause(reason) {
  if (!started || paused) return;
  paused = true;
  audio.play('pause');
  showOverlay('已暂停', `${reason}。按 P 或点下面的按钮继续。`, '继续');
}

window.addEventListener('blur', () => autoPause('窗口失去焦点,已自动暂停'));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) autoPause('标签页切到后台,已自动暂停');
});

// ---------------------------------------------------------------- 主循环

let lastTime = performance.now();
/** 有待处理的像素采样请求(必须等下一帧渲染完再读) */
let pendingSample = null;
/** 请求一帧的像素统计 */
function requestSample() {
  return new Promise((resolve) => { pendingSample = resolve; });
}

function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (toastTimer > 0) {
    toastTimer -= dt;
    if (toastTimer <= 0) toastEl.classList.add('hidden');
  }

  if (started && !paused) {
    if (softDropping) softDrop(game);
    updateGame(game, dt);
  }

  // 事件队列**每帧都要排空**:不管游戏是否在跑、也不管事件是时间推进产生的
  // 还是按键/调试接口直接调用内核产生的。放在这里才不会漏掉「按键导致结束」这类事件。
  {
    const events = drainEvents(game);
    for (const event of events) {
      if (event.type === 'clear') {
        view.flashLayers(event.layers);
        // 逐格碎裂:内核已经把「消掉了哪些格、什么颜色」带出来了,这里直接用
        if (event.cells) view.shatterCells(event.cells);
        // 粒子:每格炸出几块,颜色取自被消的那一层
        for (const y of event.layers) {
          const cells = [];
          for (let z = 0; z < DEFAULT_RULES.depth; z++) {
            for (let x = 0; x < DEFAULT_RULES.width; x++) cells.push([x, y, z]);
          }
          const color = 1 + ((game.layers + y) % 7);
          particles = particles.concat(burstParticles(cells, color, rngSeed++, 2));
        }
        addShake(shake, Math.min(0.45, 0.16 + event.count * 0.1));
        audio.clearLayers(event.count);
        toast(event.count >= 3 ? `${event.count} 层一起消!+${event.score}` : `消掉 ${event.count} 层 +${event.score}`);
        updateHud();
      } else if (event.type === 'levelup') {
        audio.play('levelup');
        toast(`等级 ${event.level}`);
        updateHud();
      } else if (event.type === 'lock') {
        audio.play('lock');
        addShake(shake, 0.07);
      } else if (event.type === 'rotate') {
        audio.play('rotate');
      } else if (event.type === 'move') {
        audio.play('move');
      } else if (event.type === 'gameover') {
        started = false;
        audio.play('gameover');
        addShake(shake, 0.5);
        // 记成绩、存盘、把「最高分 / 新纪录」写给玩家看 —— 全部在 finishRun 里
        finishRun();
      }
    }
  }

  view.updateEffects(dt);
  stepParticles(particles, dt, { floorY: 0 });
  const shakeFrame = stepShake(shake, dt);

  // 音乐紧张度:等级 + 井里堆得多高 —— 都来自纯函数(core/music.js),有单元测试
  const fill = Math.max(...layerFillRatios(game.board));
  audio.setIntensity(intensityFor({ level: game.level, fill }));
  audio.updateMusic();

  view.render(game, {
    ghost: started && !paused ? ghostCells(game) : null,
    particles,
    shake: shakeFrame,
  });
  updateHud();

  // 采样:必须在**渲染的同一帧里**读像素。
  // 帧外调用 readPixels 拿到的是已经提交/清空的缓冲(实测只读出一种颜色),
  // 那是验证方法的坑,不是渲染的坑。
  if (pendingSample) {
    const resolve = pendingSample;
    pendingSample = null;
    try {
      resolve(samplePixels());
    } catch (error) {
      resolve({ error: String(error) });
    }
  }

  requestAnimationFrame(frame);
}

/** 读一帧的像素,统计颜色种类(端到端用来判断「真的在出图」) */
function samplePixels() {
  const gl = view.renderer.getContext();
  const w = view.renderer.domElement.width;
  const h = view.renderer.domElement.height;
  const data = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
  const colors = new Set();
  let nonBackground = 0;
  for (let i = 0; i < data.length; i += 4 * 53) {
    colors.add(`${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`);
    if (data[i] > 40 || data[i + 1] > 40 || data[i + 2] > 60) nonBackground++;
  }
  return { distinct: colors.size, nonBackground, width: w, height: h };
}

buildLayerRows();
/**

 * 新手引导:三维规则和二维经验冲突,不说明会看不懂 ——
 * 「为什么我填满一行没消?」是第一次玩的人必然会问的问题。
 * 只在第一次打开时出现,之后写进存档不再打扰。
 */
function showTutorialIfNeeded() {
  if (progress.seenTutorial) return false;
  showOverlay(
    '欢迎玩 3D 俄罗斯方块',
    '规则和二维版不一样,先看三条:①【填满一整个水平层】才会消除,不是填满一行;'
    + '②方块可以绕三个轴旋转 —— Q/E 偏航、W/S 俯仰、A/D 翻滚,别怕转不过来;'
    + '③左边那排「各层填充」告诉你还差几格就消层 —— 三维里光看画面是看不出来的。'
    + '按空格或点下面的按钮开始。',
    '知道了,开始',
  );
  return true;
}

applySafeArea();
updateHud();
if (!showTutorialIfNeeded()) {
  showOverlay('3D 俄罗斯方块', '填满一整个水平层才能消除。方块可以绕三个轴旋转,贴边时会自动踢墙。按空格开始。', '开始');
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- 调试接口(端到端验证用)

window.__BLOCKOUT__ = {
  version: 1,
  state: () => ({
    score: game.score,
    layers: game.layers,
    level: game.level,
    piecesPlaced: game.piecesPlaced,
    status: game.status,
    started,
    paused,
    nextId: game.nextId,
    pieceId: game.piece?.id ?? null,
    /** 井的尺寸 —— 端到端脚本必须按它铺层,不能写死 5×5(井一改尺寸就会假失败) */
    dims: { width: game.rules.width, depth: game.rules.depth, height: game.rules.height },
    /** 方块**坐标**(不是数量)—— 验证「按键真的让方块动了」必须用坐标 */
    cells: game.piece ? game.piece.cells.map((c) => [...c]) : null,
    pieceCellCount: game.piece?.cells?.length ?? 0,
    filled: Array.from(game.board.cells).filter((v) => v !== 0).length,
    fullLayers: layerFillRatios(game.board).filter((r) => r >= 1).length,
    fillRatios: layerFillRatios(game.board),
    fallInterval: fallIntervalForLevel(game.level),
  }),
  ghost: () => ghostCells(game),
  /** 采样一帧的像素统计(必须走这个接口:帧外读 WebGL 缓冲是读不到的) */
  samplePixels: () => requestSample(),
  dropDistance: () => dropDistance(game),
  hardDrop: () => hardDrop(game),
  move: (d) => movePiece(game, d),
  rotate: (axis, dir) => rotatePiece(game, axis, dir),
  start: (seed) => restart(seed),
  /** 直接把方块摆到指定格子(测试用,绕过输入) */
  setPieceCells: (cells) => {
    if (!game.piece) return false;
    game.piece.cells = cells.map((c) => [...c]);
    game.piece.pivot = [
      Math.floor((Math.min(...cells.map((c) => c[0])) + Math.max(...cells.map((c) => c[0]))) / 2),
      Math.floor((Math.min(...cells.map((c) => c[1])) + Math.max(...cells.map((c) => c[1]))) / 2),
      Math.floor((Math.min(...cells.map((c) => c[2])) + Math.max(...cells.map((c) => c[2]))) / 2),
    ];
    return true;
  },
  /** 把井里的格子直接设成指定颜色(测试消层用) */
  setBoardCell: (x, y, z, value) => {
    const { board } = game;
    if (x < 0 || x >= board.width || y < 0 || y >= board.height || z < 0 || z >= board.depth) return false;
    board.cells[(y * board.depth + z) * board.width + x] = value;
    return true;
  },
  /** 迭代一个方块的所有姿态,给「能不能转」这类断言用 */
  orientations: () => {
    if (!game.piece) return 0;
    const seen = new Set();
    const stack = [{ cells: game.piece.cells, pivot: game.piece.pivot }];
    const base = { cells: game.piece.cells, pivot: game.piece.pivot };
    seen.add(JSON.stringify(base.cells));
    while (stack.length > 0) {
      const state = stack.pop();
      for (const axis of ['x', 'y', 'z']) {
        for (const dir of [1, -1]) {
          game.piece.cells = state.cells;
          game.piece.pivot = state.pivot;
          if (!rotatePiece(game, axis, dir)) continue;
          const key = JSON.stringify(game.piece.cells.map((c) => c.join(',')).sort());
          if (seen.has(key)) continue;
          seen.add(key);
          stack.push({ cells: game.piece.cells, pivot: game.piece.pivot });
        }
      }
    }
    game.piece.cells = base.cells;
    game.piece.pivot = base.pivot;
    return seen.size;
  },
  camera: () => ({ ...view.orbit }),
  audio: () => ({
    muted: audio.isMuted(),
    unlocked: audio.isUnlocked(),
    context: audio.state(),
    intensity: audio.intensity(),
    bar: audio.barIndex(),
  }),
  effects: () => ({ particles: particleCount(particles), shake: shake.magnitude }),
  mode: () => ({ id: modeId, label: modeById(modeId).label, pieces: game.rules.pieces.length }),
  setMode: (id) => { setMode(id); return modeId; },
  progress: () => JSON.parse(JSON.stringify(progress)),
  shards: () => view.shardCount(),
  best: () => progress.best[modeId],
  /** 直接把当前这一局判负,用来验证成绩记录(不依赖真堆满) */
  forceGameOver: () => {
    if (game.status !== 'playing') return false;
    game.status = 'gameover';
    started = false;
    game.events.push({ type: 'gameover', reason: 'forced' });
    return true;
  },
  /**
   * 方井在屏幕上的投影范围(NDC)。
   * 取景对不对**由端到端断言**,不靠肉眼看截图 —— 上一个项目的教训:
   * 手推的相机常数先后错过两次(火箭被裁、西瓜藏进 HUD)。
   */
  wellNDC: () => view.wellNDC(),
  THREE,
};
