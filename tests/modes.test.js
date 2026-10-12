import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MODE_ID, MODE_IDS, MODES, modeById, nextModeId, rulesForMode,
} from '../src/core/modes.js';
import {
  createMemoryStorage, emptyProgress, loadProgress, pickStorage, PROGRESS_KEY,
  recordRun, sanitizeProgress, saveProgress,
} from '../src/core/progress.js';
import { createGame, updateGame, hardDrop, drainEvents, fallIntervalForLevel } from '../src/core/game.js';
import { cellsFit } from '../src/core/board.js';
import { canonicalKey } from '../src/core/polycube.js';

test('模式:两个模式都合法,方块集大小与井深符合预期', () => {
  assert.deepEqual(MODE_IDS, ['classic', 'hard']);
  assert.equal(MODES.classic.pieces.length, 8);
  assert.equal(MODES.hard.pieces.length, 29);
  // 井的尺寸刻意一致:难度只来自方块。这条断言是**故意的** ——
  // 如果哪天给高难模式换了井,渲染层就必须跟着重建,这里会先失败提醒。
  for (const id of MODE_IDS) {
    assert.equal(MODES[id].width, MODES.classic.width, `${id} 的井宽应当与经典模式一致`);
    assert.equal(MODES[id].depth, MODES.classic.depth, `${id} 的井深应当与经典模式一致`);
    assert.equal(MODES[id].height, MODES.classic.height, `${id} 的井高应当与经典模式一致`);
  }
  assert.ok(MODES.hard.baseFallInterval > MODES.classic.baseFallInterval, '高难模式应当落得更慢');

  for (const id of MODE_IDS) {
    const rules = rulesForMode(id);
    assert.equal(rules.modeId, id);
    assert.ok(rules.width > 0 && rules.depth > 0 && rules.height > 0);
    assert.ok(rules.pieces.length > 0);
    assert.ok(rules.scoreTable.length >= 5);
    // 计分表必须单调不减(一次消更多层不能反而更少分)
    for (let i = 1; i < rules.scoreTable.length; i++) {
      assert.ok(rules.scoreTable[i] > rules.scoreTable[i - 1], `${id} 计分表在第 ${i} 项不单调`);
    }
  }
});

test('模式:非法 id 兜底为默认模式,循环切换能回到起点', () => {
  assert.equal(modeById('hard').id, 'hard');
  assert.equal(modeById('nope').id, DEFAULT_MODE_ID);
  assert.equal(modeById(null).id, DEFAULT_MODE_ID);
  assert.equal(modeById(undefined).id, DEFAULT_MODE_ID);

  let id = MODE_IDS[0];
  const seen = new Set([id]);
  for (let i = 0; i < MODE_IDS.length; i++) {
    id = nextModeId(id);
    seen.add(id);
  }
  assert.equal(seen.size, MODE_IDS.length, '循环切换应当覆盖所有模式');
  assert.equal(id, MODE_IDS[0], `转一圈应当回到起点,实际 ${id}`);
});

test('模式:每个模式的所有方块都放得进井里(生成位置合法)', () => {
  for (const id of MODE_IDS) {
    const game = createGame(rulesForMode(id, { seed: 7 }));
    assert.ok(cellsFit(game.board, game.piece.cells), `${id} 开局方块应当在井内`);
    // 每种方块逐个试生成位置
    for (const piece of MODES[id].pieces) {
      const bounds = piece.cells.reduce((acc, c) => [Math.max(acc[0], c[0]), Math.max(acc[1], c[1]), Math.max(acc[2], c[2])], [0, 0, 0]);
      assert.ok(bounds[0] < game.rules.width, `${id} 的 ${piece.id} 在 x 方向装不下`);
      assert.ok(bounds[2] < game.rules.depth, `${id} 的 ${piece.id} 在 z 方向装不下`);
      assert.ok(bounds[1] < game.rules.height, `${id} 的 ${piece.id} 在 y 方向装不下`);
    }
  }
});

