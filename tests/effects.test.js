import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addShake, burstParticles, createShake, MAX_PARTICLES, particleCount, particleFade,
  stepParticles, stepShake,
} from '../src/core/effects.js';
import {
  arpeggioFor, barSeconds, chordAt, intensityFor, layersFor, midiToFrequency,
  MINOR_SCALE, PROGRESSION, tempoFor,
} from '../src/core/music.js';

test('震屏:冲击取较大值而不是累加,并且必然衰减到 0', () => {
  const shake = createShake();
  assert.equal(stepShake(shake, 1 / 60).magnitude, 0, '没有冲击时不该抖');

  addShake(shake, 0.2);
  addShake(shake, 0.15);
  assert.equal(shake.magnitude, 0.2, '多次冲击取较大值(累加会把画面晃到看不清)');
  assert.ok(shake.total > 0.34, '总冲击量要记下来,便于调试');

  // 上限
  addShake(shake, 99);
  assert.ok(shake.magnitude <= 0.6 + 1e-9, '震屏幅度必须有上限');

  // 衰减
  let frames = 0;
  while (shake.magnitude > 0 && frames < 600) { stepShake(shake, 1 / 60); frames++; }
  assert.equal(shake.magnitude, 0, '震屏必须收敛到 0(否则相机永远回不了位)');
  assert.ok(frames < 300, `衰减太慢:${frames} 帧`);
});

test('震屏:偏移有界、平均为 0,而且非法 dt 不会产生 NaN', () => {
  const shake = createShake();
  addShake(shake, 0.4);
  let sum = 0;
  let samples = 0;
  for (let i = 0; i < 200; i++) {
    const offset = stepShake(shake, 1 / 60);
    assert.ok(Number.isFinite(offset.x) && Number.isFinite(offset.y) && Number.isFinite(offset.z));
    assert.ok(Math.abs(offset.x) <= 0.4 + 1e-9);
    sum += offset.x;
    samples++;
  }
  assert.ok(Math.abs(sum / samples) < 0.05, '抖动应当是 0 均值的(不然相机会慢慢漂走)');

  addShake(shake, 0.3);
  const bad = stepShake(shake, NaN);
  assert.ok(Number.isFinite(bad.x) && Number.isFinite(bad.y) && Number.isFinite(bad.z));
  const huge = stepShake(shake, 1e9);
  assert.ok(Number.isFinite(huge.x));
});

test('粒子:炸出来的数量正确、位置在格内、并且**一定会过期**', () => {
  const cells = [[0, 0, 0], [1, 0, 0], [2, 0, 1], [3, 0, 1]];
  const list = burstParticles(cells, 3, 12345, 3);
  assert.equal(particleCount(list), cells.length * 3);

  for (const p of list) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
    assert.ok(p.size > 0 && p.life > 0);
    // 落在起始格附近(允许 0.5 格抖动)
    const near = cells.some(([x, y, z]) => Math.abs(p.x - (x + 0.5)) <= 1 && Math.abs(p.y - (y + 0.5)) <= 1.2 && Math.abs(p.z - (z + 0.5)) <= 1);
    assert.ok(near, '粒子应当从被消的格子里炸出来');
  }

  // 跑够时间之后必须全部消失
  let frames = 0;
  while (list.length > 0 && frames < 600) { stepParticles(list, 1 / 60, { floorY: 0 }); frames++; }
  assert.equal(list.length, 0, '粒子必须全部过期(否则会一直堆积、拖垮帧率)');
  assert.ok(frames < 200, `粒子活得太久:${frames} 帧`);
});

test('粒子:不会穿地、不会出 NaN、数量有上限', () => {
  const list = burstParticles([[0, 0, 0], [1, 0, 1]], 1, 7, 6);
  for (let i = 0; i < 400; i++) {
    stepParticles(list, 1 / 60, { floorY: 0 });
    for (const p of list) {
      assert.ok(p.y >= -1e-9, `粒子穿到地面以下:${p.y}`);
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
    }
  }
  assert.ok(list.length <= MAX_PARTICLES);
  assert.ok(MAX_PARTICLES > 0);

  // 非法 dt 不能崩、也不能产生 NaN
  const again = burstParticles([[0, 0, 0]], 1, 3, 2);
  stepParticles(again, NaN);
  stepParticles(again, -5);
  stepParticles(again, Infinity);
  for (const p of again) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});

