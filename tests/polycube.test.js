import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CUBE_DIRECTIONS,
  cellsBounds,
  cellsKey,
  canonicalCells,
  canonicalKey,
  describeShape,
  enumerateFreePolycubes,
  normalizeCells,
  pivotForCells,
  rotationMatrices24,
  rotateCellsAround,
  sameShape,
  TETRACUBES,
  PENTACUBES,
} from '../src/core/polycube.js';

test('24 个旋转矩阵:数量、正交性、行列式全为 +1', () => {
  const matrices = rotationMatrices24();
  assert.equal(matrices.length, 24, '三维旋转群恰好 24 个元素');

  const seen = new Set();
  for (const m of matrices) {
    // 用单位立方体的三个轴向量验证:长度不变、互相垂直
    const axes = [0, 1, 2].map((i) => {
      const v = [0, 0, 0];
      v[i] = 1;
      return [0, 1, 2].map((k) => m.sign[k] * v[m.perm[k]]);
    });
    for (const v of axes) assert.equal(v.filter((x) => x !== 0).length, 1, '轴向量必须仍是单位轴');
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const dot = axes[i][0] * axes[j][0] + axes[i][1] * axes[j][1] + axes[i][2] * axes[j][2];
        assert.equal(dot, i === j ? 1 : 0, '轴向量必须正交');
      }
    }
    seen.add(JSON.stringify([m.perm, m.sign]));
  }
  assert.equal(seen.size, 24, '不能有重复矩阵');
});

test('枚举自由多立方体:与文献数字逐一对上(这是枚举+规范化的强校验)', () => {
  // 这串数字是公认结果,能把「生长法」和「24 旋转规范化」里的错误一次性逼出来
  const expected = { 1: 1, 2: 1, 3: 2, 4: 8, 5: 29 };
  for (const [n, count] of Object.entries(expected)) {
    const shapes = enumerateFreePolycubes(Number(n));
    assert.equal(shapes.length, count, `${n} 个格子的自由多立方体应当是 ${count} 种`);
    for (const cells of shapes) {
      assert.equal(cells.length, Number(n));
      // 每个都必须是连通的
      assert.equal(isConnected(cells), true, `${cellsKey(cells)} 不连通`);
    }
  }
});

test('规范化:幂等、与输入顺序无关、对旋转不变', () => {
  const shapes = enumerateFreePolycubes(4);
  for (const cells of shapes) {
    const canonical = canonicalCells(cells);
    // 幂等
    assert.equal(cellsKey(canonicalCells(canonical)), cellsKey(canonical));
    // 顺序无关
    const shuffled = [...cells].reverse();
    assert.equal(canonicalKey(shuffled), canonicalKey(cells));
    // 规范型的最小角在原点
    const { min } = cellsBounds(canonical);
    assert.deepEqual(min.map((v) => v + 0), [0, 0, 0]);
    // 随便转一下仍是同一个形状
    const pivot = pivotForCells(cells);
    assert.equal(canonicalKey(rotateCellsAround(cells, 'y', 1, pivot)), canonicalKey(cells));
  }
});

test('方块集:四立方体恰好 8 种,五立方体 29 种,且互不同构', () => {
  assert.equal(TETRACUBES.length, 8);
  assert.equal(PENTACUBES.length, 29);
  const keys = new Set(TETRACUBES.map((p) => canonicalKey(p.cells)));
  assert.equal(keys.size, 8, '8 种方块必须两两不同构');
  for (const piece of TETRACUBES) assert.equal(piece.cells.length, 4);
  assert.equal(new Set(TETRACUBES.map((p) => p.id)).size, 8);
});

