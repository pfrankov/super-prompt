<script lang="ts">
  import type { Snippet } from 'svelte'

  let {
    tabs,
    active = $bindable(tabs[0]?.value ?? ''),
    onchange,
  }: {
    tabs: { value: string; label: string }[]
    active?: string
    onchange?: (v: string) => void
  } = $props()

  let tablistEl: HTMLDivElement | null = $state(null)

  function onKey(e: KeyboardEvent) {
    const i = tabs.findIndex((t) => t.value === active)
    if (i < 0) return
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      const next = tabs[(i + 1) % tabs.length]
      active = next.value
      onchange?.(next.value)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      const prev = tabs[(i - 1 + tabs.length) % tabs.length]
      active = prev.value
      onchange?.(prev.value)
    }
  }
</script>

<div class="tabs" role="tablist" tabindex="0" bind:this={tablistEl} onkeydown={onKey}>
  {#each tabs as t (t.value)}
    <button
      type="button"
      role="tab"
      aria-selected={active === t.value}
      tabindex={active === t.value ? 0 : -1}
      class="tab"
      class:active={active === t.value}
      onclick={() => { active = t.value; onchange?.(t.value) }}
    >
      {t.label}
    </button>
  {/each}
</div>

<style>
  .tabs {
    display: flex;
    gap: var(--s-1);
    border-bottom: 1px solid var(--border-1);
    padding: 0 var(--s-1);
    max-width: 100%;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  .tabs::-webkit-scrollbar { display: none; }
  .tab {
    appearance: none;
    flex: 0 0 auto;
    background: transparent;
    color: var(--ink-3);
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: var(--r-sm) var(--r-sm) 0 0;
    min-height: 44px;
    padding: 10px var(--s-4);
    font: inherit;
    font-weight: 500;
    cursor: pointer;
    transition:
      color var(--dur-fast) var(--ease),
      background-color var(--dur-fast) var(--ease),
      border-color var(--dur-base) var(--ease);
    margin-bottom: -1px;
  }
  .tab:hover {
    color: var(--ink-2);
    background: color-mix(in srgb, var(--bg-2) 46%, transparent);
  }
  .tab.active { color: var(--ink-1); border-bottom-color: var(--primary); }
  @media (max-width: 520px) {
    .tabs { padding: 0; }
    .tab {
      padding: var(--s-3) var(--s-3);
      font-size: var(--fs-sm);
    }
  }
</style>
