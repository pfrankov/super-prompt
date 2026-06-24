/** Concurrency-limited async runner. Preserves input order in output. */
export async function pool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return []
  const n = Math.max(1, Math.min(concurrency, items.length))
  const results: R[] = new Array(items.length)
  let cursor = 0

  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }

  await Promise.all(Array.from({ length: n }, () => worker()))
  return results
}