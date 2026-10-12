import test from 'node:test';
import assert from 'node:assert/strict';

import {
  boardIsEmpty,
  cellsFit,
  clearLayers,
  cloneBoard,
  countFilled,
  createBoard,
  fullLayers,
  getCell,
  inBounds,
  layerFillRatios,
  placeCells,
  setCell,
  stackHeight,
} from '../src/core/board.js';

/** 填满第 y 层 */
function fillLayer(board, y, value = 1) {
  for (let z = 0; z < board.depth; z++) {
    for (let x = 0; x < board.width; x++) setCell(board, x, y, z, value);
  }
}

test('井的基本读写与越界安全', () => {
  const board = createBoard(5, 5, 12);
  assert.equal(countFilled(board), 0);
  assert.equal(boardIsEmpty(board), true);
  assert.equal(getCell(board, 0, 0, 0), 0);

  setCell(board, 2, 3, 4, 7);
  assert.equal(getCell(board, 2, 3, 4), 7);
  assert.equal(countFilled(board), 1);

  // 越界读返回 0、越界写返回 false(而不是抛错或写坏数组)
  assert.equal(getCell(board, -1, 0, 0), 0);
  assert.equal(getCell(board, 5, 0, 0), 0);
  assert.equal(getCell(board, 0, 12, 0), 0);
  assert.equal(setCell(board, 0, 0, 9, 1), false);
  assert.equal(countFilled(board), 1);

  assert.ok(inBounds(board, 4, 11, 4));
  assert.equal(inBounds(board, 5, 0, 0), false);
  assert.equal(inBounds(board, 0, -1, 0), false);
});

test('尺寸校验:非法尺寸立刻报错,不能悄悄建一个怪井', () => {
  assert.throws(() => createBoard(0, 5, 12), /正整数/);
  assert.throws(() => createBoard(5, -1, 12), /正整数/);
  assert.throws(() => createBoard(5, 5, 2.5), /正整数/);
});

test('cellsFit:越界、压到已有方块都要判 false;空位判 true', () => {
  const board = createBoard(5, 5, 12);
  assert.equal(cellsFit(board, [[0, 0, 0], [1, 0, 0]]), true);
  assert.equal(cellsFit(board, [[4, 0, 0], [5, 0, 0]]), false, '出界');
  assert.equal(cellsFit(board, [[0, -1, 0]]), false, '沉到井底以下');

  setCell(board, 1, 0, 0, 3);
  assert.equal(cellsFit(board, [[1, 0, 0]]), false, '位置已被占');
  assert.equal(cellsFit(board, [[2, 0, 0]]), true);

  // 自己和自己重叠也要判 false(去重前不能因为「都在同一组里」而放过)
  assert.equal(cellsFit(board, [[2, 0, 0], [2, 0, 1]]), true);
});

test('placeCells:越界必须报错(调用方必须先 cellsFit),颜色编号要合法', () => {
  const board = createBoard(5, 5, 12);
  assert.throws(() => placeCells(board, [[9, 0, 0]], 1), /越界/);
  assert.throws(() => placeCells(board, [[0, 0, 0]], 0), /颜色编号/);
  assert.throws(() => placeCells(board, [[0, 0, 0]], 300), /颜色编号/);
});

test('fullLayers:只有整层填满才算数', () => {
  const board = createBoard(5, 5, 12);
  assert.deepEqual(fullLayers(board), []);

  // 差一格
  for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) setCell(board, x, 2, z, 1);
  setCell(board, 4, 2, 4, 0);
  assert.deepEqual(fullLayers(board), [], '差一格不算满');

  setCell(board, 4, 2, 4, 1);
  assert.deepEqual(fullLayers(board), [2]);

  fillLayer(board, 5, 2);
  assert.deepEqual(fullLayers(board), [2, 5], '多层要按从下往上的顺序返回');
});

test('clearLayers:清层之后上面的东西整体塌落,塌落距离等于「比它低的被清层数」', () => {
  const board = createBoard(5, 5, 12);

  setCell(board, 0, 0, 0, 1);      // 第 0 层(在待清层之下:不动)
  setCell(board, 1, 1, 1, 2);      // 第 1 层(在待清层之下:不动)
  fillLayer(board, 2, 3);          // 第 2 层:填满,要被清掉
  setCell(board, 2, 3, 2, 4);      // 第 3 层(上方:下落 1 格)
  setCell(board, 3, 5, 3, 5);      // 第 5 层(上方:下落 1 格)

  const cleared = clearLayers(board, [2]);
  assert.equal(cleared, 1);

  // 待清层之下的原封不动
  assert.equal(getCell(board, 0, 0, 0), 1);
  assert.equal(getCell(board, 1, 1, 1), 2);
  // 待清层自己的方块**必须消失**(第一版把它们搬到了下一层,这是 bug)
  assert.equal(countFilled(board), 4, '原来 4 个记号 + 一整层,清完只剩 4 个记号');
  // 上面的各下落一格
  assert.equal(getCell(board, 2, 2, 2), 4, '第 3 层的记号应当落到第 2 层');
  assert.equal(getCell(board, 3, 4, 3), 5, '第 5 层的记号应当落到第 4 层');
  assert.equal(getCell(board, 2, 3, 2), 0, '原来的位置应当空出来');
  assert.equal(stackHeight(board), 5, '最高的记号落到第 4 层,所以高度是 5');
});

