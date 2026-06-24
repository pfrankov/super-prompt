<script lang="ts">
  import type { Snippet } from 'svelte'

  type Tone = 'neutral' | 'ok' | 'warn' | 'err' | 'info' | 'accent'

  let {
    tone = 'neutral',
    children,
    icon,
  }: { tone?: Tone; children?: Snippet; icon?: Snippet } = $props()
</script>

<span class="tag {tone}">
  {#if icon}<span class="icon">{@render icon()}</span>{/if}
  {#if children}{@render children()}{/if}
</span>

<style>
  .tag {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    padding: 2px 7px;
    border-radius: var(--r-pill);
    font-size: var(--fs-xs);
    font-weight: 500;
    border: 1px solid var(--border-1);
    background: color-mix(in srgb, var(--bg-2) 86%, black);
    color: var(--ink-2);
    line-height: 1.5;
    white-space: nowrap;
  }
  .ok { color: var(--ok); border-color: rgba(159, 202, 173, 0.26); background: rgba(159, 202, 173, 0.08); }
  .warn { color: var(--warn); border-color: rgba(238, 183, 124, 0.26); background: rgba(238, 183, 124, 0.08); }
  .err { color: var(--err); border-color: rgba(232, 170, 163, 0.28); background: rgba(232, 170, 163, 0.08); }
  .info { color: var(--info); border-color: rgba(159, 191, 216, 0.26); background: rgba(159, 191, 216, 0.08); }
  .accent { color: var(--primary); border-color: rgba(238, 183, 124, 0.26); background: rgba(238, 183, 124, 0.08); }
  .icon { display: inline-flex; }
</style>
