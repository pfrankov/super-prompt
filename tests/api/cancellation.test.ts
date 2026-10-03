import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../src/lib/api/errors'
import { clearModelRateLimits } from '../../src/lib/api/modelRateLimit'
import { chatCompletion, chatCompletionWithRetry, type ChatRequest } from '../../src/lib/api/openaiLike'
import { withBackoff } from '../../src/lib/api/retry'

const request: ChatRequest = {
  baseUrl: 'https://provider.test/v1', apiKey: '', model: 'target', messages: [], timeoutMs: 100,
}
const response = () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))

function observe<T>(promise: Promise<T>) {
  const result: { value?: T; error?: unknown; settled: boolean } = { settled: false }
  void promise.then(
    (value) => Object.assign(result, { value, settled: true }),
    (error: unknown) => Object.assign(result, { error, settled: true }),
  )
  return result
}

function untilAborted<T>(signal: AbortSignal): Promise<T> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

describe('request cancellation and deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearModelRateLimits()
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    clearModelRateLimits()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('never fetches an already-cancelled request', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.mocked(fetch).mockImplementation((_url, init) => untilAborted(init!.signal!))
    const result = observe(chatCompletion({ ...request, signal: controller.signal }))
    await vi.advanceTimersByTimeAsync(0)
    expect(result.error).toBe(controller.signal.reason)
    expect(fetch).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains the deadline when a caller signal is supplied', async () => {
    const controller = new AbortController()
    vi.mocked(fetch).mockImplementation((_url, init) => untilAborted(init!.signal!))
    const result = observe(chatCompletion({ ...request, signal: controller.signal }))
    await vi.advanceTimersByTimeAsync(100)
    expect(result.error).toMatchObject({ status: 408, retriable: true, message: 'Request timed out' })
    expect(controller.signal.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the deadline active while consuming the response body', async () => {
    vi.mocked(fetch).mockImplementation(async (_url, init) => ({
      ...response(), text: () => untilAborted<string>(init!.signal!),
    } as Response))
    const result = observe(chatCompletion(request))
    await vi.advanceTimersByTimeAsync(100)
    expect(result.error).toMatchObject({ status: 408, retriable: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates caller cancellation without retrying an active fetch', async () => {
    const controller = new AbortController()
    const reason = new TypeError('User cancelled')
    vi.mocked(fetch).mockImplementation((_url, init) => untilAborted(init!.signal!))
    const onRetry = vi.fn()
    const result = observe(chatCompletionWithRetry({ ...request, signal: controller.signal }, 3, onRetry))
    await vi.dynamicImportSettled()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    controller.abort(reason)
    await vi.advanceTimersByTimeAsync(0)
    expect(result.error).toBe(reason)
    expect(onRetry).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('still retries a timeout when the caller has not cancelled', async () => {
    const controller = new AbortController()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    vi.mocked(fetch)
      .mockImplementationOnce((_url, init) => untilAborted(init!.signal!))
      .mockImplementationOnce(async () => response())
    const onRetry = vi.fn()
    const result = observe(chatCompletionWithRetry({ ...request, signal: controller.signal }, 1, onRetry))
    await vi.dynamicImportSettled()
    await vi.advanceTimersByTimeAsync(500)
    expect(result.value?.text).toBe('ok')
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(controller.signal.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a provider cooldown without waiting or retrying', async () => {
    const controller = new AbortController()
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Rate limited' } }), {
      status: 429, headers: { 'retry-after': '60' },
    }))
    const result = observe(chatCompletionWithRetry({ ...request, signal: controller.signal }, 3))
    await vi.dynamicImportSettled()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(result.error).toBe(controller.signal.reason)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('preserves caller cancellation during body reads', async () => {
    const controller = new AbortController()
    vi.mocked(fetch).mockImplementation(async (_url, init) => ({
      ...response(), text: () => untilAborted<string>(init!.signal!),
    } as Response))
    const result = observe(chatCompletion({ ...request, signal: controller.signal }))
    await vi.advanceTimersByTimeAsync(0)
    controller.abort('cancelled by caller')
    await vi.advanceTimersByTimeAsync(0)
    expect(result.error).toBe('cancelled by caller')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels retry backoff immediately without another attempt', async () => {
    const controller = new AbortController()
    const fn = vi.fn(async () => { throw new ApiError({ status: 503 }) })
    const result = observe(withBackoff(fn, {
      maxRetries: 3, baseMs: 1000, capMs: 8000, jitter: 'none', signal: controller.signal,
    }))
    await vi.advanceTimersByTimeAsync(0)
    expect(fn).toHaveBeenCalledTimes(1)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(result.error).toBe(controller.signal.reason)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not invoke backoff work for an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const fn = vi.fn(async () => 'ok')
    const result = observe(withBackoff(fn, {
      maxRetries: 3, baseMs: 1000, capMs: 8000, signal: controller.signal,
    }))
    await vi.advanceTimersByTimeAsync(0)
    expect(result.error).toBe(controller.signal.reason)
    expect(fn).not.toHaveBeenCalled()
  })

  it('does not schedule another attempt when onRetry cancels', async () => {
    const controller = new AbortController()
    const fn = vi.fn(async () => { throw new ApiError({ status: 503 }) })
    const result = observe(withBackoff(fn, {
      maxRetries: 3, baseMs: 1000, capMs: 8000, signal: controller.signal,
      onRetry: () => controller.abort(),
    }))
    await vi.advanceTimersByTimeAsync(0)
    expect(result.error).toBe(controller.signal.reason)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a global rate-limit delay and does not reserve its request slot', async () => {
    vi.mocked(fetch).mockImplementation(async () => response())
    await chatCompletion(request)
    const controller = new AbortController()
    const cancelled = observe(chatCompletion({ ...request, signal: controller.signal }))
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(cancelled.error).toBe(controller.signal.reason)
    const next = observe(chatCompletion({ ...request, model: 'other' }))
    await vi.advanceTimersByTimeAsync(400)
    expect(next.value?.text).toBe('ok')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('cancels before reaching the head of the global queue', async () => {
    vi.mocked(fetch).mockImplementation(async () => response())
    await chatCompletion(request)
    const second = observe(chatCompletion(request))
    const controller = new AbortController()
    const cancelled = observe(chatCompletion({ ...request, signal: controller.signal }))
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(cancelled.error).toBe(controller.signal.reason)
    await vi.advanceTimersByTimeAsync(1000)
    expect(second.value?.text).toBe('ok')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('cancels a configured RPM delay without postponing the next request', async () => {
    vi.mocked(fetch).mockImplementation(async () => response())
    const limited = { ...request, rateLimits: [{ id: 'limit', enabled: true, model: 'target', requestsPerMinute: 60 }] }
    await chatCompletion(limited)
    const controller = new AbortController()
    const cancelled = observe(chatCompletion({ ...limited, signal: controller.signal }))
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(cancelled.error).toBe(controller.signal.reason)
    const next = observe(chatCompletion(limited))
    await vi.advanceTimersByTimeAsync(900)
    expect(next.value?.text).toBe('ok')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('cancels an RPM-queued request before the previous fetch finishes', async () => {
    let resolveFirst!: (value: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
    vi.mocked(fetch).mockImplementation(async () => response())
    const limited = {
      ...request, timeoutMs: 5000,
      rateLimits: [{ id: 'limit', enabled: true, model: 'target', requestsPerMinute: 60 }],
    }
    const first = observe(chatCompletion(limited))
    const controller = new AbortController()
    const cancelled = observe(chatCompletion({ ...limited, signal: controller.signal }))
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(cancelled.error).toBe(controller.signal.reason)
    resolveFirst(response())
    await vi.advanceTimersByTimeAsync(1000)
    expect(first.value?.text).toBe('ok')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('cancels mock requests with the original reason and removes the delay', async () => {
    const controller = new AbortController()
    const reason = new Error('Cancel mock')
    const result = observe(chatCompletion({ ...request, baseUrl: 'mock://super-prompt', signal: controller.signal }))
    controller.abort(reason)
    await vi.advanceTimersByTimeAsync(0)
    expect(result.error).toBe(reason)
    expect(vi.getTimerCount()).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects a pre-cancelled mock request without starting its timer', async () => {
    const controller = new AbortController()
    controller.abort('Mock cancelled')
    const result = observe(chatCompletion({ ...request, baseUrl: 'mock://super-prompt', signal: controller.signal }))
    await vi.advanceTimersByTimeAsync(0)
    expect(result.error).toBe(controller.signal.reason)
    expect(vi.getTimerCount()).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('removes caller abort listeners and deadline timers after success', async () => {
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    vi.mocked(fetch).mockImplementation(async () => response())
    await chatCompletion({ ...request, signal: controller.signal })
    for (const [event, listener] of add.mock.calls) {
      expect(remove).toHaveBeenCalledWith(event, listener)
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans up listeners and timers after HTTP failure', async () => {
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 400 }))
    await expect(chatCompletion({ ...request, signal: controller.signal })).rejects.toMatchObject({ status: 400 })
    for (const [event, listener] of add.mock.calls) {
      expect(remove).toHaveBeenCalledWith(event, listener)
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('removes the mock abort listener after success', async () => {
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const result = observe(chatCompletion({ ...request, baseUrl: 'mock://super-prompt', signal: controller.signal }))
    await vi.advanceTimersByTimeAsync(180)
    expect(result.settled).toBe(true)
    for (const [event, listener] of add.mock.calls) {
      expect(remove).toHaveBeenCalledWith(event, listener)
    }
    expect(vi.getTimerCount()).toBe(0)
  })
})
