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

type ModelSettingsPatch = Pick<SettingsPatch, 'provider' | 'arbitrator'>
export interface PendingSettingsDraft {
  revision: number
  patch: ModelSettingsPatch
  fieldRevisions: { provider: Record<string, number>; arbitrator: Record<string, number> }
  status: 'dirty' | 'saving' | 'failed'
}

// Tab memory only: these values must never feed a worker or credential cache.
// Keep the committed `settings` store authoritative for all model requests.
export const settingsDraft = writable<PendingSettingsDraft | null>(null)
let draftRevision = 0

export function stageSettingsDraft(patch: ModelSettingsPatch): number {
  const previous = get(settingsDraft)
  const snapshot = structuredClone(patch)
  const revision = ++draftRevision
  settingsDraft.set({
    revision,
    patch: {
      provider: { ...previous?.patch.provider, ...snapshot.provider },
      arbitrator: { ...previous?.patch.arbitrator, ...snapshot.arbitrator },
    },
    fieldRevisions: {
      provider: { ...previous?.fieldRevisions.provider, ...Object.fromEntries(Object.keys(snapshot.provider ?? {}).map((key) => [key, revision])) },
      arbitrator: { ...previous?.fieldRevisions.arbitrator, ...Object.fromEntries(Object.keys(snapshot.arbitrator ?? {}).map((key) => [key, revision])) },
    },
    status: 'dirty',
  })
  return revision
}

export async function persistSettingsDraft(): Promise<boolean> {
  const pending = get(settingsDraft)
  if (!pending) return true
  settingsDraft.set({ ...pending, status: 'saving' })
  try {
    await writeSettings(pending.patch, pending)
    if (get(settingsDraft)?.revision !== pending.revision) return false
    settingsDraft.set(null)
    return true
  } catch (error) {
    settingsDraft.update((current) => current?.revision === pending.revision ? { ...current, status: 'failed' } : current)
    throw error
  }
}

function retainedDraftFields<T extends object>(fields: T | undefined, submitted: Record<string, number>, current?: Record<string, number>): T {
  return Object.fromEntries(Object.entries(fields ?? {}).filter(([key]) => submitted[key] === current?.[key])) as T
}

function supersedeDraftFields(patch: SettingsPatch, submitted: PendingSettingsDraft | null) {
  const current = get(settingsDraft)
  if (!submitted || !current) return
  const remaining = structuredClone(current)
  for (const role of ['provider', 'arbitrator'] as const) {
    for (const key of Object.keys(patch[role] ?? {})) {
      const revision = submitted.fieldRevisions[role][key]
      if (revision !== undefined && remaining.fieldRevisions[role][key] === revision) {
        delete (remaining.patch[role] as Record<string, unknown>)[key]
        delete remaining.fieldRevisions[role][key]
      }
    }
  }
  settingsDraft.set(Object.keys(remaining.patch.provider ?? {}).length || Object.keys(remaining.patch.arbitrator ?? {}).length ? remaining : null)
}

async function writeSettings(patch: SettingsPatch, draft?: PendingSettingsDraft): Promise<void> {
  // Snapshot the caller's draft now, then merge with the latest committed
  // settings when this write gets its turn. A failed write must not publish.
  const snapshot = structuredClone(patch)
  const pendingAtRequest = get(settingsDraft)
  const save = saveQueue.then(async () => {
    const pending = get(settingsDraft)
    // A newer explicit model save can supersede fields while this draft waits
    // in the queue. Never reintroduce those fields from an older snapshot.
    const effective = draft ? {
      ...snapshot,
      provider: retainedDraftFields(snapshot.provider, draft.fieldRevisions.provider, pending?.fieldRevisions.provider),
      arbitrator: retainedDraftFields(snapshot.arbitrator, draft.fieldRevisions.arbitrator, pending?.fieldRevisions.arbitrator),
    } : snapshot
    if (draft && !Object.keys(effective.provider ?? {}).length && !Object.keys(effective.arbitrator ?? {}).length) return
    const current = get(settings)
    const next = {
      ...current,
      ...effective,
      provider: { ...current.provider, ...effective.provider },
      arbitrator: { ...current.arbitrator, ...effective.arbitrator },
    }
    await putSettings(next)
    settings.set(next)
    if (!draft) supersedeDraftFields(snapshot, pendingAtRequest)
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

export function saveSettings(patch: SettingsPatch): Promise<void> {
  return writeSettings(patch)
}

export async function setLang(lang: Lang): Promise<void> {
  await saveSettings({ lang })
}
