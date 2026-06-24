<script lang="ts">
  let { used, budget, label = 'tokens' }: { used: number; budget: number; label?: string } = $props()
  const pct = $derived(budget > 0 ? Math.min(100, (used / budget) * 100) : 0)
  const isUnbounded = $derived(budget <= 0)
</script>

<div class="meter">
  <div class="bar" role="meter" aria-valuenow={used} aria-valuemin="0" aria-valuemax={budget > 0 ? budget : undefined} aria-label={label}>
    <div class="fill" style="width: {pct}%"></div>
  </div>
  <span class="label numeric">{used.toLocaleString()} / {isUnbounded ? '∞' : budget.toLocaleString()}</span>
</div>

<style>
  .meter { display: flex; align-items: center; gap: var(--s-2); }
  .bar {
    flex: 1 1 auto; height: 6px; background: var(--bg-2);
    border: 1px solid var(--border-1); border-radius: var(--r-pill); overflow: hidden;
  }
  .fill {
    height: 100%;
    background: linear-gradient(90deg, var(--acc-mint), var(--acc-peach));
    transition: width var(--dur-base) var(--ease);
  }
  .label { font-size: var(--fs-xs); color: var(--ink-3); font-variant-numeric: tabular-nums; }
</style>
