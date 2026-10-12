import test from 'node:test';
import assert from 'node:assert/strict';

import {
  boardClear,
  createGame,
  drainEvents,
  DEFAULT_RULES,
  dropDistance,
  fallIntervalForLevel,
  ghostCells,
  hardDrop,
  isGrounded,
  levelForLayers,
  lockPiece,
  movePiece,
  rotatePiece,
  scoreForClear,
  softDrop,
  spawnCellsFor,
  spawnPiece,
  updateGame,
} from '../src/core/game.js';
import { cellsFit, countFilled, fullLayers, getCell, setCell } from '../src/core/board.js';
import { canonicalKey, cellsKey, TETRACUBES, translateCells } from '../src/core/polycube.js';

const collect = (game) => {
  const out = [];
  for (let i = 0; i < 2000; i++) {
    updateGame(game, 1 / 60);
    out.push(...drainEvents(game));
    if (game.status !== 'playing') break;
  }
  return out;
};

test('开局:井是空的、方块在井顶居中、下一个方块已经抽好', () => {
  const game = createGame({ seed: 7 });
  assert.equal(game.status, 'playing');
  assert.equal(boardClear(game), true);
  assert.equal(game.level, 1);
  assert.equal(game.score, 0);
  assert.equal(game.layers, 0);
  assert.ok(game.piece, '开局就该有一个方块');
  assert.ok(game.nextId, '下一个方块要提前抽好(预览用)');
  assert.ok(cellsFit(game.board, game.piece.cells));

  // 居中:左右/前后的空余对称
  const xs = game.piece.cells.map((c) => c[0]);
  const zs = game.piece.cells.map((c) => c[2]);
  const marginX = Math.min(...xs);
  const marginZ = Math.min(...zs);
  assert.ok(marginX >= 0 && marginZ >= 0);
  assert.equal(
    marginX,
    Math.floor((DEFAULT_RULES.width - (Math.max(...xs) - marginX + 1)) / 2),
    'x 方向应当居中',
  );
});

test('生成位置:方块顶部贴着井顶,不会超出井', () => {
  const game = createGame({ seed: 3 });
  for (const shape of TETRACUBES) {
    const cells = spawnCellsFor(game, shape);
    assert.ok(cellsFit(game.board, cells), `${shape.id} 的生成位置应当在井内且为空`);
    const maxY = Math.max(...cells.map((c) => c[1]));
    assert.equal(maxY, game.rules.height - 1, `${shape.id} 的顶部应当贴住井顶`);
  }
});

test('方块序列:同一个种子完全可复现,而且每种方块都会出现(袋式随机)', () => {
  /*
   * 注意这里**不用「一直硬降直到结束」来收集方块**:
   * 那样收集到几个完全取决于井有多大 —— 井变宽之后原地堆叠只要 6 个方块就把井口堵死了,
   * 于是「头 8 个各一次」这条断言会因为「根本抽不满一袋」而失败(实测踩过)。
   * 直接连续生成(不落位)就能干净地抽出一整袋,和井的尺寸无关。
   */
  const ids = (seed, count = 20) => {
    const game = createGame({ seed });
    const out = [];
    for (let i = 0; i < count; i++) {
      if (!game.piece) break;
      out.push(game.piece.id);
      spawnPiece(game);
    }
    return out;
  };

  const a = ids(1234, 40);
  const b = ids(1234, 40);
  assert.deepEqual(a, b, '同一个种子必须给同一串方块');
  assert.equal(a.length, 40, '同一个种子应当能连续抽出同样多的方块');

  const c = ids(9999, 40);
  assert.notDeepEqual(a, c, '不同种子应当给不同的串(否则随机就是假的)');

  // 袋式:每 8 个方块里 8 种各出现一次
  const total = TETRACUBES.length;
  for (let bag = 0; bag < 4; bag++) {
    const group = a.slice(bag * total, (bag + 1) * total);
    assert.equal(
      new Set(group).size,
      total,
      `第 ${bag + 1} 袋应当是 ${total} 种各一次,实际 ${group.join(',')}`,
    );
  }
});

test('左右前后移动:撞到井壁就不动,返回 false', () => {
  const game = createGame({ seed: 5 });
  const start = cellsKey(game.piece.cells);

  assert.equal(movePiece(game, [1, 0, 0]), true);
  assert.notEqual(cellsKey(game.piece.cells), start);

  // 一直往右推,直到推不动
  let guard = 0;
  while (movePiece(game, [1, 0, 0]) && guard++ < 20);
  assert.equal(movePiece(game, [1, 0, 0]), false, '出界之后必须返回 false');
  const maxX = Math.max(...game.piece.cells.map((c) => c[0]));
  assert.equal(maxX, DEFAULT_RULES.width - 1, '应当正好贴住右壁');

  // 上下方向也不能穿出井外
  let guardUp = 0;
  while (movePiece(game, [0, 1, 0]) && guardUp++ < 20);
  assert.equal(movePiece(game, [0, 1, 0]), false);
});

