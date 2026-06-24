<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { onMount } from 'svelte'
  import type { Task } from '../../lib/types'
  import { listRuns, getCandidates } from '../../lib/db/runs'
  import type { Run, PromptCandidate } from '../../lib/types'
  import Tag from '../ui/Tag.svelte'
  import { formatDateTime } from '../../lib/util/time'
  import { settings } from '../../stores/settings'

  let { task }: { task: Task } = $props()

  let runs: (Run & { candidates: PromptCandidate[] })[] = $state([])
  let loading = $state(true)

  async function reload() {
    loading = true
    try {
      const rs = await listRuns(task.id)
      runs = await Promise.all(
        rs.map(async (r) => ({ ...r, candidates: await getCandidates(r.id) }))
      )
    } finally {
      loading = false
    }
  }

  onMount(reload)

  function bestScore(cands: PromptCandidate[]): number | null {
    let best: number | null = null
    for (const c of cands) {
      if (c.score != null && (best == null || c.score > best)) best = c.score
    }
    return best
  }

  const statusTone = (s: string): 'info' | 'ok' | 'err' | 'neutral' | 'warn' =>
    s === 'running' ? 'info' : s === 'completed' ? 'ok' : s === 'failed' ? 'err' : s === 'paused' ? 'warn' : 'neutral'
</script>

{#if loading}
  <div class="empty surface">
    <p class="muted">{$_('common.loading')}</p>
  </div>
{:else if runs.length === 0}
  <div class="empty surface">
    <p class="muted">{$_('history.emptyTitle')}</p>
  </div>
{:else}
  <div class="list">
    {#each runs as run (run.id)}
      {@const bs = bestScore(run.candidates)}
      <div class="run surface">
        <div class="run-head">
          <div class="info">
            <Tag tone={statusTone(run.status)}>
              {$_(`history.status.${run.status}`)}
            </Tag>
            <span class="dim">{formatDateTime(run.startedAt, $settings.lang)}</span>
          </div>
          <div class="metrics">
            <span class="metric"><span class="dim">{$_('history.metrics.iters')}</span> {run.iterationCount}</span>
            <span class="metric"><span class="dim">{$_('history.metrics.tokens')}</span> {(run.totalTokensIn + run.totalTokensOut).toLocaleString()}</span>
            {#if bs != null}
              <span class="metric"><span class="dim">{$_('history.metrics.best')}</span> {bs.toFixed(2)}</span>
            {/if}
          </div>
        </div>
        {#if run.candidates.length}
          <div class="cands">
            {#each run.candidates.slice(-8) as c (c.id)}
              <div class="cand">
                <Tag tone={c.source === 'seed' ? 'accent' : 'neutral'}>{$_(`history.source.${c.source}`)}</Tag>
                <span class="score numeric">{c.score != null ? c.score.toFixed(2) : '-'}</span>
                <span class="cand-text">{c.text.slice(0, 80)}{c.text.length > 80 ? '…' : ''}</span>
              </div>
            {/each}
          </div>
        {/if}
        {#if run.errorMessage}
          <p class="err">{run.errorMessage}</p>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .empty { padding: var(--s-8); text-align: center; }
  .muted { color: var(--ink-3); }
  .list { display: flex; flex-direction: column; gap: var(--s-3); }
  .run { padding: var(--s-4); display: flex; flex-direction: column; gap: var(--s-3); }
  .run-head { display: flex; justify-content: space-between; align-items: center; gap: var(--s-3); flex-wrap: wrap; }
  .info { display: flex; align-items: center; gap: var(--s-2); }
  .dim { color: var(--ink-3); font-size: var(--fs-sm); }
  .metrics { display: flex; gap: var(--s-3); font-size: var(--fs-sm); }
  .metric { font-family: var(--font-mono); }
  .cands { display: flex; flex-direction: column; gap: 2px; max-height: 200px; overflow-y: auto; }
  .cand { display: grid; grid-template-columns: auto 50px 1fr; gap: var(--s-3); align-items: center; padding: 4px 8px; border-radius: var(--r-sm); font-size: var(--fs-sm); }
  .cand:hover { background: var(--bg-2); }
  .score { color: var(--primary); font-weight: 600; }
  .cand-text { font-family: var(--font-mono); color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .err { color: var(--err); margin: 0; font-size: var(--fs-sm); }
</style>