test('模式:高难模式的方块确实是 29 种互不同构的五立方体', () => {
  const keys = new Set(MODES.hard.pieces.map((p) => canonicalKey(p.cells)));
  assert.equal(keys.size, 29);
  for (const piece of MODES.hard.pieces) assert.equal(piece.cells.length, 5);
});

test('模式:每个模式都能被"无渲染"跑起来(不崩、不产生非法状态)', () => {
  for (const id of MODE_IDS) {
    const game = createGame(rulesForMode(id, { seed: 4242 }));
    let steps = 0;
    while (game.status === 'playing' && steps < 4000) {
      hardDrop(game);
      drainEvents(game);
      updateGame(game, 0.1);
      steps++;
      if (game.piece) {
        assert.ok(cellsFit(game.board, game.piece.cells), `${id} 出现了非法方块位置`);
        for (const c of game.piece.cells) assert.ok(c[1] >= 0, `${id} 方块穿到井底以下`);
      }
    }
    assert.ok(game.piecesPlaced > 3, `${id} 应当能放下若干个方块`);
    assert.ok(Number.isFinite(game.score));
    // 速度曲线仍然有下限
    assert.ok(fallIntervalForLevel(game.level) >= 0.1 - 1e-9);
  }
});

test('成绩:空成绩的结构完整,且两个模式都有位置', () => {
  const empty = emptyProgress();
  assert.equal(empty.games, 0);
  assert.equal(empty.totalLayers, 0);
  for (const id of MODE_IDS) {
    assert.equal(empty.best[id], 0);
    assert.equal(empty.bestLayers[id], 0);
  }
  assert.equal(empty.lastMode, DEFAULT_MODE_ID);
});

test('成绩:任何脏数据都被洗成合法值,而且绝不抛错', () => {
  const garbage = [
    null, undefined, 0, 1, 'x', [], [1, 2], true,
    { best: null, games: 'many', totalLayers: -5, lastMode: 'nope' },
    { best: { classic: NaN, hard: Infinity }, bestLayers: { classic: -3 }, games: 2.7, lastMode: 'hard' },
    { version: 999, best: { classic: 1e30 }, extra: { nested: true } },
  ];
  for (const raw of garbage) {
    const clean = sanitizeProgress(raw);
    assert.equal(typeof clean.best.classic, 'number');
    assert.ok(Number.isFinite(clean.best.classic) && clean.best.classic >= 0);
    assert.ok(Number.isFinite(clean.games) && clean.games >= 0);
    assert.ok(Number.isInteger(clean.totalLayers));
    assert.ok(MODE_IDS.includes(clean.lastMode));
    // 幂等
    assert.deepEqual(sanitizeProgress(clean), clean);
  }
});

test('成绩:消层事件必须带出「被消掉哪些格、什么颜色」(渲染层逐格碎裂要用)', () => {
  const game = createGame({ seed: 99 });
  const { width, depth } = game.board;
  // 把第 0 层铺满,再给当前方块挖出 4 个洞让它补上(**按井的实际尺寸循环**,不要写死 5×5)
  for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) {
    game.board.cells[(0 * depth + z) * width + x] = 3;
  }
  const spots = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]];
  for (const [x, y, z] of spots) game.board.cells[(y * depth + z) * width + x] = 0;
  game.piece.cells = spots.map((c) => [...c]);
  game.piece.pivot = [0, 0, 0];
  game.events = [];
  hardDrop(game);

  const clearEvent = game.events.find((e) => e.type === 'clear');
  assert.ok(clearEvent, '应当产生消层事件');
  assert.equal(clearEvent.cells.length, width * depth, `一整层应当是 ${width}×${depth} 格`);
  const ys = new Set(clearEvent.cells.map((c) => c.y));
  assert.deepEqual([...ys], [0], '被消的格子应当正好在第 0 层');
  for (const cell of clearEvent.cells) {
    assert.ok(Number.isInteger(cell.x) && Number.isInteger(cell.z));
    assert.ok(cell.color > 0, `被消掉的格子必须有颜色(否则渲染层只能瞎猜):${JSON.stringify(cell)}`);
  }
});

