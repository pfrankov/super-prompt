<script lang="ts">
  import { onMount } from 'svelte'
  import type { Component } from 'svelte'
  let { value = $bindable(''), label = '', placeholder = '', rows = 8, readonly = false, oninput }: {
    value?: string; label?: string; placeholder?: string; rows?: number; readonly?: boolean; oninput?: (value: string) => void
  } = $props()
  let Editor = $state<Component<any> | null>(null)
  let textarea = $state<HTMLTextAreaElement>()
  let usingFallback = false
  const id = $props.id()

  onMount(() => {
    let active = true
    import('./CodeMirrorEditor.svelte').then((module) => {
      // Once native editing starts, keep that editor for this mount. Swapping
      // even on blur can move the next control between pointer-down and click.
      if (active && !usingFallback && textarea?.ownerDocument.activeElement !== textarea) Editor = module.default
    }).catch(() => { /* The native textarea remains usable if the editor chunk cannot load. */ })
    return () => { active = false }
  })
</script>
{#if Editor}
  <Editor bind:value {label} {placeholder} {rows} {readonly} {oninput} />
{:else}
  <div class="fallback"><label for={id}>{label}</label><textarea {id} bind:this={textarea} bind:value {placeholder} {rows} {readonly} oninput={() => oninput?.(value)} onfocus={() => { usingFallback = true }}></textarea></div>
{/if}
<style>
  .fallback { display:grid; gap:8px; } label { font-size:13px; color:var(--ink-2); } textarea { width:100%; min-height:220px; padding:14px; background:var(--bg-2); border:1px solid var(--border-1); border-radius:8px; font-family:var(--font-mono); font-size:13px; resize:vertical; }
</style>
