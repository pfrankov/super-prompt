<script lang="ts">
  import type { Snippet } from 'svelte'
  import { _ } from 'svelte-i18n'
  let { open = $bindable(false), title, onclose, children, actions, maxWidth = '520px' }: {
    open?: boolean; title?: string; onclose?: () => void; children?: Snippet; actions?: Snippet; maxWidth?: string
  } = $props()
  let dialogEl: HTMLDialogElement | undefined = $state()
  const titleId = $props.id()
  $effect(() => {
    if (!dialogEl) return
    if (open && !dialogEl.open) dialogEl.showModal()
    else if (!open && dialogEl.open) dialogEl.close()
  })
  function close() { open = false }
</script>
<dialog bind:this={dialogEl} aria-labelledby={title ? titleId : undefined} style={`--max-w:${maxWidth}`}
  oncancel={(e) => { e.preventDefault(); close() }}
  onclose={() => { open = false; onclose?.() }}>
  <header>{#if title}<h3 id={titleId}>{title}</h3>{/if}<button type="button" class="close" onclick={close} aria-label={$_('common.close')}>×</button></header>
  <div class="body">{#if children}{@render children()}{/if}</div>
  {#if actions}<footer>{@render actions()}</footer>{/if}
</dialog>
<style>
  dialog { padding:0; background:var(--bg-1); color:var(--ink-1); border:1px solid var(--border-2); border-radius:12px; box-shadow:var(--shadow-modal); width:calc(100% - 32px); max-width:var(--max-w); max-height:calc(100dvh - 32px); overflow:hidden; }
  dialog[open] { display:flex; flex-direction:column; animation:surface-enter 160ms var(--ease-out); }
  dialog::backdrop { background:rgba(3,7,15,.75); }
  header { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:16px 24px; } h3 { font-size:20px; }.close { width:36px; height:36px; border-radius:8px; color:var(--ink-2); font-size:24px; }.close:hover { background:var(--bg-3); }
  .body { padding:0 24px 20px; overflow:auto; min-height:0; } footer { padding:16px 24px; display:flex; gap:12px; justify-content:flex-end; border-top:1px solid var(--border-1); flex-shrink:0; }
  @media(max-width:520px) { header,.body,footer { padding-left:16px; padding-right:16px; } }
</style>
