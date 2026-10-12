/**
 * 无渲染跑几局,把内核的真实表现打出来 —— 用来人眼确认「规则层自己是不是个像样的游戏」。
 *
 * 用一个简单的贪心机器人:枚举「所有旋转 × 所有水平落点」,在**井的副本**上试放,
 * 按「消层越多越好、堆得越低越好、空洞越少越好」打分,挑最好的落点硬降。
 * 注意这只用于**验收内核**:它不进游戏、不影响任何可玩内容,也不需要被端到端验证。
 *
 * 用法:node scripts/play-headless.mjs [种子] [局数]
 */
import {
  cellsFit, cloneBoard, countFilled, createGame, dropDistance, fullLayers, hardDrop,
  layerFillRatios, lockPiece, placeCells, rotatePiece, translateCells,
} from '../src/core/index.js';

const seed = Number(process.argv[2] ?? 20260412);
const games = Number(process.argv[3] ?? 3);

/** 返回当前方块所有可达的姿态(旋转不动位置,平移由调用方枚举) */
function orientations(game) {
  const base = { cells: game.piece.cells, pivot: game.piece.pivot };
  const out = [base];
  const seen = new Set([JSON.stringify(base.cells)]);
  // 广度优先地把 24 个姿态都走出来(每一层旋转都从已有姿态出发)
  let frontier = [base];
  for (let depth = 0; depth < 3; depth++) {
    const next = [];
    for (const state of frontier) {
      for (const axis of ['x', 'y', 'z']) {
        for (const dir of [1, -1]) {
          game.piece.cells = state.cells;
          game.piece.pivot = state.pivot;
          if (!rotatePiece(game, axis, dir)) continue;
          const key = JSON.stringify(game.piece.cells);
          if (seen.has(key)) continue;
          seen.add(key);
          const state2 = { cells: game.piece.cells, pivot: game.piece.pivot };
          out.push(state2);
          next.push(state2);
        }
      }
    }
    frontier = next;
  }
  game.piece.cells = base.cells;
  game.piece.pivot = base.pivot;
  return out;
}

/** 把方块落到某个水平位置,返回落点格子和「这么放好不好」的分数 */
function evaluate(game, cells, pivot) {
  if (!cellsFit(game.board, cells)) return null;
  const backup = { cells: game.piece.cells, pivot: game.piece.pivot };
  game.piece.cells = cells;
  game.piece.pivot = pivot;
  const distance = dropDistance(game);
  const landing = translateCells(cells, [0, -distance, 0]);
  game.piece.cells = backup.cells;
  game.piece.pivot = backup.pivot;

  const board = cloneBoard(game.board);
  placeCells(board, landing, 1);
  const layers = fullLayers(board).length;

  // 空洞:某一格是空的,但它正上方还有方块
  let holes = 0;
  for (let z = 0; z < board.depth; z++) {
    for (let x = 0; x < board.width; x++) {
      let filledAbove = false;
      for (let y = board.height - 1; y >= 0; y--) {
        const filled = board.cells[(y * board.depth + z) * board.width + x] !== 0;
        if (filled) filledAbove = true;
        else if (filledAbove) holes++;
      }
    }
  }
  const stack = layerFillRatios(board).reduce((best, r, y) => (r > 0 ? y + 1 : best), 0);
  const score = layers * 1000 - holes * 12 - stack * 3 + distance * 0.05;
  return { score, landing, layers, holes };
}

for (let n = 0; n < games; n++) {
  const game = createGame({ seed: seed + n });
  let placements = 0;

  while (game.status === 'playing' && placements < 500) {
    let best = null;
    for (const orientation of orientations(game)) {
      for (let dx = -5; dx <= 5; dx++) {
        for (let dz = -5; dz <= 5; dz++) {
          const cells = translateCells(orientation.cells, [dx, 0, dz]);
          const pivot = translateCells([orientation.pivot], [dx, 0, dz])[0];
          const result = evaluate(game, cells, pivot);
          if (result && (best === null || result.score > best.score)) {
            best = { ...result, cells, pivot };
          }
        }
      }
    }
    if (!best) break;

    game.piece.cells = best.cells;
    game.piece.pivot = best.pivot;
    hardDrop(game);
    placements++;
  }

  console.log(
    `第 ${n + 1} 局(种子 ${seed + n}):分数 ${game.score},消层 ${game.layers},等级 ${game.level},`
    + `方块 ${game.piecesPlaced}(单/双/三/四层 ${game.singles}/${game.doubles}/${game.triples}/${game.quads}),`
    + `井内剩余 ${countFilled(game.board)} 格,状态 ${game.status}`,
  );
  void lockPiece;
}
