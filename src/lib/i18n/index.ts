import { derived, get, writable } from 'svelte/store'
import type { Readable, Writable } from 'svelte/store'
import en from './locales/en.json'
import ru from './locales/ru.json'
import type { Lang } from '../types'

type Catalog = typeof en
type Values = Record<string, string | number | boolean | null | undefined>
type TranslateOptions = { values?: Values }
type Translate = (key: string, options?: TranslateOptions) => string

const catalogs: Record<Lang, Catalog> = { en, ru: ru as Catalog }

function detected(): Lang {
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem('sp.lang')
    if (saved === 'en' || saved === 'ru') return saved
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'en'
  return nav.toLowerCase().startsWith('ru') ? 'ru' : 'en'
}

function lookup(catalog: Catalog, key: string): string | null {
  let cur: unknown = catalog
  for (const part of key.split('.')) {
    if (!cur || typeof cur !== 'object' || !(part in cur)) return null
    cur = (cur as Record<string, unknown>)[part]
  }
  return typeof cur === 'string' ? cur : null
}

function interpolate(template: string, values: Values = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''))
}

function translate(lang: Lang, key: string, options?: TranslateOptions): string {
  const template = lookup(catalogs[lang], key) ?? lookup(catalogs.en, key) ?? key
  return interpolate(template, options?.values)
}

export const locale: Writable<Lang> = writable(detected())

export const _: Readable<Translate> = derived(locale, ($locale) => {
  return (key: string, options?: TranslateOptions) => translate($locale, key, options)
})

let initialized = false

export async function initI18n(): Promise<void> {
  if (initialized) return
  locale.set(get(locale) || detected())
  initialized = true
}
