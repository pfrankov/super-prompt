import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { flushSync } from 'svelte'
import { createClassComponent } from 'svelte/legacy'
import CodeMirrorEditor from '../../src/components/ui/CodeMirrorEditor.svelte'

const mounted: { $destroy(): void }[] = []
afterEach(() => {
  for (const component of mounted.splice(0)) component.$destroy()
  document.body.replaceChildren()
})

function editor(value: string) {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const oninput = vi.fn()
  // The compatibility wrapper provides reactive $set for exercising external
  // bound-value updates, including Apply/Undo while the editor remains mounted.
  const component = createClassComponent({ component: CodeMirrorEditor, target, props: { value, oninput } })
  mounted.push(component)
  flushSync()
  const element = target.querySelector<HTMLElement>('.cm-editor')!
  const view = EditorView.findFromDOM(element)!
  expect(view).not.toBeNull()
  return { component, view, oninput }
}

describe('prompt editor source preservation', () => {
  it.each(['', '  original\r\n\n', 'first\rsecond\r', 'first\r\nsecond\nthird\r', ' \t\r\n🧭α\r\n'])
    ('mounting %j does not report a user edit', (original) => {
      const { view, oninput } = editor(original)
      expect(view.state.doc.toString()).toBe(view.state.toText(original).toString())
      expect(oninput).not.toHaveBeenCalled()
    })

  it('does not report newline-only external updates as user edits', () => {
    const { component, view, oninput } = editor('same\ntext\n')
    flushSync(() => component.$set({ value: 'same\r\ntext\r\n' }))
    expect(view.state.doc.toString()).toBe('same\ntext\n')
    expect(oninput).not.toHaveBeenCalled()
  })

  it('synchronizes different external Apply/Undo values without emitting oninput', () => {
    const { component, view, oninput } = editor('Applied winner')
    for (const value of ['  original\r\n\n', '', 'new 🧭\rsecond\r']) {
      flushSync(() => component.$set({ value }))
      expect(view.state.doc.toString()).toBe(view.state.toText(value).toString())
      expect(oninput).not.toHaveBeenCalled()
    }
  })

  it('still reports actual document edits after an external update', () => {
    const { component, view, oninput } = editor('Applied winner')
    flushSync(() => component.$set({ value: 'Original\r\n' }))
    expect(oninput).not.toHaveBeenCalled()
    flushSync(() => view.dispatch({ changes: { from: view.state.doc.length, insert: 'Typed 🧭' }, userEvent: 'input.type' }))
    expect(oninput).toHaveBeenCalledExactlyOnceWith('Original\nTyped 🧭')
  })
})
