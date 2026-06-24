/** Seeded RNG (Mulberry32) — reproducible sampling per iteration. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Sample k items without replacement from `arr` using a seeded RNG. */
export function sample<T>(arr: T[], k: number, rng: () => number): T[] {
  if (k >= arr.length) return [...arr]
  const a = [...arr]
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (a.length - i))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a.slice(0, k)
}