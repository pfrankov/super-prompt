import { ApiError } from './errors'

export interface BackoffOptions {
  maxRetries: number
  baseMs: number
  capMs: number
  jitter?: 'full' | 'none'
  onRetry?: (info: { attempt: number; delayMs: number; error: ApiError }) => void
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Retry an async function with exponential backoff + jitter.
 * Only retries if the thrown error is an ApiError with `retriable: true`,
 * OR if the function throws a network-like error (TypeError, fetch failures).
 * Honors `Retry-After` header if present on ApiError.
 */
export async function withBackoff<T>(fn: () => Promise<T>, opts: BackoffOptions): Promise<T> {
  const { maxRetries, baseMs, capMs, jitter = 'full', onRetry } = opts
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (e) {
      const isApi = e instanceof ApiError
      const isNetwork = e instanceof TypeError
      if (!isApi && !isNetwork) throw e
      if (isApi && !e.retriable) throw e
      if (attempt >= maxRetries) throw e
      const retryAfterMs = isApi ? readRetryAfter(e) : 0
      const exp = Math.min(capMs, baseMs * 2 ** attempt)
      const delay =
        retryAfterMs > 0
          ? retryAfterMs
          : jitter === 'full'
            ? Math.floor(Math.random() * exp)
            : exp
      attempt++
      if (isApi) e.retried = attempt
      onRetry?.({ attempt, delayMs: delay, error: isApi ? e : new ApiError({ status: 0, cause: e }) })
      await sleep(delay)
    }
  }
}

function readRetryAfter(err: ApiError): number {
  const body = err.body
  if (body && typeof body === 'object') {
    const rateLimit = (body as { rateLimit?: { cooldownMs?: number } }).rateLimit
    if (rateLimit?.cooldownMs && Number.isFinite(rateLimit.cooldownMs)) {
      return Math.min(60_000, Math.max(0, rateLimit.cooldownMs))
    }
    const headers = (body as { headers?: Record<string, string> }).headers
    const ra = headers?.['retry-after']
    if (ra) {
      const n = Number(ra)
      if (!Number.isNaN(n)) return Math.min(60_000, n * 1000)
    }
  }
  return 0
}