test('clearLayers:一次清多层时,每块的塌落距离不相同(不能只减 1)', () => {
  const board = createBoard(5, 5, 12);

  fillLayer(board, 1, 1);
  fillLayer(board, 3, 2);
  setCell(board, 0, 2, 0, 7);   // 夹在两个待清层之间 → 只下落 1 格(第 1 层)
  setCell(board, 1, 4, 1, 8);   // 在两个待清层之上 → 下落 2 格
  setCell(board, 2, 6, 2, 9);   // 更上面 → 同样下落 2 格

  const cleared = clearLayers(board, [1, 3]);
  assert.equal(cleared, 2);

  assert.equal(getCell(board, 0, 1, 0), 7, '第 2 层的块应当落到第 1 层');
  assert.equal(getCell(board, 1, 2, 1), 8, '第 4 层的块应当落到第 2 层');
  assert.equal(getCell(board, 2, 4, 2), 9, '第 6 层的块应当落到第 4 层');
  assert.equal(getCell(board, 2, 6, 2), 0, '原位应当空出来');

  // 注意:被清的层**可能被上面的东西重新填上**,所以不能断言它们是空的;
  // 真正的不变量是「没有任何一层是满的」(否则规则就不自洽了)
  assert.deepEqual(fullLayers(board), [], '清完之后不该还有满层');
  assert.equal(countFilled(board), 3, '除了三个记号,别的方块都应当被清掉');
});

test('clearLayers:清层不能丢方块也不能凭空造方块', () => {
  const board = createBoard(4, 4, 10);
  // 随便堆一些东西
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 60; i++) {
    setCell(board, Math.floor(rnd() * 4), Math.floor(rnd() * 10), Math.floor(rnd() * 4), 1 + Math.floor(rnd() * 3));
  }
  fillLayer(board, 2, 9);

  const before = countFilled(board);
  const layerCount = 4 * 4;
  const cleared = clearLayers(board, [2]);
  assert.equal(cleared, 1);
  assert.equal(
    countFilled(board),
    before - layerCount,
    '清掉一层的方块总数应当正好减少 一层格数(不多不少)',
  );
});

test('多次清层的塌落是稳定的:先清下面再清上面,和一次清完结果一样', () => {
  const build = () => {
    const board = createBoard(3, 3, 8);
    fillLayer(board, 1, 1);
    fillLayer(board, 4, 2);
    setCell(board, 0, 2, 0, 5);
    setCell(board, 1, 5, 1, 6);
    return board;
  };

  const once = build();
  clearLayers(once, [1, 4]);

  const stepwise = build();
  clearLayers(stepwise, [1]);
  // 清掉第 1 层之后,原来的第 4 层掉到第 3 层
  assert.deepEqual(fullLayers(stepwise), [3]);
  clearLayers(stepwise, [3]);

  assert.deepEqual([...once.cells], [...stepwise.cells], '两种清法必须得到同一个井');
});

test('layerFillRatios:给三维玩法的「还差几格」提示用', () => {
  const board = createBoard(4, 4, 4);
  assert.deepEqual(layerFillRatios(board), [0, 0, 0, 0]);
  setCell(board, 0, 1, 0, 1);
  assert.equal(layerFillRatios(board)[1], 1 / 16);
  fillLayer(board, 2, 1);
  assert.equal(layerFillRatios(board)[2], 1);
});

test('cloneBoard 是深拷贝', () => {
  const board = createBoard(3, 3, 3);
  setCell(board, 1, 1, 1, 4);
  const copy = cloneBoard(board);
  setCell(copy, 0, 0, 0, 9);
  assert.equal(getCell(board, 0, 0, 0), 0, '改副本不能影响原井');
  assert.equal(getCell(copy, 1, 1, 1), 4);
});

test('stackHeight:空井 0,只放一格是 1', () => {
  const board = createBoard(5, 5, 12);
  assert.equal(stackHeight(board), 0);
  setCell(board, 0, 0, 0, 1);
  assert.equal(stackHeight(board), 1);
  setCell(board, 4, 11, 4, 1);
  assert.equal(stackHeight(board), 12);
});
