<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { Compartment, EditorState } from '@codemirror/state'
  import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
  import { markdown } from '@codemirror/lang-markdown'
  import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language'

  let {
    value = $bindable(''),
    label = '',
    placeholder = '',
    rows = 8,
    readonly = false,
    oninput,
  }: {
    value?: string
    label?: string
    placeholder?: string
    rows?: number
    readonly?: boolean
    oninput?: (v: string) => void
  } = $props()

  let host: HTMLDivElement | null = $state(null)
  let view: EditorView | null = null
  let applyingExternalValue = false
  const readOnlyMode = new Compartment()

  function focusEditor() {
    view?.focus()
  }

  function focusEditorFromKeyboard(e: KeyboardEvent) {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    focusEditor()
  }

  function buildState(initial: string) {
    const minEditorHeight = `${rows * 1.6}em`
    return EditorState.create({
      doc: initial,
      extensions: [
        history(),
        markdown(),
        lineNumbers(),
        highlightActiveLine(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': label || 'Editor', 'aria-multiline': 'true' }),
        readOnlyMode.of([EditorState.readOnly.of(readonly), EditorView.editable.of(!readonly)]),
        EditorView.theme({
          '&': {
            backgroundColor: 'var(--bg-1)',
            color: 'var(--ink-1)',
            fontSize: 'var(--fs-sm)',
            fontFamily: 'var(--font-mono)',
            borderRadius: 'var(--r-md)',
            border: '1px solid var(--border-1)',
            minHeight: minEditorHeight,
            cursor: 'text',
          },
          '&.cm-focused': { outline: 'none', borderColor: 'var(--primary)', boxShadow: '0 0 0 3px rgba(156, 174, 255, 0.11)' },
          '.cm-scroller': { minHeight: minEditorHeight },
          '.cm-content': { minHeight: `calc(${minEditorHeight} - 28px)`, padding: '14px', cursor: 'text' },
          '.cm-gutters': { minHeight: minEditorHeight, background: 'transparent', border: 'none', color: 'var(--ink-3)' },
          '.cm-activeLine': { background: 'rgba(156, 174, 255, 0.045)' },
          '.cm-activeLineGutter': { background: 'transparent', color: 'var(--primary)' },
          '.cm-line': { padding: '0 2px' },
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !applyingExternalValue) {
            const text = u.state.doc.toString()
            value = text
            oninput?.(text)
          }
        }),
      ],
    })
  }

  onMount(() => {
    if (host) {
      view = new EditorView({ state: buildState(value), parent: host })
    }
  })

  onDestroy(() => {
    view?.destroy()
  })

  $effect(() => {
    const readOnly = readonly
    if (view && view.state.readOnly !== readOnly) {
      view.dispatch({ effects: readOnlyMode.reconfigure([
        EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
      ]) })
    }
  })

  $effect(() => {
    if (view && !view.state.doc.eq(view.state.toText(value))) {
      // Synchronizing props is not a user edit. CodeMirror normalizes line
      // separators internally; opening or applying text must not rewrite bytes.
      applyingExternalValue = true
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
      } finally { applyingExternalValue = false }
    }
  })
</script>

<div class="wrap">
  {#if label}<span class="lbl">{label}</span>{/if}
  <div
    bind:this={host}
    class="editor"
    data-placeholder={placeholder}
  ></div>
</div>

<style>
  .wrap { display: flex; flex-direction: column; gap: var(--s-2); }
  .lbl { font-size: var(--fs-sm); font-weight: 500; color: var(--ink-2); }
  .editor { width: 100%; }
  @media (max-width: 680px) {
    .wrap :global(.cm-editor) {
      min-height: 180px !important;
    }
  }
</style>
