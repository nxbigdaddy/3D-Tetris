/**
 * 游戏状态机 —— 依然是纯逻辑,不碰 three、不碰 DOM,可以在 Node 里跑完整对局。
 *
 * 规则要点(和渲染完全解耦,所以每一条都能被单元测试钉死):
 *   - 井是三维的:x 宽、z 深、y 高;方块沿 -y 下落;
 *   - 消层 = **填满一整个 x-z 平面**(不是二维的一行),消完上面的东西整体塌落;
 *   - 方块可以绕三个轴旋转;旋转撞墙时会尝试一串「踢墙」偏移;
 *   - 落地不是立刻锁定:有一个短暂的锁定延迟,期间还能挪一下(手感关键)。
 */

import {
  cellsBounds,
  cloneCells,
  pivotForCells,
  rotateCellsAround,
  translateCells,
} from './polycube.js';
import {
  boardIsEmpty,
  cellsFit,
  clearLayers,
  createBoard,
  fullLayers,
  placeCells,
} from './board.js';
import { createRng } from './rng.js';
import { MODES } from './modes.js';

/**
 * 内核的默认规则。
 *
 * **井的尺寸与方块集都从经典模式取**,而不是在这里再写一遍 ——
 * 之前这里是第二份「5×5×12」,和 modes.js 里的定义各写各的,
 * 改尺寸时必须同时想起两个地方(实测就差点漏掉)。现在只有一个来源。
 */
export const DEFAULT_RULES = Object.freeze({
  width: MODES.classic.width,
  depth: MODES.classic.depth,
  height: MODES.classic.height,
  pieces: MODES.classic.pieces,
  baseFallInterval: MODES.classic.baseFallInterval,
  scoreTable: [...MODES.classic.scoreTable],
  /** 每消掉多少层升一级 */
  layersPerLevel: 4,
  /** 落地后的锁定延迟(秒):给玩家最后一次微调的机会 */
  lockDelay: 0.45,
  /** 一次落位最多允许重置几次锁定延迟(防止无限拖延) */
  maxLockResets: 12,
  /** 下落间隔随等级指数变快,但不会快过下限 */
  fallSpeedupPerLevel: 0.86,
  minFallInterval: 0.1,
  seed: 20260412,
});

