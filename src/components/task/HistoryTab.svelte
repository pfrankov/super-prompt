<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { onDestroy, onMount } from 'svelte'
  import type { Task } from '../../lib/types'
  import { listRunsPage, getTopCandidates } from '../../lib/db/runs'
  import type { Run, PromptCandidate } from '../../lib/types'
  import Tag from '../ui/Tag.svelte'
  import Button from '../ui/Button.svelte'
  import { formatDateTime } from '../../lib/util/time'
  import { settings } from '../../stores/settings'

  let { task }: { task: Task } = $props()

  const pageSize = 20
  let runs: Run[] = $state([])
  let loading = $state(true)
  let offset = $state(0)
  let total = $state(0)
  let error = $state('')
  let candidates: Record<string, PromptCandidate[]> = $state({})
  let candidateErrors: Record<string, string> = $state({})
  let expanded = $state(new Set<string>())
  const pending = new Set<string>()
  let reloadVersion = 0

  async function reload(nextOffset = 0) {
    const version = ++reloadVersion
    loading = true
    error = ''
    candidates = {}
    candidateErrors = {}
    expanded = new Set()
    pending.clear()
    try {
      let page = await listRunsPage(task.id, { offset: nextOffset, limit: pageSize })
      // Another tab may have removed the last page since it was displayed.
      if (page.total > 0 && nextOffset >= page.total) {
        nextOffset = Math.floor((page.total - 1) / pageSize) * pageSize
        page = await listRunsPage(task.id, { offset: nextOffset, limit: pageSize })
      }
      if (version !== reloadVersion) return
      runs = page.runs
      total = page.total
      offset = nextOffset
    } catch (e) {
      if (version === reloadVersion) error = e instanceof Error ? e.message : String(e)
    } finally {
      if (version === reloadVersion) loading = false
    }
  }

  async function toggleCandidates(runId: string, open: boolean) {
    const next = new Set(expanded)
    if (open) next.add(runId)
    else next.delete(runId)
    expanded = next
    if (!open || candidates[runId] || pending.has(runId)) return
    const version = reloadVersion
    pending.add(runId)
    candidateErrors = { ...candidateErrors, [runId]: '' }
    try {
      const top = await getTopCandidates(runId)
      if (version === reloadVersion) candidates = { ...candidates, [runId]: top }
    } catch (e) {
      if (version === reloadVersion) {
        candidateErrors = { ...candidateErrors, [runId]: e instanceof Error ? e.message : String(e) }
      }
    } finally {
      if (version === reloadVersion) pending.delete(runId)
    }
  }

  onMount(() => { void reload() })
  onDestroy(() => { reloadVersion++ })

  const statusTone = (s: string): 'info' | 'ok' | 'err' | 'neutral' | 'warn' =>
    s === 'running' ? 'info' : s === 'completed' ? 'ok' : s === 'failed' ? 'err' : s === 'paused' ? 'warn' : 'neutral'
</script>

{#if loading}
  <div class="empty surface">
    <p class="muted">{$_('common.loading')}</p>
  </div>
{:else if error}
  <div class="empty surface">
    <p class="err" role="alert">{error}</p>
    <Button variant="secondary" onclick={() => reload(offset)}>{$_('common.retry')}</Button>
  </div>
{:else if runs.length === 0}
  <div class="empty surface">
    <p class="muted">{$_('history.emptyTitle')}</p>
  </div>
{:else}
  <div class="list">
    {#each runs as run (run.id)}
      {@const bs = candidates[run.id]?.[0]?.score}
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
        <details ontoggle={(event) => { void toggleCandidates(run.id, event.currentTarget.open) }}>
          <summary>{$_('history.topCandidates')}</summary>
          {#if expanded.has(run.id)}
            {#if candidateErrors[run.id]}
              <p class="err" role="alert">{candidateErrors[run.id]}</p>
            {:else if !candidates[run.id]}
              <p class="dim" aria-live="polite">{$_('common.loading')}</p>
            {:else if candidates[run.id].length === 0}
              <p class="dim">{$_('history.noScoredCandidates')}</p>
            {:else}
              <div class="cands">
                {#each candidates[run.id] as c (c.id)}
                  <div class="cand">
                    <Tag tone={c.source === 'seed' ? 'accent' : 'neutral'}>{$_(`history.source.${c.source}`)}</Tag>
                    <span class="score numeric">{c.score != null ? c.score.toFixed(2) : '-'}</span>
                    <span class="cand-text">{c.text.slice(0, 160)}{c.text.length > 160 ? '…' : ''}</span>
                  </div>
                {/each}
              </div>
            {/if}
          {/if}
        </details>
        {#if run.errorMessage}
          <p class="err">{run.errorMessage}</p>
        {/if}
      </div>
    {/each}
  </div>
  {#if total > pageSize}
    <nav class="pager" aria-label={$_('history.title')}>
      <Button size="sm" variant="ghost" disabled={offset === 0} onclick={() => reload(Math.max(0, offset - pageSize))}>{$_('common.back')}</Button>
      <span class="dim numeric" aria-live="polite">{$_('history.pageRange', { values: { from: offset + 1, to: Math.min(offset + pageSize, total), total } })}</span>
      <Button size="sm" variant="ghost" disabled={offset + pageSize >= total} onclick={() => reload(offset + pageSize)}>{$_('common.next')}</Button>
    </nav>
  {/if}
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
  summary { cursor: pointer; color: var(--ink-2); font-size: var(--fs-sm); padding: var(--s-2) 0; }
  summary:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
  .pager { display: flex; justify-content: flex-end; align-items: center; gap: var(--s-2); margin-top: var(--s-3); flex-wrap: wrap; }
  .err { color: var(--err); margin: 0; font-size: var(--fs-sm); }
</style>
