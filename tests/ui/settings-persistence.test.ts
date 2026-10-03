import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync } from 'svelte'
import { createClassComponent } from 'svelte/legacy'
import { get } from 'svelte/store'
import { locale } from 'svelte-i18n'
import Settings from '../../src/routes/Settings.svelte'
import LanguageSwitcher from '../../src/components/chrome/LanguageSwitcher.svelte'
import ModelSetupDialog from '../../src/components/improve/ModelSetupDialog.svelte'
import { defaultSettings, putSettings } from '../../src/lib/db/settings'
import { settings, saveSettings } from '../../src/stores/settings'
import { toasts } from '../../src/stores/toast'

vi.mock('../../src/lib/db/settings', async (original) => ({
  ...await original<typeof import('../../src/lib/db/settings')>(),
  putSettings: vi.fn(),
}))
const persist = vi.mocked(putSettings)
const mounted: { $destroy(): void }[] = []
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => { resolve = yes })
  return { promise, resolve }
}
function page(component = Settings) {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const instance = createClassComponent({ component, target })
  mounted.push(instance)
  flushSync()
  return { target, instance }
}
function modelDialog() {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function () { this.open = true } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function () { this.open = false } })
  const target = document.createElement('div')
  document.body.appendChild(target)
  const instance = createClassComponent({ component: ModelSetupDialog, target, props: { open: true } })
  mounted.push(instance)
  flushSync()
  return { target, instance }
}
function demoSettings() {
  const current = defaultSettings('en')
  current.provider.baseUrl = 'mock://demo'
  current.provider.apiKey = 'synthetic-test-only-key'
  settings.set(current)
  return current
}
function input(target: HTMLElement, label: string) {
  const field = [...target.querySelectorAll('label.field')].find((node) => node.querySelector('.label')?.textContent === label)
  return field!.querySelector<HTMLInputElement>('input')!
}
function edit(field: HTMLInputElement, value: string) {
  field.value = value
  field.dispatchEvent(new Event('input', { bubbles: true }))
  flushSync()
}
function click(target: HTMLElement, text: string) {
  const button = [...target.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === text)!
  expect(button).toBeDefined()
  button.click()
  flushSync()
}
async function settle() { await vi.advanceTimersByTimeAsync(0); flushSync() }
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  persist.mockResolvedValue(undefined)
  settings.set(defaultSettings('en'))
  locale.set('en')
  localStorage.setItem('sp.lang', 'en')
  toasts.set([])
})
afterEach(async () => {
  for (const component of mounted.splice(0)) component.$destroy()
  await settle()
  document.body.replaceChildren()
  vi.useRealTimers()
})

