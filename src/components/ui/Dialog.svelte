<script lang="ts">
  import type { Snippet } from 'svelte'

  let {
    open = $bindable(false),
    title,
    onclose,
    children,
    actions,
    maxWidth = '520px',
  }: {
    open?: boolean
    title?: string
    onclose?: () => void
    children?: Snippet
    actions?: Snippet
    maxWidth?: string
  } = $props()

  let dialogEl: HTMLDivElement | null = $state(null)
  let lastFocus: HTMLElement | null = null

  function close() {
    open = false
    onclose?.()
    if (lastFocus && typeof lastFocus.focus === 'function') {
      lastFocus.focus()
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Tab' && dialogEl) {
      const focusables = dialogEl.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  $effect(() => {
    if (open) {
      lastFocus = document.activeElement as HTMLElement
      setTimeout(() => {
        if (dialogEl) {
          const focusable = dialogEl.querySelector<HTMLElement>(
            'input, textarea, select, button:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
          focusable?.focus()
        }
      }, 10)
    }
  })
</script>

<svelte:window onkeydown={open ? onKey : undefined} />

{#if open}
  <div class="overlay" role="presentation" onclick={close} onkeydown={() => {}}>
    <div
      class="dialog"
      bind:this={dialogEl}
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby={title ? 'dlg-title' : undefined}
      style="--max-w: {maxWidth}"
      onclick={(e) => e.stopPropagation()}
      onkeydown={() => {}}
    >
      {#if title}
        <h3 id="dlg-title" class="title">{title}</h3>
      {/if}
      <div class="body">
        {#if children}{@render children()}{/if}
      </div>
      {#if actions}
        <div class="actions">{@render actions()}</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(2px);
    z-index: var(--z-modal);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--s-4);
    animation: fade var(--dur-base) var(--ease);
  }
  .dialog {
    background: var(--bg-2);
    border: 1px solid var(--border-2);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-modal);
    width: 100%;
    max-width: var(--max-w);
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    animation: pop var(--dur-base) var(--ease-out);
  }
  .title {
    padding: var(--s-5) var(--s-6) var(--s-3);
    margin: 0;
    font-size: var(--fs-xl);
  }
  .body {
    padding: 0 var(--s-6) var(--s-4);
    overflow-y: auto;
    flex: 1;
  }
  .actions {
    padding: var(--s-3) var(--s-6) var(--s-5);
    display: flex;
    justify-content: flex-end;
    gap: var(--s-3);
    border-top: 1px solid var(--border-1);
  }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes pop {
    from { opacity: 0; transform: translateY(8px) scale(0.96); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
</style>
