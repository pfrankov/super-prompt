import { writable, get } from 'svelte/store'
import { locale } from 'svelte-i18n'
import type { AppSettings, Lang } from '../lib/types'
import { defaultSettings, getSettings, putSettings } from '../lib/db/settings'

export const settings = writable<AppSettings>(defaultSettings())

let loaded = false

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

export async function saveSettings(patch: Partial<AppSettings>): Promise<void> {
  const next = { ...get(settings), ...patch }
  settings.set(next)
  try {
    await putSettings(next)
  } catch (e) {
    console.error('[settings] persist failed', e)
  }
}

export async function setLang(lang: Lang): Promise<void> {
  localStorage.setItem('sp.lang', lang)
  locale.set(lang)
  await saveSettings({ lang })
}
