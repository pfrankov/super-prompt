<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { optimizationState } from '../../stores/worker'
  import { settings } from '../../stores/settings'
  import { formatEta } from '../../lib/util/time'

  const state = $derived($optimizationState)
  const run = $derived(state.run)
  const bestScore = $derived(state.candidates.reduce<number | null>((m, c) => (c.score != null && (m == null || c.score > m) ? c.score : m), null))
  const lastIter = $derived(state.history[state.history.length - 1] ?? null)

  const lastDelta = $derived.by((): { sign: 'up' | 'down' | 'flat'; value: number } | null => {
    if (!lastIter) return null
    const child = state.candidates.find((c) => c.id === lastIter.childCandidateId)
    const parent = state.candidates.find((c) => c.id === lastIter.parentCandidateId)
    if (!child || child.score == null || !parent || parent.score == null) return null
    const diff = child.score - parent.score
    if (Math.abs(diff) < 0.005) return { sign: 'flat', value: 0 }
    return { sign: diff > 0 ? 'up' : 'down', value: diff }
  })

  const etaMs = $derived.by(() => {
    if (!run || run.status !== 'running' || run.iterationCount <= 0) return 0
    const remaining = Math.max(0, run.config.iterationsCap - run.iterationCount)
    const elapsedMs = Date.now() - run.startedAt
    if (remaining <= 0 || elapsedMs <= 0) return 0
    return remaining * (elapsedMs / run.iterationCount)
  })
</script>

<div class="grid">
  <div class="stat">
    <span class="lbl">{$_('run.stats.iteration')}</span>
    <span class="val numeric">{run?.iterationCount ?? 0} <span class="dim">/ {run?.config.iterationsCap ?? '∞'}</span></span>
  </div>
  <div class="stat">
    <span class="lbl">{$_('run.stats.bestScore')}</span>
    <span class="val numeric primary">{bestScore != null ? bestScore.toFixed(2) : '-'}</span>
  </div>
  <div class="stat">
    <span class="lbl">{$_('run.stats.lastDelta')}</span>
    <span class="val numeric" class:up={lastDelta?.sign === 'up'} class:down={lastDelta?.sign === 'down'} class:flat={lastDelta?.sign === 'flat'}>
      {#if !lastDelta}
        -
      {:else if lastDelta.sign === 'flat'}
        -
      {:else if lastDelta.sign === 'up'}
        ▲ +{lastDelta.value.toFixed(2)}
      {:else}
        ▼ {lastDelta.value.toFixed(2)}
      {/if}
    </span>
  </div>
  <div class="stat">
    <span class="lbl">{$_('run.stats.tokensIn')} / {$_('run.stats.tokensOut')}</span>
    <span class="val numeric dim">{(run?.totalTokensIn ?? 0).toLocaleString()} / {(run?.totalTokensOut ?? 0).toLocaleString()}</span>
  </div>
  <div class="stat">
    <span class="lbl">{$_('run.stats.eta')}</span>
    <span class="val numeric dim">{formatEta(etaMs, $settings.lang)}</span>
  </div>
</div>

<style>
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--s-3); }
  .stat {
    display: flex; flex-direction: column; gap: 2px;
    background: color-mix(in srgb, var(--bg-2) 64%, black); border: 1px solid var(--border-1);
    border-radius: var(--r-md); padding: var(--s-3) var(--s-4);
  }
  .lbl { font-size: var(--fs-xs); color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.06em; }
  .val { font-size: var(--fs-xl); font-weight: 600; }
  .primary { color: var(--primary); }
  .up { color: #6fbf73; }
  .down { color: var(--err); }
  .flat { color: var(--ink-3); }
  .dim { color: var(--ink-3); font-weight: 400; font-size: var(--fs-md); }
</style>