test('成绩:记住「看过新手引导」这个标记,并且能往返', () => {
  const storage = createMemoryStorage();
  const progress = emptyProgress();
  assert.equal(progress.seenTutorial, false, '第一次玩应当是没看过引导');
  progress.seenTutorial = true;
  assert.equal(saveProgress(storage, progress), true);
  assert.equal(loadProgress(storage).seenTutorial, true);

  // 脏数据:只有严格等于 true 才算看过
  assert.equal(sanitizeProgress({ seenTutorial: 'yes' }).seenTutorial, false);
  assert.equal(sanitizeProgress({ seenTutorial: 1 }).seenTutorial, false);
  assert.equal(sanitizeProgress({ seenTutorial: true }).seenTutorial, true);
});

test('成绩:记一局会更新对应模式的最好成绩,而且只增不减', () => {
  let progress = emptyProgress();
  let result = recordRun(progress, { mode: 'classic', score: 500, layers: 3 });
  progress = result.progress;
  assert.equal(result.record.score, true);
  assert.equal(result.record.layers, true);
  assert.equal(progress.best.classic, 500);
  assert.equal(progress.games, 1);
  assert.equal(progress.totalLayers, 3);
  assert.equal(progress.lastMode, 'classic');

  // 打得差不会覆盖记录
  result = recordRun(progress, { mode: 'classic', score: 100, layers: 1 });
  progress = result.progress;
  assert.equal(result.record.score, false);
  assert.equal(result.record.layers, false);
  assert.equal(progress.best.classic, 500);
  assert.equal(progress.games, 2, '局数要照常累加');
  assert.equal(progress.totalLayers, 4);

  // 换个模式互不影响
  result = recordRun(progress, { mode: 'hard', score: 300, layers: 2 });
  progress = result.progress;
  assert.equal(result.record.score, true, '高难模式是独立的记录');
  assert.equal(progress.best.hard, 300);
  assert.equal(progress.best.classic, 500, '不能互相覆盖');
});

test('成绩:记一局时非法入参不会污染存档', () => {
  const progress = emptyProgress();
  const result = recordRun(progress, { mode: 'nope', score: NaN, layers: -10 });
  assert.ok(Number.isFinite(result.progress.best.classic));
  assert.equal(result.progress.best.classic, 0);
  assert.equal(result.progress.totalLayers, 0);
  assert.equal(result.progress.games, 1);
  assert.ok(MODE_IDS.includes(result.progress.lastMode));
});

test('成绩:读写往返一致,解析失败时退回空成绩而不是崩', () => {
  const storage = createMemoryStorage();
  const progress = recordRun(emptyProgress(), { mode: 'hard', score: 1234, layers: 9 }).progress;
  assert.equal(saveProgress(storage, progress), true);
  assert.deepEqual(loadProgress(storage), progress);

  // 手改存档成垃圾
  storage.setItem(PROGRESS_KEY, '{not json');
  assert.deepEqual(loadProgress(storage), emptyProgress());

  storage.setItem(PROGRESS_KEY, '"a string"');
  assert.deepEqual(loadProgress(storage), emptyProgress());

  // 没有存档
  assert.deepEqual(loadProgress(createMemoryStorage()), emptyProgress());
  // 没有存储
  assert.deepEqual(loadProgress(null), emptyProgress());
  assert.equal(saveProgress(null, progress), false);
});

test('成绩:存储写不进去(配额满 / 隐私模式)要返回 false 而不是抛错', () => {
  const angry = {
    getItem: () => { throw new Error('nope'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => { throw new Error('nope'); },
  };
  assert.deepEqual(loadProgress(angry), emptyProgress());
  assert.equal(saveProgress(angry, emptyProgress()), false);

  // pickStorage 探测失败时也要给出可用的兜底
  const fallback = pickStorage(angry);
  assert.equal(fallback.setItem('k', 'v'), undefined);
  assert.equal(fallback.getItem('k'), 'v');
});
