/**
 * 三维井(井底 x-z 平面 × 高度 y)。
 *
 * 坐标:y 向上,0 是井底;重力沿 -y。格子里存 0(空)或颜色编号(>0)。
 * 「消层」在本作里是**填满一整个 x-z 平面**(不是二维俄罗斯方块的一行)——
 * 这是 Blockout 式玩法的核心规则,也是它比二维难得多的地方。
 */

export function createBoard(width, depth, height) {
  assertDimension(width, 'width');
  assertDimension(depth, 'depth');
  assertDimension(height, 'height');
  return {
    width,
    depth,
    height,
    /** 颜色编号,0 表示空 */
    cells: new Uint8Array(width * depth * height),
  };
}

function assertDimension(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} 必须是正整数,收到 ${value}`);
}

export function boardIndex(board, x, y, z) {
  return (y * board.depth + z) * board.width + x;
}

export function inBounds(board, x, y, z) {
  return x >= 0 && x < board.width
    && y >= 0 && y < board.height
    && z >= 0 && z < board.depth;
}

export function getCell(board, x, y, z) {
  if (!inBounds(board, x, y, z)) return 0;
  return board.cells[boardIndex(board, x, y, z)];
}

export function setCell(board, x, y, z, value) {
  if (!inBounds(board, x, y, z)) return false;
  board.cells[boardIndex(board, x, y, z)] = value;
  return true;
}

export function cloneBoard(board) {
  return { width: board.width, depth: board.depth, height: board.height, cells: board.cells.slice() };
}

/** 这组格子是否**全都在井内且为空** —— 所有移动/旋转/下落判定的唯一依据 */
export function cellsFit(board, cells) {
  for (const [x, y, z] of cells) {
    if (!inBounds(board, x, y, z)) return false;
    if (board.cells[boardIndex(board, x, y, z)] !== 0) return false;
  }
  return true;
}

/** 把格子写进井里;任何一格越界都直接报错(调用方必须先 cellsFit) */
export function placeCells(board, cells, value) {
  if (value <= 0 || value > 255) throw new Error(`颜色编号必须是 1..255,收到 ${value}`);
  for (const [x, y, z] of cells) {
    if (!inBounds(board, x, y, z)) throw new Error(`格子 (${x},${y},${z}) 越界,不能写入`);
    board.cells[boardIndex(board, x, y, z)] = value;
  }
}

/** 找出所有被填满的层(返回 y 值,从下往上) */
export function fullLayers(board) {
  const layers = [];
  for (let y = 0; y < board.height; y++) {
    let full = true;
    for (let z = 0; z < board.depth && full; z++) {
      for (let x = 0; x < board.width; x++) {
        if (board.cells[boardIndex(board, x, y, z)] === 0) { full = false; break; }
      }
    }
    if (full) layers.push(y);
  }
  return layers;
}

/**
 * 清掉指定层,并让上面的东西**整体塌落**。
 * 塌落规则:一个位于 y 的格子,往下移动「比它低的被清层数」格。
 */
export function clearLayers(board, layers) {
  if (layers.length === 0) return 0;
  const sorted = [...new Set(layers)].sort((a, b) => a - b);
  for (const y of sorted) {
    if (!Number.isInteger(y) || y < 0 || y >= board.height) throw new Error(`要清的层越界:${y}`);
  }

  const cleared = new Set(sorted);
  const next = new Uint8Array(board.cells.length);
  for (let y = 0; y < board.height; y++) {
    // 被清的层直接丢掉 —— 注意不能顺手把它搬到下面去:
    // 第一版就是这么写的,结果「消掉一层」只让高度减了 1,而那一层的方块全被搬到了下一层。
    if (cleared.has(y)) continue;

    const shift = sorted.filter((below) => below < y).length;
    if (shift === 0) {
      // 没被清层影响:整层原样搬过去
      for (let z = 0; z < board.depth; z++) {
        for (let x = 0; x < board.width; x++) {
          next[boardIndex(board, x, y, z)] = board.cells[boardIndex(board, x, y, z)];
        }
      }
      continue;
    }
    const targetY = y - shift;
    for (let z = 0; z < board.depth; z++) {
      for (let x = 0; x < board.width; x++) {
        const value = board.cells[boardIndex(board, x, y, z)];
        if (value === 0) continue;
        next[boardIndex(board, x, targetY, z)] = value;
      }
    }
  }
  board.cells = next;
  return sorted.length;
}

export function countFilled(board) {
  let total = 0;
  for (const value of board.cells) if (value !== 0) total++;
  return total;
}

export function boardIsEmpty(board) {
  return board.cells.every((value) => value === 0);
}

/** 最高被占层的高度(空井为 0) */
export function stackHeight(board) {
  for (let y = board.height - 1; y >= 0; y--) {
    for (let z = 0; z < board.depth; z++) {
      for (let x = 0; x < board.width; x++) {
        if (board.cells[boardIndex(board, x, y, z)] !== 0) return y + 1;
      }
    }
  }
  return 0;
}

/**
 * 各层的填充率(0..1),给 HUD 画「还差几格就消层」的提示用。
 * 这是三维版特有的信息需求:二维游戏一眼能看出哪行快满了,三维看不出来。
 */
export function layerFillRatios(board) {
  const ratios = [];
  for (let y = 0; y < board.height; y++) {
    let filled = 0;
    for (let z = 0; z < board.depth; z++) {
      for (let x = 0; x < board.width; x++) {
        if (board.cells[boardIndex(board, x, y, z)] !== 0) filled++;
      }
    }
    ratios.push(filled / (board.width * board.depth));
  }
  return ratios;
}