describe('settings UI persistence failures', () => {
  it('retains an unsaved local draft, reports failure, and retries without publishing it early', async () => {
    persist.mockRejectedValueOnce(new Error('Storage unavailable'))
    const { target } = page()
    edit(input(target, 'Label'), 'Unsaved provider')
    expect(get(settings).provider.label).toBe('OpenRouter')
    await vi.advanceTimersByTimeAsync(500)
    flushSync()
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('Unsaved changes')
    expect(get(settings).provider.label).toBe('OpenRouter')
    expect(input(target, 'Label').value).toBe('Unsaved provider')
    expect(target.textContent).not.toContain('Saved')
    click(target, 'Try again')
    await settle()
    expect(get(settings).provider.label).toBe('Unsaved provider')
    expect(target.querySelector('[role="alert"]')).toBeNull()
    expect(target.textContent).toContain('Saved')
  })

  it('does not mark a newer edit saved when an older pending write completes', async () => {
    const gate = deferred()
    persist.mockReturnValueOnce(gate.promise)
    const { target } = page()
    edit(input(target, 'Label'), 'First draft')
    await vi.advanceTimersByTimeAsync(500)
    edit(input(target, 'Label'), 'Latest draft')
    gate.resolve()
    await settle()
    expect(get(settings).provider.label).toBe('First draft')
    expect(input(target, 'Label').value).toBe('Latest draft')
    expect(target.textContent).not.toContain('Saved')
    await vi.advanceTimersByTimeAsync(500)
    flushSync()
    expect(get(settings).provider.label).toBe('Latest draft')
    expect(target.textContent).toContain('Saved')
  })

  it('flushes a pending debounce on navigation without another timeout write', async () => {
    const { target, instance } = page()
    edit(input(target, 'Label'), 'Before navigation')
    instance.$destroy()
    mounted.splice(mounted.indexOf(instance), 1)
    await settle()
    expect(get(settings).provider.label).toBe('Before navigation')
    await vi.advanceTimersByTimeAsync(500)
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('merges a returning form edit with the previous page’s pending save', async () => {
    const gate = deferred()
    persist.mockReturnValueOnce(gate.promise)
    const first = page()
    edit(input(first.target, 'Label'), 'Previous page edit')
    first.instance.$destroy()
    mounted.splice(mounted.indexOf(first.instance), 1)
    await settle()
    const second = page()
    edit(input(second.target, 'Target model'), 'new-target')
    await vi.advanceTimersByTimeAsync(500)
    gate.resolve()
    await settle()
    expect(get(settings).provider).toMatchObject({ label: 'Previous page edit', targetModel: 'new-target' })
    expect(input(second.target, 'Label').value).toBe('Previous page edit')
    expect(input(second.target, 'Target model').value).toBe('new-target')
  })

  it('persists an explicit revert made while the first value is still being saved', async () => {
    const gate = deferred()
    persist.mockReturnValueOnce(gate.promise)
    const { target } = page()
    edit(input(target, 'Label'), 'Temporary value')
    await vi.advanceTimersByTimeAsync(500)
    edit(input(target, 'Label'), 'OpenRouter')
    await vi.advanceTimersByTimeAsync(500)
    gate.resolve()
    await settle()
    expect(get(settings).provider.label).toBe('OpenRouter')
    expect(input(target, 'Label').value).toBe('OpenRouter')
  })

  it.each(['Use demo', 'Forget'])('honors explicit %s key reset even when the stale form already shows a blank key', async (action) => {
    const gate = deferred()
    persist.mockReturnValueOnce(gate.promise)
    const previous = saveSettings({ provider: { apiKey: 'synthetic-pending-key' } })
    await settle()
    const { target } = page()
    expect(input(target, 'API key').value).toBe('')
    click(target, action)
    gate.resolve()
    await previous
    await settle()
    expect(get(settings).provider.apiKey).toBe('')
    expect(input(target, 'API key').value).toBe('')
  })

  it.each(['Use demo', 'Forget'])('handles %s persistence failure without committed changes or success feedback', async (action) => {
    const original = defaultSettings('en')
    original.provider.apiKey = 'test-only-key'
    settings.set(original)
    persist.mockRejectedValueOnce(new Error('Storage unavailable'))
    const { target } = page()
    click(target, action)
    await settle()
    expect(get(settings)).toEqual(original)
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('Unsaved changes')
    expect(target.textContent).not.toContain('Saved')
  })

  it.each(['header', 'settings'])('handles rejected %s language changes and leaves selection committed', async (surface) => {
    persist.mockRejectedValueOnce(new Error('Storage unavailable'))
    const { target } = page(surface === 'header' ? LanguageSwitcher : Settings)
    click(target, surface === 'header' ? 'RU' : 'Русский')
    await settle()
    expect(get(settings).lang).toBe('en')
    expect(get(locale)).toBe('en')
    expect(localStorage.getItem('sp.lang')).toBe('en')
    expect(get(toasts).some((toast) => toast.level === 'error')).toBe(true)
  })
})


describe('model setup waits for committed settings', () => {
  it('cannot restore a key forgotten by a pending previous save', async () => {
    demoSettings()
    const gate = deferred()
    persist.mockReturnValueOnce(gate.promise)
    const previous = saveSettings({ provider: { apiKey: '' } })
    await settle()
    const { target } = modelDialog()
    expect(target.querySelector('[role="status"]')?.textContent).toContain('Loading')
    expect(target.querySelector('.model-config')).toBeNull()
    const save = [...target.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === 'Save models')!
    expect(save.disabled).toBe(true)
    gate.resolve()
    await previous
    await settle()
    expect(input(target, 'API key').value).toBe('')
    edit(input(target, 'Target model'), 'next-model')
    click(target, 'Save models')
    await settle()
    expect(get(settings).provider).toMatchObject({ apiKey: '', targetModel: 'next-model' })
  })

  it('loads after a rejected prior write and retains modal save errors for retry', async () => {
    const original = demoSettings()
    persist.mockRejectedValueOnce(new Error('Previous failure'))
    await expect(saveSettings({ provider: { apiKey: '' } })).rejects.toThrow('Previous failure')
    const { target } = modelDialog()
    await settle()
    expect(input(target, 'API key').value).toBe(original.provider.apiKey)
    edit(input(target, 'Target model'), 'edited-model')
    persist.mockRejectedValueOnce(new Error('Modal storage failure'))
    click(target, 'Save models')
    await settle()
    expect(target.querySelector('dialog')?.open).toBe(true)
    expect(target.querySelector('[role="alert"]')?.textContent).toBe('Modal storage failure')
    expect(get(settings)).toEqual(original)
    click(target, 'Save models')
    await settle()
    expect(get(settings).provider.targetModel).toBe('edited-model')
    expect(target.querySelector('dialog')?.open).toBe(false)
  })

  it('does not close a reopened dialog when an earlier save finishes', async () => {
    demoSettings()
    const { target, instance } = modelDialog()
    await settle()
    edit(input(target, 'Target model'), 'first-model')
    const gate = deferred()
    persist.mockReturnValueOnce(gate.promise)
    click(target, 'Save models')
    await settle()
    click(target, 'Cancel')
    flushSync(() => instance.$set({ open: true }))
    expect(target.querySelector('[role="status"]')).not.toBeNull()
    gate.resolve()
    await settle()
    expect(target.querySelector('dialog')?.open).toBe(true)
    expect(input(target, 'Target model').value).toBe('first-model')
    edit(input(target, 'Target model'), 'second-model')
    click(target, 'Save models')
    await settle()
    expect(get(settings).provider.targetModel).toBe('second-model')
  })
})
