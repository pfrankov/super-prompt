import { writable, get } from 'svelte/store'
import { locale } from 'svelte-i18n'
import type { AppSettings, Lang, ProviderConfig, ArbitratorConfig } from '../lib/types'
import { defaultSettings, getSettings, putSettings } from '../lib/db/settings'

export const settings = writable<AppSettings>(defaultSettings())

let loaded = false
let saveQueue = Promise.resolve()

export async function waitForSettings(): Promise<void> {
  let pending: Promise<void>
  do {
    pending = saveQueue
    await pending
  } while (pending !== saveQueue)
}

export async function loadSettings(): Promise<void> {
  if (loaded) return
  try {
    const s = await getSettings()
    settings.set(s)
    locale.set(s.lang)
  } catch (e) {
    console.warn('[settings] load failed, using defaults', e)
  }
  loaded = true
}

export type SettingsPatch = Omit<Partial<AppSettings>, 'provider' | 'arbitrator'> & {
  provider?: Partial<ProviderConfig>
  arbitrator?: Partial<ArbitratorConfig>
}

export async function saveSettings(patch: SettingsPatch): Promise<void> {
  // Snapshot the caller's draft now, then merge with the latest committed
  // settings when this write gets its turn. A failed write must not publish.
  const snapshot = structuredClone(patch)
  const save = saveQueue.then(async () => {
    const current = get(settings)
    const next = {
      ...current,
      ...snapshot,
      provider: { ...current.provider, ...snapshot.provider },
      arbitrator: { ...current.arbitrator, ...snapshot.arbitrator },
    }
    await putSettings(next)
    settings.set(next)
    if (snapshot.lang !== undefined) {
      locale.set(next.lang)
      try { localStorage.setItem('sp.lang', next.lang) }
      catch { /* IndexedDB is authoritative; this cache only avoids a language flash. */ }
    }
  })
  // Recover the internal queue while preserving rejection for this caller.
  saveQueue = save.catch(() => {})
  return save
}

export async function setLang(lang: Lang): Promise<void> {
  await saveSettings({ lang })
}
