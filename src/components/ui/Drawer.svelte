<script lang="ts">
  import type { Snippet } from 'svelte'

  let {
    open = $bindable(false),
    title,
    onclose,
    children,
  }: { open?: boolean; title?: string; onclose?: () => void; children?: Snippet } = $props()

  function close() {
    open = false
    onclose?.()
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }
</script>

<svelte:window onkeydown={open ? onKey : undefined} />

{#if open}
  <div class="scrim" role="presentation" onclick={close} onkeydown={() => {}}>
    <div
      class="drawer"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      aria-labelledby={title ? 'drw-title' : undefined}
      onclick={(e) => e.stopPropagation()}
      onkeydown={() => {}}
    >
      <header>
        {#if title}<h3 id="drw-title">{title}</h3>{/if}
        <button class="close" type="button" onclick={close} aria-label="Close">
          <svg viewBox="0 0 20 20" width="18" height="18"><path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </header>
      <div class="body">
        {#if children}{@render children()}{/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(2px);
    z-index: var(--z-overlay);
    display: flex;
    justify-content: flex-end;
    animation: fade var(--dur-base) var(--ease);
  }
  .drawer {
    background: var(--bg-1);
    border-left: 1px solid var(--border-2);
    width: 100%;
    max-width: 560px;
    height: 100%;
    display: flex;
    flex-direction: column;
    box-shadow: var(--shadow-modal);
    animation: slide var(--dur-base) var(--ease-out);
  }
  header {
    display: flex; align-items: center; justify-content: space-between;
    padding: var(--s-4) var(--s-5);
    border-bottom: 1px solid var(--border-1);
  }
  h3 { margin: 0; font-size: var(--fs-lg); }
  .close {
    width: 32px; height: 32px;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: var(--r-md);
    color: var(--ink-3);
    transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }
  .close:hover { background: var(--bg-2); color: var(--ink-1); }
  .body { padding: var(--s-5); overflow-y: auto; flex: 1; }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes slide { from { transform: translateX(40px); } to { transform: translateX(0); } }
</style>
