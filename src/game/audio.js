/**
 * 音频:全部**程序化合成**,零素材文件 —— 这是单文件能真正自包含的前提。
 *
 * 分工:
 *   - 音高、和声、速度这些**数学**放在 core/music.js,有单元测试;
 *   - 这里只负责把它们接到 WebAudio 上,以及合成音效。
 *
 * 音乐是**前瞻式调度**(每次看未来一小段,把音符排进 WebAudio 的时间轴),
 * 而不是用 setInterval 到点再响 —— 后者在帧率抖动时必然走音。
 */

import { arpeggioFor, barSeconds, chordAt, intensityFor, layersFor, midiToFrequency } from '../core/music.js';

export function createAudio() {
  let ctx = null;
  let master = null;
  let musicGain = null;
  let sfxGain = null;
  let muted = false;
  let unlocked = false;

  // 音乐调度状态
  let musicOn = false;
  let nextBarTime = 0;
  let barIndex = 0;
  let intensity = 0;

  function ensure() {
    if (ctx) return ctx;
    const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.9;
    master.connect(ctx.destination);

    musicGain = ctx.createGain();
    musicGain.gain.value = 0.3;
    musicGain.connect(master);

    sfxGain = ctx.createGain();
    sfxGain.gain.value = 0.55;
    sfxGain.connect(master);
    return ctx;
  }

  /** 浏览器要求音频必须由用户手势唤醒 */
  function unlock() {
    const context = ensure();
    if (!context) return false;
    if (context.state === 'suspended') context.resume();
    unlocked = true;
    return true;
  }

  function setMuted(value) {
    muted = Boolean(value);
    if (master) master.gain.value = muted ? 0 : 0.9;
    return muted;
  }

  /** 一个带包络的振荡器音 */
  function tone({ freq, type = 'triangle', start = 0, duration = 0.2, gain = 0.5, sweep = 0 }) {
    const context = ctx;
    if (!context) return;
    const t0 = context.currentTime + start;
    const osc = context.createOscillator();
    const env = context.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (sweep !== 0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq + sweep), t0 + duration);
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(env);
    env.connect(sfxGain);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  /** 噪声(落地、消层的「沙」感) */
  function noise({ start = 0, duration = 0.18, gain = 0.25, lowpass = 1600 }) {
    const context = ctx;
    if (!context) return;
    const t0 = context.currentTime + start;
    const frames = Math.max(1, Math.floor(context.sampleRate * duration));
    const buffer = context.createBuffer(1, frames, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const src = context.createBufferSource();
    src.buffer = buffer;
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = lowpass;
    const env = context.createGain();
    env.gain.value = gain;
    src.connect(filter);
    filter.connect(env);
    env.connect(sfxGain);
    src.start(t0);
  }

  const SFX = {
    move: () => tone({ freq: 240, type: 'square', duration: 0.06, gain: 0.12 }),
    rotate: () => tone({ freq: 420, type: 'triangle', duration: 0.09, gain: 0.18, sweep: 120 }),
    lock: () => { tone({ freq: 150, type: 'sine', duration: 0.14, gain: 0.4, sweep: -60 }); noise({ duration: 0.1, gain: 0.12, lowpass: 900 }); },
    drop: () => tone({ freq: 110, type: 'sawtooth', duration: 0.18, gain: 0.25, sweep: -50 }),
    clear: (count = 1) => {
      const base = 520 + count * 90;
      for (let i = 0; i < Math.min(4, count + 1); i++) {
        tone({ freq: base * (1 + i * 0.26), type: 'triangle', start: i * 0.055, duration: 0.26, gain: 0.3 });
      }
      noise({ duration: 0.3, gain: 0.16, lowpass: 2600 });
    },
    levelup: () => {
      [0, 4, 7, 12].forEach((semi, i) => tone({
        freq: midiToFrequency(69 + semi), type: 'square', start: i * 0.07, duration: 0.22, gain: 0.22,
      }));
    },
    gameover: () => {
      [0, -3, -7, -12].forEach((semi, i) => tone({
        freq: midiToFrequency(64 + semi), type: 'sawtooth', start: i * 0.13, duration: 0.45, gain: 0.26,
      }));
    },
    pause: () => tone({ freq: 320, type: 'sine', duration: 0.12, gain: 0.2 }),
  };

  function play(name, ...args) {
    if (!unlocked || muted) return false;
    if (!ensure()) return false;
    const fn = SFX[name];
    if (!fn) return false;
    fn(...args);
    return true;
  }

  /** 设定音乐紧张度(0..1) */
  function setIntensity(value) {
    intensity = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  }

  function startMusic() {
    if (!unlock()) return false;
    if (musicOn) return true;
    musicOn = true;
    barIndex = 0;
    nextBarTime = ctx.currentTime + 0.15;
    return true;
  }

  function stopMusic() {
    musicOn = false;
  }

  /**
   * 前瞻式调度:把「未来 0.6 秒内该响的小节」排进时间轴。
   * 每帧调用一次即可,重复调用不会重复排(靠 nextBarTime 推进)。
   */
  function updateMusic() {
    if (!musicOn || !ctx || muted) return 0;
    const horizon = ctx.currentTime + 0.6;
    let scheduled = 0;
    let guard = 0;
    while (nextBarTime < horizon && guard++ < 8) {
      const seconds = barSeconds(intensity);
      const notes = arpeggioFor(barIndex, 8);
      const step = seconds / 8;
      for (let i = 0; i < notes.length; i++) {
        const t = nextBarTime + i * step - ctx.currentTime;
        if (t < 0) continue;
        scheduleNote(midiToFrequency(notes[i]), t, step * 0.9, 0.16, 'triangle', musicGain);
        if (layersFor(intensity) > 1 && i % 4 === 0) {
          scheduleNote(midiToFrequency(notes[i] - 12), t, step * 1.4, 0.12, 'sine', musicGain);
        }
        scheduled++;
      }
      if (barIndex % 4 === 0) {
        const chord = chordAt(barIndex);
        for (const offset of chord.offsets) {
          scheduleNote(midiToFrequency(45 + chord.root + offset), nextBarTime - ctx.currentTime, seconds * 0.9, 0.05, 'sine', musicGain);
        }
      }
      nextBarTime += seconds;
      barIndex++;
    }
    return scheduled;
  }

  function scheduleNote(freq, start, duration, gain, type, destination) {
    const t0 = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.05, duration * 0.3));
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(env);
    env.connect(destination ?? musicGain);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  return {
    unlock,
    play,
    setMuted,
    isMuted: () => muted,
    isUnlocked: () => unlocked,
    hasContext: () => Boolean(ctx),
    state: () => (ctx ? ctx.state : 'none'),
    startMusic,
    stopMusic,
    updateMusic,
    setIntensity,
    intensity: () => intensity,
    barIndex: () => barIndex,
    /** 消层音效的音高随一次消掉几层抬高 */
    clearLayers: (count) => play('clear', count),
  };
}

export { intensityFor };