test('旋转:绕固定整格枢轴,**转四次精确复原**,且没有累积漂移', () => {
  // 注意不能断言「中间步骤必须和起点不同」:直线方块绕自身轴转 180° 就会回到原状,
  // 这是**对称性**,不是 bug。真正的不变量是「周期整除 4」+「四次精确复原」。
  const cycles = new Set();
  for (const piece of TETRACUBES) {
    for (const axis of ['x', 'y', 'z']) {
      const start = piece.cells;
      const pivot = pivotForCells(start);
      let current = start;

      let cycle = null;
      for (let i = 1; i <= 4; i++) {
        current = rotateCellsAround(current, axis, 1, pivot);
        if (cellsKey(current) === cellsKey(start)) { cycle = i; break; }
      }
      assert.ok(cycle !== null, `${piece.id} 绕 ${axis} 轴转四次没有复原 —— 有漂移`);
      assert.equal(4 % cycle, 0, `${piece.id} 绕 ${axis} 轴的周期 ${cycle} 必须整除 4`);
      cycles.add(cycle);

      // 方向相反也要能回去
      const back = rotateCellsAround(rotateCellsAround(start, axis, 1, pivot), axis, -1, pivot);
      assert.equal(cellsKey(back), cellsKey(start), '正反各转一次必须复原');
    }
  }
  assert.ok(cycles.has(4), '应当存在真正需要转四次才复原(不含对称)的方块,否则这条用例太弱');
});

test('旋转:枢轴取整格而不是几何中心,两者对奇偶混合的方块会给出不同结果', () => {
  // 2×3 的平面方块:几何中心是(半格, 整格)混合 —— 用它旋转会落到格与格之间
  const shape = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 0, 1], [1, 0, 1], [2, 0, 1]].slice(0, 4);
  const bounds = cellsBounds(shape);
  const geometric = [0, 1, 2].map((i) => (bounds.min[i] + bounds.max[i]) / 2);
  const integral = pivotForCells(shape);

  const hasHalf = geometric.some((v) => !Number.isInteger(v));
  const rotatedByGeometric = shape.map((cell) => {
    const du = cell[0] - geometric[0];
    const dw = cell[2] - geometric[2];
    return [geometric[0] - dw, cell[1], geometric[2] + du];
  });
  const offGrid = rotatedByGeometric.some((c) => c.some((v) => !Number.isInteger(v)));

  if (!hasHalf) return; // 这个形状的中心本来就是整格,不需要演示
  assert.equal(offGrid, true, '几何中心旋转确实会把格子甩到格与格之间(所以不能用它)');
  const rotated = rotateCellsAround(shape, 'y', 1, integral);
  assert.ok(rotated.every((c) => c.every((v) => Number.isInteger(v))), '整格枢轴旋转必须保持整格');
});

test('包围盒、平移、描述与相邻方向', () => {
  const cells = [[0, 0, 0], [1, 0, 0], [0, 2, 0]];
  assert.deepEqual(cellsBounds(cells).size, [2, 3, 1]);
  assert.deepEqual(cellsBounds(cells).min, [0, 0, 0]);
  const moved = [[1, 1, 1], [2, 1, 1], [1, 3, 1]];
  assert.equal(cellsKey(normalizeCells(moved)), cellsKey(cells));
  assert.equal(normalizeCells(moved).length, 3);

  assert.equal(CUBE_DIRECTIONS.length, 6);
  assert.equal(new Set(CUBE_DIRECTIONS.map((d) => d.join(','))).size, 6);
  for (const piece of TETRACUBES) assert.ok(describeShape(piece.cells).length > 0);
});

test('sameShape 只看形状,不看位置', () => {
  const a = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]];
  const b = [[5, 7, 9], [6, 7, 9], [7, 7, 9], [8, 7, 9]];
  const c = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
  assert.equal(sameShape(a, b), true);
  assert.equal(sameShape(a, c), false);
});

test('非法输入立刻报错,不要静默算出个东西来', () => {
  assert.throws(() => enumerateFreePolycubes(0), /正整数/);
  assert.throws(() => enumerateFreePolycubes(2.5), /正整数/);
  assert.throws(() => rotateCellsAround([[0, 0, 0]], 'w', 1, [0, 0, 0]), /未知旋转轴/);
  assert.throws(() => rotateCellsAround([[0, 0, 0]], 'y', 0, [0, 0, 0]), /方向/);
});

/** 六邻接连通性检查 */
function isConnected(cells) {
  const set = new Set(cells.map((c) => c.join(',')));
  const stack = [cells[0]];
  const seen = new Set([cells[0].join(',')]);
  while (stack.length > 0) {
    const cell = stack.pop();
    for (const d of CUBE_DIRECTIONS) {
      const next = [cell[0] + d[0], cell[1] + d[1], cell[2] + d[2]];
      const key = next.join(',');
      if (!set.has(key) || seen.has(key)) continue;
      seen.add(key);
      stack.push(next);
    }
  }
  return seen.size === cells.length;
}
