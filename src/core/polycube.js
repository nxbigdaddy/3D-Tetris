/**
 * 多立方体(polycube)几何 —— 纯整数运算,与渲染引擎无关,可在 Node 里直接测。
 *
 * 坐标系:x 是井宽,z 是井深,y 是高度(y 向上,y = 0 是井底)。重力方向是 -y。
 * 一个方块(块体)= 一组整数格 {x,y,z};一个方块的**形状**与它在井里的**位置**分开表示。
 *
 * 关于旋转枢轴(重要):
 * 90° 旋转要保持落在整数格上,枢轴必须是「整格点」或「三个轴全是半格点」。
 * 如果取包围盒的几何中心,一个 2×3 截面的方块中心是(半格, 整格)—— **奇偶混合**,
 * 旋转后格子会落到两格之间。所以这里每个方块在生成时定一个**整格枢轴**,之后一直用它:
 * 旋转是精确整数运算,绕同一根轴转四次精确复原,而且没有任何累积漂移。
 */

/** 六个相邻方向 */
export const CUBE_DIRECTIONS = Object.freeze([
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
]);

const AXIS_INDEX = Object.freeze({ x: 0, y: 1, z: 2 });

/** 归一化成字符串键(先排序,所以与输入顺序无关) */
export function cellsKey(cells) {
  return cells
    .map((c) => `${c[0]},${c[1]},${c[2]}`)
    .sort()
    .join(';');
}

export function cloneCells(cells) {
  return cells.map((c) => [c[0], c[1], c[2]]);
}

/** 包围盒 */
export function cellsBounds(cells) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const c of cells) {
    for (let i = 0; i < 3; i++) {
      if (c[i] < min[i]) min[i] = c[i];
      if (c[i] > max[i]) max[i] = c[i];
    }
  }
  return { min, max, size: [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1] };
}

/** 平移到「包围盒最小角在原点」的规范位置 */
export function normalizeCells(cells) {
  const { min } = cellsBounds(cells);
  return cells.map((c) => [c[0] - min[0], c[1] - min[1], c[2] - min[2]]);
}

export function translateCells(cells, delta) {
  return cells.map((c) => [c[0] + delta[0], c[1] + delta[1], c[2] + delta[2]]);
}

/**
 * 绕整数枢轴旋转 90°(整数运算,精确)。
 * @param {number[][]} cells
 * @param {'x'|'y'|'z'} axis 旋转轴
 * @param {number} dir +1 / -1 方向
 * @param {number[]} pivot 整格枢轴
 */
export function rotateCellsAround(cells, axis, dir, pivot) {
  const a = AXIS_INDEX[axis];
  if (a === undefined) throw new Error(`未知旋转轴:${axis}`);
  if (dir !== 1 && dir !== -1) throw new Error(`旋转方向只能是 +1 / -1,收到 ${dir}`);
  const u = (a + 1) % 3;
  const w = (a + 2) % 3;

  return cells.map((cell) => {
    const out = [cell[0], cell[1], cell[2]];
    const du = out[u] - pivot[u];
    const dw = out[w] - pivot[w];
    // (u,w) 平面内 90° 旋转:(du, dw) → (-dw, du)
    out[u] = pivot[u] + (dir > 0 ? -dw : dw);
    out[w] = pivot[w] + (dir > 0 ? du : -du);
    return out;
  });
}

/**
 * 方块生成时定下的整格枢轴:包围盒中心向下取整。
 * 取整格(而不是几何中心)是为了让旋转精确 —— 理由见文件头。
 */
export function pivotForCells(cells) {
  const { min, max } = cellsBounds(cells);
  return [0, 1, 2].map((i) => Math.floor((min[i] + max[i]) / 2));
}

/** 生成全部 24 个旋转矩阵(整数、行列式为 +1)。用坐标置换 + 符号表示。 */
export function rotationMatrices24() {
  const out = [];
  const perms = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ];
  for (const p of perms) {
    for (let signs = 0; signs < 8; signs++) {
      const s = [(signs & 1) ? -1 : 1, (signs & 2) ? -1 : 1, (signs & 4) ? -1 : 1];
      // 排列的奇偶性 × 符号个数决定行列式是否为 +1
      const parity = permutationParity(p);
      const det = parity * s[0] * s[1] * s[2];
      if (det !== 1) continue;
      out.push({ perm: p, sign: s });
    }
  }
  return out;
}

