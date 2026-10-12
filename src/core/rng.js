/** 可复现的伪随机数(同一个种子永远给同一串数)—— 方块序列、测试都靠它 */

/** mulberry32:短小、够均匀,而且是确定性的 */
export function createRng(seed = 1) {
  let state = (Number.isFinite(seed) ? Math.floor(seed) : 1) >>> 0;
  if (state === 0) state = 0x9e3779b9;

  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    /** [0, 1) */
    next,
    /** [0, n) 的整数 */
    int: (n) => Math.floor(next() * n),
    /** 洗牌(Fisher–Yates,不改原数组) */
    shuffle(list) {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}
