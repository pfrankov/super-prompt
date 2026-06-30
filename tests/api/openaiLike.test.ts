import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { chatCompletion, chatCompletionWithRetry } from '../../src/lib/api/openaiLike'
import { ApiError } from '../../src/lib/api/errors'
import { clearModelRateLimits } from '../../src/lib/api/modelRateLimit'

const okResponse = (text: string, usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({
    model: 'gpt-x',
    choices: [{ message: { content: text } }],
    usage,
  }),
  headers: new Headers(),
} as unknown as Response)

const errResponse = (status: number, body: unknown) => ({
  ok: false,
  status,
  text: async () => JSON.stringify(body),
  headers: new Headers(),
} as unknown as Response)

describe('chatCompletion', () => {
  beforeEach(() => {
    clearModelRateLimits()
    global.fetch = vi.fn()
  })
  afterEach(() => {
    clearModelRateLimits()
    vi.restoreAllMocks()
  })

  it('posts to {baseUrl}/chat/completions with bearer token', async () => {
    ;(global.fetch as any).mockResolvedValueOnce(okResponse('hello'))
    const r = await chatCompletion({
      baseUrl: 'https://example.com/v1',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(r.text).toBe('hello')
    const [url, init] = (global.fetch as any).mock.calls[0]
    expect(url).toBe('https://example.com/v1/chat/completions')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('m')
    expect(init.headers.Authorization).toBe('Bearer k')
  })

  it('omits Authorization header when apiKey is empty', async () => {
    ;(global.fetch as any).mockResolvedValueOnce(okResponse('ok'))
    await chatCompletion({ baseUrl: 'http://l', apiKey: '', model: 'm', messages: [] })
    const [, init] = (global.fetch as any).mock.calls[0]
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('serves mock:// providers without network fetch', async () => {
    const r = await chatCompletion({
      baseUrl: 'mock://super-prompt',
      apiKey: '',
      model: 'mock-judge',
      messages: [
        { role: 'system', content: 'You prepare evaluation context for prompt optimization.' },
        { role: 'user', content: 'Produce exactly 3 diverse eval examples.\n\nSYSTEM PROMPT:\nReturn only numbers.' },
      ],
    })
    expect(global.fetch).not.toHaveBeenCalled()
    expect(JSON.parse(r.text).examples).toHaveLength(3)
    expect(r.usage.totalTokens).toBeGreaterThan(0)
  })

  it('throws ApiError on 5xx with retriable=true', async () => {
    ;(global.fetch as any).mockResolvedValueOnce(errResponse(503, { error: { message: 'down' } }))
    await expect(
      chatCompletion({ baseUrl: 'http://l', apiKey: 'k', model: 'm', messages: [] })
    ).rejects.toMatchObject({ status: 503, retriable: true, message: 'down' })
  })

  it('throws ApiError on 4xx with retriable=false', async () => {
    ;(global.fetch as any).mockResolvedValueOnce(errResponse(400, { error: { message: 'bad' } }))
    await expect(
      chatCompletion({ baseUrl: 'http://l', apiKey: 'k', model: 'm', messages: [] })
    ).rejects.toMatchObject({ status: 400, retriable: false })
  })

  it('spaces same-model requests with configured RPM limits', async () => {
    vi.useFakeTimers()
    try {
      ;(global.fetch as any).mockResolvedValue(okResponse('ok'))
      const req = {
        baseUrl: 'http://l',
        apiKey: 'k',
        model: 'limited-model',
        messages: [],
        rateLimits: [{ id: 'r1', enabled: true, model: 'limited-model', requestsPerMinute: 60 }],
      }

      await chatCompletion(req)
      const second = chatCompletion(req)
      await vi.advanceTimersByTimeAsync(999)
      expect(global.fetch).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1)
      await expect(second).resolves.toMatchObject({ text: 'ok' })
      expect(global.fetch).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not throttle a different model with the same provider key', async () => {
    vi.useFakeTimers()
    try {
      ;(global.fetch as any).mockResolvedValue(okResponse('ok'))
      const rateLimits = [{ id: 'r1', enabled: true, model: 'limited-model', requestsPerMinute: 60 }]

      await chatCompletion({ baseUrl: 'http://l', apiKey: 'k', model: 'limited-model', messages: [], rateLimits })
      const other = await chatCompletion({ baseUrl: 'http://l', apiKey: 'k', model: 'other-model', messages: [], rateLimits })

      expect(other.text).toBe('ok')
      expect(global.fetch).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not serialize same-model requests when no RPM rule is configured', async () => {
    let releaseFetch!: () => void
    const blocked = new Promise<Response>((resolve) => {
      releaseFetch = () => resolve(okResponse('ok'))
    })
    ;(global.fetch as any).mockReturnValue(blocked)

    const req = {
      baseUrl: 'http://l',
      apiKey: 'k',
      model: 'unlimited-model',
      messages: [],
    }
    const first = chatCompletion(req)
    const second = chatCompletion(req)

    await Promise.resolve()
    expect(global.fetch).toHaveBeenCalledTimes(2)
    releaseFetch()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })
})

describe('chatCompletionWithRetry', () => {
  beforeEach(() => {
    clearModelRateLimits()
    global.fetch = vi.fn()
  })
  afterEach(() => {
    clearModelRateLimits()
    vi.restoreAllMocks()
  })

  it('retries on 429 then succeeds', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce(errResponse(429, { error: { message: 'rate' } }))
      .mockResolvedValueOnce(okResponse('done'))
    const r = await chatCompletionWithRetry(
      { baseUrl: 'http://l', apiKey: 'k', model: 'm', messages: [] },
      3
    )
    expect(r.text).toBe('done')
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('does not retry on 4xx (non-429)', async () => {
    ;(global.fetch as any).mockResolvedValueOnce(errResponse(400, { error: { message: 'no' } }))
    await expect(
      chatCompletionWithRetry({ baseUrl: 'http://l', apiKey: 'k', model: 'm', messages: [] }, 5)
    ).rejects.toBeInstanceOf(ApiError)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('waits through OpenRouter upstream cooldowns before retrying the same model route', async () => {
    vi.useFakeTimers()
    try {
      ;(global.fetch as any)
        .mockResolvedValueOnce(errResponse(429, {
          error: {
            message: 'Provider returned error',
            code: 429,
            metadata: {
              raw: 'google/gemma-4-26b-a4b-it:free is temporarily rate-limited upstream. Please retry shortly, or add your own key.',
              provider_name: 'Google AI Studio',
              is_byok: false,
            },
          },
        }))
        .mockResolvedValueOnce(okResponse('same model ok'))
        .mockResolvedValueOnce(okResponse('other model ok'))

      const rateLimitedReq = {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: '',
        model: 'google/gemma-4-26b-a4b-it:free',
        messages: [],
      }
      const sameModel = chatCompletionWithRetry(rateLimitedReq, 1)
      await vi.advanceTimersByTimeAsync(59_999)
      expect(global.fetch).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1)
      await expect(sameModel).resolves.toMatchObject({ text: 'same model ok' })
      expect(global.fetch).toHaveBeenCalledTimes(2)

      const other = await chatCompletionWithRetry({
        ...rateLimitedReq,
        model: 'openai/gpt-4o-mini',
      }, 0)
      expect(other.text).toBe('other model ok')
      expect(global.fetch).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
