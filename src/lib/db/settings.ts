import { db } from './db'
import type { AppSettings, ArbitratorConfig, Lang, ProviderConfig } from '../types'
import { newId } from '../util/id'

const SINGLETON = 'singleton'

export const defaultProvider = (): ProviderConfig => ({
  id: newId(),
  label: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: '',
  targetModel: 'openai/gpt-4o-mini',
  judgeModel: 'openai/gpt-4o',
  requestTimeoutMs: 60_000,
  maxRetries: 5,
})

export const defaultArbitrator = (): ArbitratorConfig => ({
  enabled: false,
  baseUrl: '',
  apiKey: '',
  model: '',
})

export const defaultSettings = (lang: Lang = 'en'): AppSettings => ({
  lang,
  provider: defaultProvider(),
  arbitrator: defaultArbitrator(),
  judgeTemperature: 0.2,
  targetTemperature: 0.7,
  mutatorTemperature: 0.7,
  sampleSizePerIter: 4,
  concurrency: 4,
})

export async function getSettings(): Promise<AppSettings> {
  const d = await db()
  const row = await d.get('settings', SINGLETON)
  if (!row) return defaultSettings()
  const { id: _, ...rest } = row
  // Forward-compat: older persisted rows may not have `arbitrator` and may
  // carry a stale `mutatorModel`. Strip the dead field and backfill defaults.
  const cleaned = rest as AppSettings
  if (!cleaned.arbitrator) cleaned.arbitrator = defaultArbitrator()
  // `mutatorModel` removal is best-effort — `delete` is harmless if absent.
  const provider = cleaned.provider as ProviderConfig & { mutatorModel?: string }
  if ('mutatorModel' in provider) delete provider.mutatorModel
  cleaned.provider = provider
  return cleaned
}

export async function putSettings(s: AppSettings): Promise<void> {
  const d = await db()
  await d.put('settings', { ...s, id: SINGLETON })
}