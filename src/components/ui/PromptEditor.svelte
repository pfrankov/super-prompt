<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { EditorState } from '@codemirror/state'
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

  function buildState(initial: string) {
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
        EditorView.editable.of(!readonly),
        EditorView.theme({
          '&': {
            backgroundColor: 'color-mix(in srgb, var(--bg-2) 78%, black)',
            color: 'var(--ink-1)',
            fontSize: 'var(--fs-sm)',
            fontFamily: 'var(--font-mono)',
            borderRadius: 'var(--r-md)',
            border: '1px solid var(--border-1)',
            minHeight: `${rows * 1.6}em`,
          },
          '&.cm-focused': { outline: 'none', borderColor: 'rgba(238, 183, 124, 0.65)', boxShadow: '0 0 0 3px rgba(238, 183, 124, 0.11)' },
          '.cm-content': { padding: '14px' },
          '.cm-gutters': { background: 'transparent', border: 'none', color: 'var(--ink-3)' },
          '.cm-activeLine': { background: 'rgba(238, 183, 124, 0.045)' },
          '.cm-activeLineGutter': { background: 'transparent', color: 'var(--primary)' },
          '.cm-line': { padding: '0 2px' },
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
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
    if (view && value !== view.state.doc.toString()) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      })
    }
  })
</script>

<div class="wrap">
  {#if label}<span class="lbl">{label}</span>{/if}
  <div bind:this={host} class="editor" data-placeholder={placeholder} role="textbox" aria-multiline="true" aria-label={label || 'Editor'} tabindex="0"></div>
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
