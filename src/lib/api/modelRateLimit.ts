import { ApiError } from './errors'
import { abortableDelay, waitWithSignal } from './abort'
import type { ModelRateLimitRule } from '../types'

export interface ModelRoute {
  baseUrl: string
  apiKey: string
  model: string
  rateLimits?: ModelRateLimitRule[]
  signal?: AbortSignal
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
  nextRequestAt: number
}

export const DEFAULT_GLOBAL_REQUESTS_PER_SECOND = 2
export const DEFAULT_GLOBAL_INTERVAL_MS = Math.ceil(1000 / DEFAULT_GLOBAL_REQUESTS_PER_SECOND)

const routeStates = new Map<string, RouteState>()
let globalTail: Promise<unknown> = Promise.resolve()
let globalNextRequestAt = 0

export function clearModelRateLimits(): void {
  routeStates.clear()
  globalTail = Promise.resolve()
  globalNextRequestAt = 0
}

export function modelRouteKey(route: ModelRoute): string {
  const base = route.baseUrl.replace(/\/+$/, '').toLowerCase()
  return `${base}|${route.model.trim()}|${authBucket(route.apiKey)}`
}

export async function withModelRateLimit<T>(route: ModelRoute, fn: () => Promise<T>): Promise<T> {
  route.signal?.throwIfAborted()
  const key = modelRouteKey(route)
  const state = stateFor(key)
  const rule = matchingModelRateLimit(route.model, route.rateLimits)
  const run = async () => {
    assertReady(route, state)
    if (rule) await waitForConfiguredSlot(rule, state, route.signal)
    assertReady(route, state)
    await waitForGlobalSlot(route.signal)
    assertReady(route, state)
    try {
      return await fn()
    } catch (e) {
      recordCooldown(route, state, e)
      throw e
    }
  }
  if (!rule) return run()
  const pending = state.tail.then(run, run)
  state.tail = pending.catch(() => undefined)
  return waitWithSignal(pending, route.signal)
}

function waitForGlobalSlot(signal?: AbortSignal): Promise<void> {
  const wait = () => waitForDefaultInterval(signal)
  const pending = globalTail.then(wait, wait)
  globalTail = pending.catch(() => undefined)
  return waitWithSignal(pending, signal)
}

async function waitForDefaultInterval(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const remainingMs = globalNextRequestAt - Date.now()
  if (remainingMs > 0) await abortableDelay(remainingMs, signal)
  signal?.throwIfAborted()
  globalNextRequestAt = Date.now() + DEFAULT_GLOBAL_INTERVAL_MS
}

function stateFor(key: string): RouteState {
  let state = routeStates.get(key)
  if (!state) {
    state = { tail: Promise.resolve(), cooldownUntil: 0, message: '', nextRequestAt: 0 }
    routeStates.set(key, state)
  }
  return state
}

export function matchingModelRateLimit(
  model: string,
  rules?: ModelRateLimitRule[]
): ModelRateLimitRule | null {
  const normalizedModel = model.trim().toLowerCase()
  if (!normalizedModel) return null
  return (rules ?? []).find((rule) => (
    rule.enabled
    && rule.model.trim().toLowerCase() === normalizedModel
    && Number.isFinite(rule.requestsPerMinute)
    && rule.requestsPerMinute > 0
  )) ?? null
}

async function waitForConfiguredSlot(rule: ModelRateLimitRule, state: RouteState, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const remainingMs = state.nextRequestAt - Date.now()
  if (remainingMs > 0) await abortableDelay(remainingMs, signal)
  signal?.throwIfAborted()
  state.nextRequestAt = Date.now() + intervalMs(rule)
}

function intervalMs(rule: ModelRateLimitRule): number {
  const requestsPerMinute = Math.max(1, Math.min(3600, Math.floor(rule.requestsPerMinute)))
  return Math.ceil(60_000 / requestsPerMinute)
}

function assertReady(route: ModelRoute, state: RouteState) {
  route.signal?.throwIfAborted()
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
    retriable: true,
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
