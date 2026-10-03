import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { flushSync as FlushSync } from 'svelte'

function deferred() {
  let resolve!: () => void
  let reject!: (reason: Error) => void
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

let load: ReturnType<typeof deferred>
let started: ReturnType<typeof deferred>
let flushSync: typeof FlushSync
const mounted: { $destroy(): void }[] = []

beforeEach(() => {
  vi.resetModules()
  load = deferred()
  started = deferred()
  vi.doMock('../../src/components/ui/CodeMirrorEditor.svelte', async () => {
    started.resolve()
    await load.promise
    return vi.importActual('../../src/components/ui/CodeMirrorEditor.svelte')
  })
})

afterEach(async () => {
  for (const component of mounted.splice(0)) component.$destroy()
  // Release the controlled import even if an assertion failed before loading it.
  load.resolve()
  await import('../../src/components/ui/CodeMirrorEditor.svelte').catch(() => {})
  await vi.dynamicImportSettled()
  document.body.replaceChildren()
  vi.doUnmock('../../src/components/ui/CodeMirrorEditor.svelte')
})

async function editor(value = 'Original prompt') {
  const [{ default: PromptEditor }, svelte, { createClassComponent }] = await Promise.all([
    import('../../src/components/ui/PromptEditor.svelte'),
    import('svelte'),
    import('svelte/legacy'),
  ])
  flushSync = svelte.flushSync
  const target = document.createElement('div')
  const nextControl = document.createElement('button')
  nextControl.textContent = 'Continue'
  document.body.append(target, nextControl)
  const oninput = vi.fn()
  const component = createClassComponent({ component: PromptEditor, target, props: { value, label: 'Prompt', oninput } })
  mounted.push(component)
  flushSync()
  await started.promise
  const textarea = target.querySelector('textarea')!
  expect(textarea).not.toBeNull()
  return { target, nextControl, component, textarea, oninput }
}

function type(textarea: HTMLTextAreaElement, value: string) {
  flushSync(() => {
    textarea.value = value
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function finishLoading() {
  load.resolve()
  await import('../../src/components/ui/CodeMirrorEditor.svelte')
  await vi.dynamicImportSettled()
  flushSync()
}

describe('lazy prompt editor activation', () => {
  it('preserves native editing and selection after loading, blur, and clicking the next control', async () => {
    const { target, nextControl, textarea, oninput } = await editor()
    textarea.focus()
    type(textarea, 'Typed before loading 🧭')
    textarea.setSelectionRange(2, 9, 'backward')

    await finishLoading()

    expect(target.querySelector('textarea')).toBe(textarea)
    expect(target.querySelector('.cm-editor')).toBeNull()
    expect(document.activeElement).toBe(textarea)
    expect([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection]).toEqual([2, 9, 'backward'])
    expect(oninput).toHaveBeenLastCalledWith('Typed before loading 🧭')

    type(textarea, 'Latest text after loading\n🧭')
    expect(oninput).toHaveBeenLastCalledWith('Latest text after loading\n🧭')
    const edits = oninput.mock.calls.length
    const activate = vi.fn()
    nextControl.addEventListener('click', activate)
    nextControl.focus()
    flushSync()
    nextControl.click()

    expect(target.querySelector('textarea')).toBe(textarea)
    expect(target.querySelector('.cm-editor')).toBeNull()
    expect(textarea.value).toBe('Latest text after loading\n🧭')
    expect(document.activeElement).toBe(nextControl)
    expect(activate).toHaveBeenCalledExactlyOnceWith(expect.any(MouseEvent))
    expect(oninput).toHaveBeenCalledTimes(edits)
  })

  it('keeps an already used fallback when the chunk resolves between blur and click', async () => {
    const { target, nextControl, textarea, oninput } = await editor()
    textarea.focus()
    type(textarea, 'Typed before blur')
    const activate = vi.fn()
    nextControl.addEventListener('click', activate)
    nextControl.focus()
    await finishLoading()
    nextControl.click()

    expect(target.querySelector('textarea')).toBe(textarea)
    expect(target.querySelector('.cm-editor')).toBeNull()
    expect(textarea.value).toBe('Typed before blur')
    expect(document.activeElement).toBe(nextControl)
    expect(activate).toHaveBeenCalledExactlyOnceWith(expect.any(MouseEvent))
    expect(oninput).toHaveBeenCalledExactlyOnceWith('Typed before blur')
  })

  it('activates an unfocused fallback using the newest external value without reporting an edit', async () => {
    const { target, nextControl, component, oninput } = await editor()
    nextControl.focus()
    flushSync(() => component.$set({ value: 'Updated while loading' }))
    await finishLoading()

    expect(target.querySelector('textarea')).toBeNull()
    expect(target.querySelector('.cm-content')?.textContent).toBe('Updated while loading')
    expect(document.activeElement).toBe(nextControl)
    expect(oninput).not.toHaveBeenCalled()
  })

  it('keeps the fallback editable after a failed chunk load and blur', async () => {
    const { target, nextControl, textarea, oninput } = await editor()
    textarea.focus()
    load.reject(new Error('Chunk unavailable'))
    await expect(import('../../src/components/ui/CodeMirrorEditor.svelte')).rejects.toThrow()
    await vi.dynamicImportSettled()
    flushSync()
    type(textarea, 'Still editable')
    nextControl.focus()
    flushSync()

    expect(target.querySelector('textarea')).toBe(textarea)
    expect(textarea.value).toBe('Still editable')
    expect(oninput).toHaveBeenLastCalledWith('Still editable')
    expect(target.querySelector('.cm-editor')).toBeNull()
    expect(document.activeElement).toBe(nextControl)
  })

  it.each(['resolve', 'reject'] as const)('ignores a late import %s after unmount', async (outcome) => {
    const { target, component, oninput } = await editor()
    component.$destroy()
    mounted.splice(mounted.indexOf(component), 1)
    if (outcome === 'resolve') load.resolve()
    else load.reject(new Error('Chunk unavailable after unmount'))
    await import('../../src/components/ui/CodeMirrorEditor.svelte').catch(() => {})
    await vi.dynamicImportSettled()
    flushSync()

    expect(target.children).toHaveLength(0)
    expect(oninput).not.toHaveBeenCalled()
  })

  it('unmounts the sticky fallback after the chunk has loaded', async () => {
    const { target, component, textarea, oninput } = await editor()
    textarea.focus()
    await finishLoading()
    expect(target.querySelector('textarea')).toBe(textarea)
    component.$destroy()
    mounted.splice(mounted.indexOf(component), 1)
    textarea.dispatchEvent(new FocusEvent('blur'))
    flushSync()

    expect(target.children).toHaveLength(0)
    expect(oninput).not.toHaveBeenCalled()
  })
})