test('粒子:同一个种子完全可复现(端到端断言才能稳定)', () => {
  const a = burstParticles([[0, 0, 0], [1, 0, 1]], 2, 999, 3);
  const b = burstParticles([[0, 0, 0], [1, 0, 1]], 2, 999, 3);
  assert.deepEqual(a, b);
  const c = burstParticles([[0, 0, 0], [1, 0, 1]], 2, 1000, 3);
  assert.notDeepEqual(a, c);
});

test('粒子淡出比例:从 1 单调降到 0', () => {
  const [p] = burstParticles([[0, 0, 0]], 1, 5, 1);
  assert.equal(particleFade(p), 1);
  p.age = p.life / 2;
  assert.ok(Math.abs(particleFade(p) - 0.5) < 1e-9);
  p.age = p.life * 2;
  assert.equal(particleFade(p), 0);
});

test('音乐:和声进行是循环的,而且和弦音都落在音阶/natural 和弦里', () => {
  assert.equal(chordAt(0), PROGRESSION[0]);
  assert.equal(chordAt(4), PROGRESSION[0], '4 小节一轮');
  assert.equal(chordAt(-1), PROGRESSION[PROGRESSION.length - 1], '负数也要安全');
  assert.equal(chordAt(NaN), PROGRESSION[0]);
  for (let bar = 0; bar < 12; bar++) {
    const chord = chordAt(bar);
    assert.ok(PROGRESSION.includes(chord));
    for (const offset of chord.offsets) assert.ok(Math.abs(offset) <= 12);
  }
  assert.ok(MINOR_SCALE.length === 7);
});

test('音乐:琶音确定、可复现,音高落在合理区间', () => {
  const a = arpeggioFor(0, 8);
  const b = arpeggioFor(0, 8);
  assert.deepEqual(a, b);
  assert.equal(a.length, 8);
  for (const note of a) {
    assert.ok(Number.isInteger(note));
    assert.ok(note >= 40 && note <= 90, `音高跑出合理区间:${note}`);
    const freq = midiToFrequency(note);
    assert.ok(freq > 60 && freq < 1400, `频率不合理:${freq}`);
  }
  assert.notDeepEqual(arpeggioFor(0, 8), arpeggioFor(1, 8), '不同小节应当不同');
});

test('音乐:紧张度单调有界,速度随时间单调,小节长度合理', () => {
  let previous = -1;
  for (let level = 1; level <= 20; level++) {
    const value = intensityFor({ level, fill: 0 });
    assert.ok(value >= previous - 1e-9, '等级越高紧张度不能下降');
    assert.ok(value >= 0 && value <= 1);
    previous = value;
  }
  previous = -1;
  for (let fill = 0; fill <= 1.0001; fill += 0.1) {
    const value = intensityFor({ level: 1, fill });
    assert.ok(value >= previous - 1e-9, '堆得越高紧张度不能下降');
    previous = value;
  }
  assert.equal(intensityFor({ level: 999, fill: 9 }), 1, '上限是 1');
  assert.equal(intensityFor({}), 0, '默认从 0 开始');

  // 速度随紧张度**递增**,所以初值要设成 -Infinity(第一版写成 Infinity,第一次比较就必然失败)
  let previousTempo = -Infinity;
  for (let i = 0; i <= 1.0001; i += 0.05) {
    const tempo = tempoFor(i);
    assert.ok(tempo >= previousTempo - 1e-9, '越紧张速度只能越快');
    assert.ok(tempo >= 80 && tempo <= 150);
    previousTempo = tempo;
  }

  const seconds = barSeconds(0.5);
  assert.ok(seconds > 1 && seconds < 4, `小节长度不合理:${seconds}`);
  assert.equal(layersFor(0.2), 1);
  assert.equal(layersFor(0.9), 2, '紧张度高的时候多铺一层');
});
