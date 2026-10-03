import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { locale } from 'svelte-i18n'
import { defaultSettings, putSettings } from '../../src/lib/db/settings'
import { saveSettings, setLang, settings, settingsDraft, stageSettingsDraft, persistSettingsDraft } from '../../src/stores/settings'

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
  persist.mockReset()
  persist.mockResolvedValue(undefined)
  settingsDraft.set(null)
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


describe('ephemeral retryable settings drafts', () => {
  it.each(['resolve', 'reject'] as const)('does not clear a newer reset when an older save %s settles', async (outcome) => {
    const gate = deferred()
    persist.mockReturnValueOnce(gate.promise)
    stageSettingsDraft({ provider: { apiKey: 'synthetic-older-key' } })
    const older = persistSettingsDraft()
    const olderResult = outcome === 'reject' ? expect(older).rejects.toThrow('Older failed') : expect(older).resolves.toBe(false)
    await Promise.resolve()
    expect(persist).toHaveBeenCalledTimes(1)
    const latestRevision = stageSettingsDraft({ provider: { apiKey: '' }, arbitrator: { model: 'new-arbiter' } })
    if (outcome === 'resolve') gate.resolve()
    else gate.reject(new Error('Older failed'))
    await olderResult
    expect(get(settingsDraft)).toMatchObject({ revision: latestRevision, status: 'dirty', patch: { provider: { apiKey: '' }, arbitrator: { model: 'new-arbiter' } } })
    persist.mockRejectedValueOnce(new Error('Latest failed'))
    await expect(persistSettingsDraft()).rejects.toThrow('Latest failed')
    expect(get(settingsDraft)).toMatchObject({ revision: latestRevision, status: 'failed', patch: { provider: { apiKey: '' } } })
    await persistSettingsDraft()
    expect(get(settingsDraft)).toBeNull()
    expect(get(settings)).toMatchObject({ provider: { apiKey: '' }, arbitrator: { model: 'new-arbiter' } })
  })

  it('retains unsaved fields across unrelated committed settings and language changes', async () => {
    const revision = stageSettingsDraft({ provider: { apiKey: 'synthetic-unsaved-key' }, arbitrator: { model: 'unsaved-arbiter' } })
    await saveSettings({ provider: { targetModel: 'committed-target' } })
    await setLang('ru')
    expect(get(settings)).toMatchObject({ lang: 'ru', provider: { apiKey: '', targetModel: 'committed-target' }, arbitrator: { model: '' } })
    expect(get(settingsDraft)).toMatchObject({ revision, patch: { provider: { apiKey: 'synthetic-unsaved-key' }, arbitrator: { model: 'unsaved-arbiter' } } })
    await persistSettingsDraft()
    expect(get(settings).provider.targetModel).toBe('committed-target')
    expect(get(settings).provider.apiKey).toBe('synthetic-unsaved-key')
  })
})


describe('newer explicit settings saves supersede older draft fields', () => {
  it('clears overlapping older fields while retaining unrelated pending fields', async () => {
    stageSettingsDraft({ provider: { apiKey: 'synthetic-obsolete-key', label: 'Pending label' }, arbitrator: { model: 'pending-arbiter' } })
    await saveSettings({ provider: { apiKey: '' } })
    expect(get(settingsDraft)?.patch).toEqual({ provider: { label: 'Pending label' }, arbitrator: { model: 'pending-arbiter' } })
    await persistSettingsDraft()
    expect(get(settings).provider).toMatchObject({ apiKey: '', label: 'Pending label' })
    expect(get(settings).arbitrator.model).toBe('pending-arbiter')
  })

  it('filters superseded fields from a draft already queued behind the explicit save', async () => {
    stageSettingsDraft({ provider: { apiKey: 'synthetic-obsolete-key' } })
    const gate = deferred()
    persist.mockReturnValueOnce(gate.promise)
    const explicit = saveSettings({ provider: { apiKey: '' } })
    await Promise.resolve()
    stageSettingsDraft({ provider: { label: 'Newer label only' } })
    const queuedDraft = persistSettingsDraft()
    gate.resolve()
    await Promise.all([explicit, queuedDraft])
    expect(get(settings).provider).toMatchObject({ apiKey: '', label: 'Newer label only' })
    expect(get(settingsDraft)).toBeNull()
  })

  it('preserves a newer explicit reset even when its value equals the older draft', async () => {
    stageSettingsDraft({ provider: { apiKey: '' } })
    const gate = deferred()
    persist.mockReturnValueOnce(gate.promise)
    const explicit = saveSettings({ provider: { apiKey: 'synthetic-new-key' } })
    await Promise.resolve()
    const resetRevision = stageSettingsDraft({ provider: { apiKey: '' } })
    gate.resolve()
    await explicit
    expect(get(settingsDraft)).toMatchObject({ revision: resetRevision, patch: { provider: { apiKey: '' } } })
    await persistSettingsDraft()
    expect(get(settings).provider.apiKey).toBe('')
  })

  it('does not supersede a pending field when the newer explicit save fails', async () => {
    const revision = stageSettingsDraft({ provider: { apiKey: 'synthetic-retained-key' } })
    persist.mockRejectedValueOnce(new Error('Explicit save failed'))
    await expect(saveSettings({ provider: { apiKey: '' } })).rejects.toThrow('Explicit save failed')
    expect(get(settingsDraft)).toMatchObject({ revision, patch: { provider: { apiKey: 'synthetic-retained-key' } } })
    await persistSettingsDraft()
    expect(get(settings).provider.apiKey).toBe('synthetic-retained-key')
  })
})
