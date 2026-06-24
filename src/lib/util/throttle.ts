/** Trailing-edge throttle — invokes `fn` at most once per `delayMs`. */
export function throttle<T extends (...args: unknown[]) => void>(
  fn: T,
  delayMs = 200
): T & { cancel: () => void } {
  let lastCall = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let pendingArgs: unknown[] | null = null

  const wrapped = ((...args: unknown[]) => {
    const now = Date.now()
    const remaining = delayMs - (now - lastCall)
    pendingArgs = args
    if (remaining <= 0) {
      lastCall = now
      pendingArgs = null
      fn(...args)
    } else if (!timer) {
      timer = setTimeout(() => {
        lastCall = Date.now()
        timer = null
        if (pendingArgs) {
          const a = pendingArgs
          pendingArgs = null
          fn(...a)
        }
      }, remaining)
    }
  }) as T & { cancel: () => void }

  wrapped.cancel = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    pendingArgs = null
  }

  return wrapped
}