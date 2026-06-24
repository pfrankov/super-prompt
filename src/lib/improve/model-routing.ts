import type { ProviderConfig } from '../types'
import { isMockProviderUrl, mockModelList } from '../api/mockOpenai'

export type ProviderKind = 'local' | 'cloud'

export interface JudgeModelSelection {
  model: string
  reason: string
  providerKind: ProviderKind
  fallback: boolean
}

const NON_CHAT_RE = /(embed|embedding|bge|nomic|all-minilm|rerank|vision|whisper|tts|stt)/i

export function providerKindFromBaseUrl(baseUrl: string): ProviderKind {
  if (isMockProviderUrl(baseUrl)) return 'local'
  try {
    const host = new URL(baseUrl).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' ? 'local' : 'cloud'
  } catch {
    return 'cloud'
  }
}

export function isRunnableProvider(provider: Pick<ProviderConfig, 'baseUrl' | 'apiKey'>): boolean {
  if (isMockProviderUrl(provider.baseUrl)) return true
  if (provider.apiKey.trim()) return true
  return providerKindFromBaseUrl(provider.baseUrl) === 'local'
}

export function normalizeModelList(models: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of models) {
    const model = raw.trim()
    if (!model || NON_CHAT_RE.test(model) || seen.has(model)) continue
    seen.add(model)
    out.push(model)
  }
  return out
}

function localRank(model: string): number {
  const m = model.toLowerCase()
  if (/gemma/.test(m)) return 500
  if (/(llama|mistral|phi)/.test(m)) return 400
  if (/qwen/.test(m)) return 300
  return 100
}

function cloudRank(model: string): number {
  const m = model.toLowerCase()
  if (/(gpt-4\.1|gpt-4o|o4|o3)/.test(m)) return 700
  if (/(claude-3\.7|claude-3-7|claude-3\.5|claude-3-5|sonnet)/.test(m)) return 650
  if (/(gemini-2|gemini-1\.5-pro)/.test(m)) return 620
  if (/(llama-3\.3|llama-3\.1).*(70b|405b)/.test(m)) return 560
  if (/(mistral-large|mixtral|qwen.*(max|plus|72b|110b))/.test(m)) return 520
  if (/(gemma|llama|mistral|phi|qwen)/.test(m)) return 300
  return 100
}

function pickBest(models: string[], kind: ProviderKind, targetModel: string): string {
  const normalized = normalizeModelList(models)
  const pool = normalized.length ? normalized : [targetModel.trim()].filter(Boolean)
  const rank = kind === 'local' ? localRank : cloudRank
  return [...pool].sort((a, b) => {
    const delta = rank(b) - rank(a)
    if (delta !== 0) return delta
    if (a === targetModel) return 1
    if (b === targetModel) return -1
    return a.localeCompare(b)
  })[0] ?? targetModel
}

export function selectJudgeModel(
  models: string[],
  targetModel: string,
  providerKind: ProviderKind
): JudgeModelSelection {
  const target = targetModel.trim()
  const model = pickBest(models, providerKind, target)
  const fallback = !model || model === target
  if (!model) {
    return {
      model: target,
      providerKind,
      fallback: true,
      reason: 'No chat models were detected; using the target model for judge and mutator.',
    }
  }
  if (providerKind === 'local') {
    return {
      model,
      providerKind,
      fallback,
      reason: fallback
        ? 'Only the target model looked usable locally; judge JSON health will decide whether it is safe.'
        : 'Picked the most JSON-stable local chat model for judge and mutator.',
    }
  }
  return {
    model,
    providerKind,
    fallback,
    reason: fallback
      ? 'Using the target model for judge and mutator because no stronger chat model was detected.'
      : 'Picked the strongest detected hosted model for judge and mutator.',
  }
}

export async function listProviderModels(provider: Pick<ProviderConfig, 'baseUrl' | 'apiKey'>): Promise<string[]> {
  if (isMockProviderUrl(provider.baseUrl)) return mockModelList()
  const baseUrl = provider.baseUrl.replace(/\/$/, '')
  const headers: Record<string, string> = {}
  if (provider.apiKey.trim()) headers.Authorization = `Bearer ${provider.apiKey}`
  const response = await fetch(`${baseUrl}/models`, { headers })
  if (!response.ok) throw new Error(`models_failed_${response.status}`)
  const json = await response.json() as { data?: Array<{ id?: string }>; models?: string[] }
  if (Array.isArray(json.data)) {
    return json.data.map((m) => m.id).filter((m): m is string => !!m)
  }
  if (Array.isArray(json.models)) return json.models
  return []
}
