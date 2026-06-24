import { ApiError } from './errors'
import { isMockProviderUrl, mockChatCompletion } from './mockOpenai'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  extra?: Record<string, unknown>
  signal?: AbortSignal
  timeoutMs?: number
}

export interface ChatResponse {
  text: string
  model: string
  usage: { promptTokens: number; completionTokens: number; totalTokens: number }
  raw: unknown
}

/** Single call to a /chat/completions endpoint. No retry — wrap with withBackoff. */
export async function chatCompletion(req: ChatRequest): Promise<ChatResponse> {
  if (isMockProviderUrl(req.baseUrl)) {
    return mockChatCompletion(req)
  }

  const url = req.baseUrl.replace(/\/$/, '') + '/chat/completions'

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (req.apiKey) headers['Authorization'] = `Bearer ${req.apiKey}`

  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
  }
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens
  if (req.stop && req.stop.length) body.stop = req.stop
  if (req.extra) Object.assign(body, req.extra)

  const timeoutMs = req.timeoutMs ?? 60_000
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const signal = req.signal ?? ctrl.signal

  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })
  } catch (e) {
    clearTimeout(timer)
    if ((e as Error).name === 'AbortError') {
      throw new ApiError({ status: 408, message: 'Request timed out', retriable: true, cause: e })
    }
    throw new ApiError({ status: 0, message: 'Network error', retriable: true, cause: e })
  }
  clearTimeout(timer)

  const text = await resp.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new ApiError({
      status: resp.status,
      message: `Non-JSON response (${resp.status})`,
      body: text,
      retriable: resp.status >= 500,
    })
  }

  if (!resp.ok) {
    throw new ApiError({
      status: resp.status,
      message: extractErrorMessage(json) ?? `HTTP ${resp.status}`,
      body: { json, headers: Object.fromEntries(resp.headers.entries()) },
      retriable: resp.status === 429 || resp.status >= 500,
    })
  }

  const choice = (json as { choices?: unknown[] }).choices?.[0] as
    | { message?: { content?: string | null }; text?: string }
    | undefined
  const content = choice?.message?.content ?? choice?.text ?? ''
  const usage = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }).usage ?? {}
  return {
    text: typeof content === 'string' ? content : '',
    model: (json as { model?: string }).model ?? req.model,
    usage: {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
    },
    raw: json,
  }
}

function extractErrorMessage(json: unknown): string | null {
  if (json && typeof json === 'object') {
    const e = (json as { error?: { message?: string } }).error
    if (e?.message) return e.message
    const m = (json as { message?: string }).message
    if (m) return m
  }
  return null
}

/** Convenience: call with retry. */
export async function chatCompletionWithRetry(
  req: ChatRequest,
  maxRetries = 5,
  onRetry?: (info: { attempt: number; delayMs: number }) => void
): Promise<ChatResponse> {
  const { withBackoff } = await import('./retry')
  return withBackoff(() => chatCompletion(req), {
    maxRetries,
    baseMs: 500,
    capMs: 8000,
    onRetry,
  })
}
