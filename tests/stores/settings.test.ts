import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { locale } from 'svelte-i18n'
import { defaultSettings, putSettings } from '../../src/lib/db/settings'
import { saveSettings, setLang, settings } from '../../src/stores/settings'

vi.mock('../../src/lib/db/settings', async (original) => ({
  ...await original<typeof import('../../src/lib/db/settings')>(),
  putSettings: vi.fn(),
}))
const persist = vi.mocked(putSettings)
function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => {
  vi.clearAllMocks()
  persist.mockResolvedValue(undefined)
  settings.set(defaultSettings('en'))
  locale.set('en')
  localStorage.clear()
  localStorage.setItem('sp.lang', 'en')
})

describe('committed settings persistence', () => {
  it('does not publish a pending or rejected provider draft and lets retry succeed', async () => {
    const original = get(settings)
    const gate = deferred()
    persist.mockReturnValueOnce(gate.promise)
    const pending = saveSettings({ provider: { ...original.provider, targetModel: 'new-model' } })
    const rejected = expect(pending).rejects.toThrow('Storage unavailable')
    await Promise.resolve()
    expect(get(settings)).toBe(original)
    gate.reject(new Error('Storage unavailable'))
    await rejected
    expect(get(settings)).toBe(original)
    await saveSettings({ provider: { ...original.provider, targetModel: 'new-model' } })
    expect(get(settings).provider.targetModel).toBe('new-model')
  })

  it('serializes writes, snapshots mutable drafts, and merges later patches against committed settings', async () => {
    const gate = deferred()
    const provider = { ...get(settings).provider, targetModel: 'first-model' }
    persist.mockReturnValueOnce(gate.promise)
    const first = saveSettings({ provider })
    provider.targetModel = 'mutation-after-submit'
    const second = setLang('ru')
    await Promise.resolve()
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0][0].provider.targetModel).toBe('first-model')
    expect(get(settings).lang).toBe('en')
    gate.resolve()
    await Promise.all([first, second])
    expect(persist).toHaveBeenCalledTimes(2)
    expect(persist.mock.calls[1][0]).toMatchObject({ lang: 'ru', provider: { targetModel: 'first-model' } })
    expect(get(settings)).toMatchObject({ lang: 'ru', provider: { targetModel: 'first-model' } })
    expect(get(locale)).toBe('ru')
    expect(localStorage.getItem('sp.lang')).toBe('ru')
  })

  it('keeps language, locale, and cache unchanged after a rejected language save', async () => {
    persist.mockRejectedValueOnce(new Error('Storage unavailable'))
    await expect(setLang('ru')).rejects.toThrow('Storage unavailable')
    expect(get(settings).lang).toBe('en')
    expect(get(locale)).toBe('en')
    expect(localStorage.getItem('sp.lang')).toBe('en')
  })

  it('recovers the write queue after failure without merging the failed draft', async () => {
    persist.mockRejectedValueOnce(new Error('No space'))
    const first = saveSettings({ provider: { ...get(settings).provider, targetModel: 'failed-model' } })
    const rejection = expect(first).rejects.toThrow('No space')
    const second = setLang('ru')
    await rejection
    await second
    expect(get(settings).provider.targetModel).toBe('openai/gpt-4o-mini')
    expect(get(settings).lang).toBe('ru')
  })

  it('keeps a successful persisted language when the optional startup cache is unavailable', async () => {
    const cache = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Blocked cache') })
    try {
      await setLang('ru')
      expect(get(settings).lang).toBe('ru')
      expect(get(locale)).toBe('ru')
    } finally { cache.mockRestore() }
  })
})
