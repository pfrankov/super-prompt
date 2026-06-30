import { ApiError } from './errors'

export interface ModelRoute {
  baseUrl: string
  apiKey: string
  model: string
}

interface RateLimitBody {
  rateLimit?: {
    cooldownMs?: number
    cooldownUntil?: number
    message?: string
    model?: string
    providerName?: string
    raw?: string
  }
}

interface RouteState {
  tail: Promise<unknown>
  cooldownUntil: number
  message: string
}

const routeStates = new Map<string, RouteState>()

export function clearModelRateLimits(): void {
  routeStates.clear()
}

export function modelRouteKey(route: ModelRoute): string {
  const base = route.baseUrl.replace(/\/+$/, '').toLowerCase()
  return `${base}|${route.model.trim()}|${authBucket(route.apiKey)}`
}

export async function withModelRateLimit<T>(route: ModelRoute, fn: () => Promise<T>): Promise<T> {
  const key = modelRouteKey(route)
  const state = stateFor(key)
  const run = async () => {
    assertReady(route, state)
    try {
      return await fn()
    } catch (e) {
      recordCooldown(route, state, e)
      throw e
    }
  }
  const pending = state.tail.then(run, run)
  state.tail = pending.catch(() => undefined)
  return pending
}

function stateFor(key: string): RouteState {
  let state = routeStates.get(key)
  if (!state) {
    state = { tail: Promise.resolve(), cooldownUntil: 0, message: '' }
    routeStates.set(key, state)
  }
  return state
}

function assertReady(route: ModelRoute, state: RouteState) {
  const remainingMs = state.cooldownUntil - Date.now()
  if (remainingMs <= 0) return
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000))
  throw new ApiError({
    status: 429,
    message: state.message || `Model ${route.model} is rate-limited. Retry in about ${seconds}s or switch model/key.`,
    body: {
      rateLimit: {
        cooldownMs: remainingMs,
        cooldownUntil: state.cooldownUntil,
        message: state.message,
        model: route.model,
      },
    },
    retriable: false,
  })
}

function recordCooldown(route: ModelRoute, state: RouteState, e: unknown) {
  if (!(e instanceof ApiError) || e.status !== 429) return
  const rateLimit = (e.body as RateLimitBody | undefined)?.rateLimit
  if (!rateLimit?.cooldownMs) return
  state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + rateLimit.cooldownMs)
  state.message = rateLimit.message || `Model ${route.model} is rate-limited. Retry shortly or switch model/key.`
}

function authBucket(apiKey: string): string {
  const key = apiKey.trim()
  if (!key) return 'anon'
  let hash = 0
  for (let i = 0; i < key.length; i += 1) {
    hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0
  }
  return `key:${Math.abs(hash).toString(36)}:${key.length}`
}