function permutationParity(p) {
  let inversions = 0;
  for (let i = 0; i < p.length; i++) {
    for (let j = i + 1; j < p.length; j++) if (p[i] > p[j]) inversions++;
  }
  return inversions % 2 === 0 ? 1 : -1;
}

function applyMatrix(cells, m) {
  return cells.map((c) => [0, 1, 2].map((i) => m.sign[i] * c[m.perm[i]]));
}

const MATRICES = rotationMatrices24();

/**
 * 自由多立方体的规范型:在 24 个旋转里取字典序最小的那个键。
 * 「自由」= 镜像也算同一个(三维里玩家可以自由旋转,镜像本来就能转出来)。
 */
export function canonicalKey(cells) {
  let best = null;
  for (const m of MATRICES) {
    const key = cellsKey(normalizeCells(applyMatrix(cells, m)));
    if (best === null || key < best) best = key;
  }
  return best;
}

export function canonicalCells(cells) {
  let bestKey = null;
  let bestCells = null;
  for (const m of MATRICES) {
    const candidate = normalizeCells(applyMatrix(cells, m));
    const key = cellsKey(candidate);
    if (bestKey === null || key < bestKey) {
      bestKey = key;
      bestCells = candidate;
    }
  }
  return bestCells;
}

/** 两个形状是否同构(忽略旋转与位置) */
export function sameShape(a, b) {
  return canonicalKey(a) === canonicalKey(b);
}

/**
 * 枚举 n 个格子的**自由**多立方体。
 * 做法是最朴素的生长法 + 规范型去重 —— n 小的时候完全够用,而且结果可以直接和文献数字对照:
 *   1 → 1 种、2 → 1 种、3 → 2 种、4 → 8 种、5 → 29 种、6 → 166 种
 * 单元测试就用这串数字验证枚举与规范化是否真的正确。
 */
export function enumerateFreePolycubes(n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`格子数必须是正整数,收到 ${n}`);
  let shapes = new Map([[cellsKey([[0, 0, 0]]), [[0, 0, 0]]]]);
  for (let size = 2; size <= n; size++) {
    const next = new Map();
    for (const cells of shapes.values()) {
      const occupied = new Set(cells.map((c) => `${c[0]},${c[1]},${c[2]}`));
      for (const cell of cells) {
        for (const d of CUBE_DIRECTIONS) {
          const candidate = [cell[0] + d[0], cell[1] + d[1], cell[2] + d[2]];
          if (occupied.has(`${candidate[0]},${candidate[1]},${candidate[2]}`)) continue;
          const grown = canonicalCells([...cells, candidate]);
          const key = cellsKey(grown);
          if (!next.has(key)) next.set(key, grown);
        }
      }
    }
    shapes = next;
  }
  return [...shapes.values()];
}

/** 经典「四立方体」全集(8 种)—— 本作的方块集 */
export const TETRACUBES = Object.freeze(enumerateFreePolycubes(4).map((cells, index) => ({
  id: `T${index}`,
  cells,
  size: cells.length,
})));

/** 五个格子的多立方体(29 种),留给「高难模式」 */
export const PENTACUBES = Object.freeze(enumerateFreePolycubes(5).map((cells, index) => ({
  id: `P${index}`,
  cells,
  size: cells.length,
})));

/**
 * 给方块起可读的名字 —— 只为了日志与调试好认,不参与任何规则。
 * 名字按几何特征判断:一维直线、平面块、立体的分支/螺旋等。
 */
export function describeShape(cells) {
  const { size } = cellsBounds(cells);
  const dims = [...size].sort((a, b) => a - b);
  const [a, b, c] = dims;
  if (a === 1 && b === 1) return '直线';
  if (a === 1 && b === 2 && c === 2) return '方块';
  if (a === 1 && b === 2 && c === 3) return '平面T/S/L';
  if (a === 1 && b === 2 && c === 4) return '平面长L';
  if (a === 2 && b === 2 && c === 2) return '立体角';
  return `立体 ${size.join('×')}`;
}

export function pieceSetById(id) {
  const all = [...TETRACUBES, ...PENTACUBES];
  const found = all.find((piece) => piece.id === id);
  if (!found) throw new Error(`没有这个方块:${id}`);
  return found;
}