/** 旋转撞墙时依次尝试的偏移 —— 顺序固定,所以结果可复现 */
const KICK_OFFSETS = Object.freeze([
  [0, 0, 0],
  [0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [0, 1, 1], [0, 1, -1], [0, -1, 1], [0, -1, -1],
  [1, 1, 1], [-1, 1, 1], [1, -1, 1], [-1, -1, 1],
  [1, 1, -1], [-1, 1, -1], [1, -1, -1], [-1, -1, -1],
]);

export function fallIntervalForLevel(level, rules = DEFAULT_RULES) {
  const n = Math.max(1, Math.floor(level));
  const raw = rules.baseFallInterval * rules.fallSpeedupPerLevel ** (n - 1);
  return Math.max(rules.minFallInterval, raw);
}

export function levelForLayers(layers, rules = DEFAULT_RULES) {
  const cleared = Math.max(0, Math.floor(layers));
  return 1 + Math.floor(cleared / rules.layersPerLevel);
}

export function scoreForClear(layerCount, level, rules = DEFAULT_RULES) {
  const index = Math.max(0, Math.min(rules.scoreTable.length - 1, Math.floor(layerCount)));
  return rules.scoreTable[index] * Math.max(1, Math.floor(level));
}

export function createGame(options = {}) {
  const rules = { ...DEFAULT_RULES, ...options };
  const board = createBoard(rules.width, rules.depth, rules.height);
  const game = {
    rules,
    board,
    rng: createRng(rules.seed),
    bag: [],
    /** 下一个方块的形状 id(给预览用) */
    nextId: null,
    piece: null,
    score: 0,
    layers: 0,
    level: 1,
    piecesPlaced: 0,
    singles: 0,
    doubles: 0,
    triples: 0,
    quads: 0,
    fallTimer: 0,
    lockTimer: 0,
    lockResets: 0,
    status: 'playing',
    events: [],
    time: 0,
  };
  game.nextId = drawFromBag(game);
  spawnPiece(game);
  return game;
}

function drawFromBag(game) {
  if (game.bag.length === 0) {
    game.bag = game.rng.shuffle(game.rules.pieces.map((piece) => piece.id));
  }
  return game.bag.pop();
}

function pieceById(game, id) {
  const found = game.rules.pieces.find((piece) => piece.id === id);
  if (!found) throw new Error(`方块集里没有 ${id}`);
  return found;
}

/** 方块在井顶居中的落点 */
export function spawnCellsFor(game, shape) {
  const bounds = cellsBounds(shape.cells);
  const x = Math.floor((game.rules.width - bounds.size[0]) / 2);
  const z = Math.floor((game.rules.depth - bounds.size[2]) / 2);
  const y = game.rules.height - bounds.size[1];
  return translateCells(shape.cells, [x, y, z]);
}

/** 生成下一个方块;如果连生成位置都被占了,直接判负 */
export function spawnPiece(game) {
  const id = game.nextId;
  const shape = pieceById(game, id);
  game.nextId = drawFromBag(game);

  const cells = spawnCellsFor(game, shape);
  if (!cellsFit(game.board, cells)) {
    game.piece = null;
    game.status = 'gameover';
    game.events.push({ type: 'gameover', reason: 'spawn-blocked' });
    return false;
  }

  game.piece = {
    id,
    color: colorForIndex(game, id),
    cells,
    pivot: pivotForCells(cells),
  };
  game.piecesPlaced++;
  game.fallTimer = 0;
  game.lockTimer = 0;
  game.lockResets = 0;
  game.events.push({ type: 'spawn', id });
  return true;
}

/** 颜色按方块在集合里的序号分配,保证同一形状永远同色(玩家能靠颜色认形状) */
function colorForIndex(game, id) {
  const index = game.rules.pieces.findIndex((piece) => piece.id === id);
  return (index % 7) + 1;
}

export function movePiece(game, delta) {
  if (game.status !== 'playing' || !game.piece) return false;
  const moved = translateCells(game.piece.cells, delta);
  if (!cellsFit(game.board, moved)) return false;

  game.piece.cells = moved;
  game.piece.pivot = translateCells([game.piece.pivot], delta)[0];
  // 挪动之后如果还贴着地,锁定延迟允许重置;但重置次数有上限
  if (isGrounded(game)) resetLockTimer(game);
  game.events.push({ type: 'move', delta: [...delta] });
  return true;
}

export function isGrounded(game) {
  if (!game.piece) return false;
  return !cellsFit(game.board, translateCells(game.piece.cells, [0, -1, 0]));
}

function resetLockTimer(game) {
  if (game.lockResets >= game.rules.maxLockResets) return;
  game.lockTimer = 0;
  game.lockResets++;
}

/**
 * 绕轴旋转。撞到东西时依次尝试 KICK_OFFSETS —— 三维里这个很重要:
 * 井只有 5×5,方块贴边是常态,不允许踢墙的话很多位置根本转不动。
 */
export function rotatePiece(game, axis, dir = 1) {
  if (game.status !== 'playing' || !game.piece) return false;
  const rotated = rotateCellsAround(game.piece.cells, axis, dir, game.piece.pivot);

  for (const offset of KICK_OFFSETS) {
    const candidate = offset[0] === 0 && offset[1] === 0 && offset[2] === 0
      ? rotated
      : translateCells(rotated, offset);
    if (!cellsFit(game.board, candidate)) continue;

    game.piece.cells = candidate;
    game.piece.pivot = translateCells([game.piece.pivot], offset)[0];
    if (isGrounded(game)) resetLockTimer(game);
    game.events.push({ type: 'rotate', axis, dir, kicked: offset.some((v) => v !== 0) });
    return true;
  }
  return false;
}

/** 方块再往下落几格(给落地投影用) */
export function dropDistance(game) {
  if (!game.piece) return 0;
  let distance = 0;
  for (;;) {
    const next = translateCells(game.piece.cells, [0, -(distance + 1), 0]);
    if (!cellsFit(game.board, next)) return distance;
    distance++;
  }
}

/** 落地投影:方块最终会落在哪里 —— 三维玩法的可玩性几乎全靠它 */
export function ghostCells(game) {
  if (!game.piece) return null;
  return translateCells(game.piece.cells, [0, -dropDistance(game), 0]);
}

export function softDrop(game) {
  if (game.status !== 'playing' || !game.piece) return false;
  const moved = movePiece(game, [0, -1, 0]);
  if (moved) {
    game.score += 1;
    game.fallTimer = 0;
  }
  return moved;
}

export function hardDrop(game) {
  if (game.status !== 'playing' || !game.piece) return false;
  const distance = dropDistance(game);
  if (distance > 0) {
    game.piece.cells = translateCells(game.piece.cells, [0, -distance, 0]);
    game.piece.pivot = translateCells([game.piece.pivot], [0, -distance, 0])[0];
    game.score += distance * 2;
  }
  lockPiece(game);
  return true;
}

/** 把当前方块写进井里,然后处理消层 */
export function lockPiece(game) {
  if (!game.piece) return null;
  const { cells, color, id } = game.piece;
  placeCells(game.board, cells, color);
  game.piece = null;
  game.events.push({ type: 'lock', id, cells: cloneCells(cells) });

  const layers = fullLayers(game.board);
  if (layers.length > 0) {
    /*
     * 先把「被消掉了哪些格子、什么颜色」记下来,再真正清层。
     * 为什么必须在这里记:清层是不可逆的,而渲染层要做「逐格碎裂」的动画 ——
     * 如果不带出去,视图层就只能整层闪一下(或者自己去猜颜色,那是把规则抄了两遍)。
     */
    const clearedCells = [];
    for (const y of layers) {
      for (let z = 0; z < game.board.depth; z++) {
        for (let x = 0; x < game.board.width; x++) {
          clearedCells.push({ x, y, z, color: game.board.cells[(y * game.board.depth + z) * game.board.width + x] });
        }
      }
    }

    clearLayers(game.board, layers);
    game.layers += layers.length;
    game.score += scoreForClear(layers.length, game.level);
    if (layers.length === 1) game.singles++;
    else if (layers.length === 2) game.doubles++;
    else if (layers.length === 3) game.triples++;
    else game.quads++;

    const newLevel = levelForLayers(game.layers, game.rules);
    if (newLevel > game.level) {
      game.level = newLevel;
      game.events.push({ type: 'levelup', level: newLevel });
    }
    game.events.push({
      type: 'clear',
      layers,
      count: layers.length,
      score: scoreForClear(layers.length, game.level),
      cells: clearedCells,
    });
  }

  spawnPiece(game);
  return layers;
}

/**
 * 排空事件队列。**必须由消费方(界面)调用**。
 *
 * 为什么不让 updateGame 自己清:`硬降`「旋转」这些是按键处理里**直接**调用内核的,
 * 它们产生的事件如果在下一次 updateGame 开头被清掉,界面就永远收不到 ——
 * 实测现象是「井口已经堆满、状态已经是 gameover,遮罩却还停在暂停」。
 */
export function drainEvents(game) {
  const events = game.events;
  game.events = [];
  return events;
}

/**
 * 推进时间。返回当前事件队列(不清空,由 drainEvents 负责排空)。
 * @param {number} dt 秒
 */
export function updateGame(game, dt) {
  if (game.status !== 'playing') return game.events;

  const step = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
  game.time += step;
  if (!game.piece) return game.events;

  const interval = fallIntervalForLevel(game.level, game.rules);

  if (isGrounded(game)) {
    // 已经贴地:走锁定延迟,而不是马上下落
    game.lockTimer += step;
    if (game.lockTimer >= game.rules.lockDelay) lockPiece(game);
    return game.events;
  }

  game.lockTimer = 0;
  game.fallTimer += step;
  while (game.fallTimer >= interval) {
    game.fallTimer -= interval;
    if (!movePiece(game, [0, -1, 0])) break;
    game.events.push({ type: 'fall' });
  }
  return game.events;
}

/** 井是不是空的(用来判断「开局即完美」之类) */
export function boardClear(game) {
  return boardIsEmpty(game.board);
}