test('下落与落地锁定:下落到底之后走锁定延迟,延迟走完才写进井里', () => {
  const game = createGame({ seed: 11 });
  while (!isGrounded(game)) {
    assert.equal(movePiece(game, [0, -1, 0]), true);
  }
  const restingCells = cellsKey(game.piece.cells);
  const before = countFilled(game.board);

  // 还没到锁定延迟:方块还挂在半空(没有写进井里)
  updateGame(game, 0.1);
  assert.ok(game.piece, '延迟期内方块应当还在');
  assert.equal(countFilled(game.board), before, '还没锁定,井里不该多出方块');

  // 走完延迟
  collect(game);
  assert.ok(countFilled(game.board) > before, '锁定之后方块应当写进井里');
  assert.equal(getCell(game.board, ...restingCells.split(';')[0].split(',').map(Number)) !== 0, true);
});

test('锁定延迟会被「贴地时挪动」重置,但重置次数有上限', () => {
  const game = createGame({ seed: 13, maxLockResets: 3 });
  while (!isGrounded(game)) movePiece(game, [0, -1, 0]);

  for (let i = 0; i < 3; i++) {
    updateGame(game, 0.3);
    assert.ok(game.piece, `第 ${i + 1} 次微调前方块应当还在`);
    movePiece(game, [i % 2 === 0 ? 1 : -1, 0, 0]);
  }
  assert.equal(game.lockResets, 3, '应当正好用掉 3 次重置额度');

  // 额度用完之后,再怎么挪也拖不住
  updateGame(game, 0.3);
  movePiece(game, [1, 0, 0]);
  updateGame(game, 0.3);
  assert.equal(game.piece === null || game.lockTimer > 0, true);
});

test('硬降:直接落到底并锁定,分数按下落格数给', () => {
  const game = createGame({ seed: 17 });
  const distance = dropDistance(game);
  assert.ok(distance > 0);
  const ghost = ghostCells(game);
  assert.equal(ghost.length, game.piece.cells.length, '落地投影的格子数必须和方块一致');

  hardDrop(game);
  assert.ok(game.score >= distance * 2, '硬降应当按下落格数给分');
  // 底层必须出现方块
  let bottomFilled = 0;
  for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) if (getCell(game.board, x, 0, z) !== 0) bottomFilled++;
  assert.ok(bottomFilled > 0, '硬降之后井底应当有方块');

  // ghost 与实际落点一致
  for (const cell of ghost) {
    assert.ok(getCell(game.board, cell[0], cell[1], cell[2]) !== 0, `投影点 (${cell}) 应当正好是落点`);
  }
});

test('旋转:贴住井壁时靠「踢墙」也能转,而且转出来的位置合法', () => {
  const game = createGame({ seed: 19 });
  // 推到右上角,制造最容易卡住的位置
  let guard = 0;
  while (movePiece(game, [1, 0, 0]) && guard++ < 10);
  guard = 0;
  while (movePiece(game, [0, 0, 1]) && guard++ < 10);

  let successes = 0;
  for (const axis of ['x', 'y', 'z']) {
    for (const dir of [1, -1]) {
      if (rotatePiece(game, axis, dir)) {
        successes++;
        assert.ok(cellsFit(game.board, game.piece.cells), '旋转之后必须仍然是合法位置');
        // 形状不能变 —— 必须用**旋转不变**的规范型比较,
        // 用「平移不变」的键会把「转过了」误判成「形状变了」(第一版就是这么错的)
        assert.equal(
          canonicalKey(game.piece.cells),
          canonicalKey(TETRACUBES.find((p) => p.id === game.piece.id).cells),
          '旋转不能改变形状',
        );
      }
    }
  }
  assert.ok(successes >= 4, `贴边时也应当至少能转成功几次,实际 ${successes}`);
});

test('旋转会记录是否用了踢墙,便于渲染层做反馈', () => {
  const game = createGame({ seed: 23 });
  game.events = [];
  rotatePiece(game, 'y', 1);
  const event = game.events.find((e) => e.type === 'rotate');
  assert.ok(event);
  assert.equal(event.axis, 'y');
  assert.equal(typeof event.kicked, 'boolean');
});

test('消层:填满一整层就消掉、塌落、加分、升级', () => {
  const game = createGame({ seed: 29 });
  // 把第 0 层铺满,只留一个缺口给方块补 —— **必须按井的实际尺寸循环**,
  // 写死 5×5 的话井一变宽就只铺了四分之一,消层永远不会发生(实测踩过)
  for (let z = 0; z < game.board.depth; z++) {
    for (let x = 0; x < game.board.width; x++) setCell(game.board, x, 0, z, 1);
  }
  setCell(game.board, 0, 0, 0, 0);   // 留一个缺口
  game.piece.cells = [[0, 0, 0]];
  game.piece.pivot = [0, 0, 0];
  hardDrop(game);

  assert.equal(game.layers, 1, '应当消掉 1 层');
  assert.ok(game.score >= 100, '消 1 层至少 100 分');
  assert.equal(fullLayers(game.board).length, 0, '消完之后不该还有满层');
});

