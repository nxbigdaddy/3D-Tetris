/**
 * 背景音乐的**纯数学**部分:调式、和声进行、琶音、紧张度 → 速度。
 *
 * 和上一个项目一样,音频全部**程序化合成、零素材** —— 这样单文件才能真正自包含。
 * 但「音高/和声/速度」这些是纯数学,放在 core 里就能测:
 * 和弦是否在音阶内、进行是否循环、紧张度是否单调有界、频率是否落在合理区间。
 */

/** 自然小调音阶(相对主音的半音数) */
export const MINOR_SCALE = Object.freeze([0, 2, 3, 5, 7, 8, 10]);

/** 四个和弦的循环:Am → F → C → G(用相对主音的半音偏移表示) */
export const PROGRESSION = Object.freeze([
  { name: 'Am', root: 0, offsets: [0, 3, 7] },
  { name: 'F', root: -4, offsets: [0, 4, 7] },
  { name: 'C', root: 3, offsets: [0, 4, 7] },
  { name: 'G', root: -2, offsets: [0, 4, 7] },
]);

/** 主音(A2) */
export const ROOT_MIDI = 45;

export function midiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** 第 bar 小节用哪个和弦(循环,负数和越界都安全) */
export function chordAt(bar) {
  const index = ((Number.isFinite(bar) ? Math.floor(bar) : 0) % PROGRESSION.length + PROGRESSION.length) % PROGRESSION.length;
  return PROGRESSION[index];
}

/**
 * 一小节的琶音音高序列。
 * 走到高八度再落回来,听感上像「一直在往上爬」但不会真的越来越高。
 */
export function arpeggioFor(bar, steps = 8) {
  const chord = chordAt(bar);
  const shape = [0, 1, 2, 1];
  const notes = [];
  for (let i = 0; i < steps; i++) {
    const step = shape[i % shape.length];
    const octave = i < steps / 2 ? 12 : 24;
    notes.push(ROOT_MIDI + chord.root + chord.offsets[step % chord.offsets.length] + octave);
  }
  return notes;
}

/**
 * 紧张度 0..1:等级越高越紧,井里堆得越高也越紧。
 * 两项都必须单调 —— 这是「音乐跟着局势走」的全部含义。
 */
export function intensityFor({ level = 1, fill = 0 } = {}) {
  const levelPart = Math.min(0.6, Math.max(0, (level - 1) * 0.075));
  const fillPart = Math.min(0.55, Math.max(0, fill) * 0.55);
  return Math.max(0, Math.min(1, levelPart + fillPart));
}

/** 紧张度 → 速度(bpm):越紧越快 */
export function tempoFor(intensity) {
  const t = Math.max(0, Math.min(1, Number.isFinite(intensity) ? intensity : 0));
  return 82 + t * 62;
}

/** 一小节多少秒 */
export function barSeconds(intensity, beatsPerBar = 4) {
  return (60 / tempoFor(intensity)) * beatsPerBar;
}

/** 紧张度高的时候多铺一层(低八度脉冲) */
export function layersFor(intensity) {
  return intensity > 0.55 ? 2 : 1;
}
