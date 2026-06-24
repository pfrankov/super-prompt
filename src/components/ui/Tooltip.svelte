<script lang="ts">
  import type { Snippet } from 'svelte'

  let {
    text,
    children,
    placement = 'top',
  }: { text: string; children: Snippet; placement?: 'top' | 'bottom' } = $props()

  let open = $state(false)
  const autoId = $props.id()
  const tipId = $derived(`ttip-${autoId}`)
</script>

<span
  class="wrap"
  role="group"
  onmouseenter={() => (open = true)}
  onmouseleave={() => (open = false)}
  onfocusin={() => (open = true)}
  onfocusout={() => (open = false)}
>
  {@render children()}
  {#if open}
    <span id={tipId} class="tip {placement}" role="tooltip">{text}</span>
  {/if}
</span>

<style>
  .wrap { position: relative; display: inline-flex; }
  .tip {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg-elevated);
    color: var(--ink-1);
    border: 1px solid var(--border-2);
    padding: 4px 8px;
    border-radius: var(--r-sm);
    font-size: var(--fs-xs);
    white-space: nowrap;
    z-index: var(--z-dropdown);
    pointer-events: none;
    box-shadow: var(--shadow-2);
  }
  .top { bottom: calc(100% + 6px); }
  .bottom { top: calc(100% + 6px); }
</style>