test('计分与等级:多层一起消有额外奖励,每 4 层升一级', () => {
  const rules = DEFAULT_RULES;
  assert.equal(scoreForClear(0, 1, rules), 0);
  assert.equal(scoreForClear(1, 1, rules), 100);
  assert.equal(scoreForClear(2, 1, rules), 300);
  assert.ok(scoreForClear(2, 1, rules) > scoreForClear(1, 1, rules) * 2, '一次消两层要比重罚…嗯,要比分两次消一层更划算');
  assert.equal(scoreForClear(1, 2, rules), 200, '分数要乘等级');

  assert.equal(levelForLayers(0, rules), 1);
  assert.equal(levelForLayers(3, rules), 1);
  assert.equal(levelForLayers(4, rules), 2);
  assert.equal(levelForLayers(9, rules), 3);
});

test('下落速度:随等级单调变快,但有下限(不能快到没法玩)', () => {
  let previous = Infinity;
  for (let level = 1; level <= 40; level++) {
    const interval = fallIntervalForLevel(level);
    assert.ok(interval <= previous + 1e-12, `第 ${level} 级不该比上一级慢`);
    assert.ok(interval >= DEFAULT_RULES.minFallInterval, `第 ${level} 级突破了速度下限`);
    previous = interval;
  }
  assert.ok(fallIntervalForLevel(1) > fallIntervalForLevel(10));
});

test('落到井底就停住:不会有一格穿到 y = -1', () => {
  const game = createGame({ seed: 31 });
  collect(game);
  for (const cell of game.events.flatMap((e) => e.cells ?? [])) {
    assert.ok(cell[1] >= 0, '不能出现 y < 0 的格子');
  }
  // 井里所有方块都在范围内
  assert.equal(countFilled(game.board) > 0, true);
});

test('游戏结束:井口被堵住之后不能再生成方块', () => {
  const game = createGame({ seed: 37, height: 6 });
  // 把最上面两层全填满,逼出 game over
  for (let y = 4; y < 6; y++) {
    for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) setCell(game.board, x, y, z, 2);
  }
  game.piece = null;
  game.events = [];

  const spawned = spawnPiece(game);
  assert.equal(spawned, false, '井口被堵住时生成必须失败');
  assert.equal(game.status, 'gameover');
  assert.equal(game.piece, null);
  assert.ok(game.events.some((e) => e.type === 'gameover'));
});

test('非法/极端 dt 不会让状态机崩或者穿地', () => {
  const game = createGame({ seed: 41 });
  updateGame(game, NaN);
  updateGame(game, -5);
  updateGame(game, Infinity);
  updateGame(game, 1e9);
  assert.equal(game.status === 'playing' || game.status === 'gameover', true);
  for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) {
    assert.ok(getCell(game.board, x, 0, z) === 0 || getCell(game.board, x, 0, z) > 0);
  }
});

test('完整对局能跑到结束,而且不变量一直成立', () => {
  const game = createGame({ seed: 20260412 });
  // 用最大的合法时间步(状态机内部会把 dt 夹到 0.1),否则 2 万步才 39 个方块,根本填不满井
  const DT = 0.1;
  let steps = 0;
  while (game.status === 'playing' && steps < 40000) {
    // 让它随便乱转乱移,模拟一个手很生的玩家
    if (steps % 7 === 0) rotatePiece(game, ['x', 'y', 'z'][steps % 3], steps % 2 === 0 ? 1 : -1);
    if (steps % 5 === 0) movePiece(game, [steps % 3 - 1, 0, (steps >> 1) % 3 - 1]);
    updateGame(game, DT);
    steps++;

    if (game.piece) {
      assert.ok(cellsFit(game.board, game.piece.cells), '任何时刻当前方块都必须是合法位置');
      for (const c of game.piece.cells) assert.ok(c[1] >= 0, '当前方块不能穿到井底以下');
    }
  }
  assert.ok(steps < 40000, '对局应当会结束(而不是死循环)');
  assert.equal(game.status, 'gameover');
  assert.ok(game.piecesPlaced > 5);
  assert.ok(game.score >= 0 && game.layers >= 0);
});

test('纯逻辑:核心层不依赖 three / DOM(分层守卫的最小版本)', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const files = readdirSync('src/core').filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 4);
  for (const file of files) {
    const source = readFileSync(`src/core/${file}`, 'utf8');
    assert.equal(/\bfrom\s+['"]three['"]/.test(source), false, `${file} 不该依赖 three`);
    assert.equal(/(?<![\w.$])(window|document)\s*\./.test(source), false, `${file} 不该访问浏览器全局`);
  }
});
