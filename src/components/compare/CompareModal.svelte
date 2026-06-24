<script lang="ts">
  import { _ } from 'svelte-i18n'
  import Dialog from '../ui/Dialog.svelte'
  import Button from '../ui/Button.svelte'
  import Tag from '../ui/Tag.svelte'
  import PromptEditor from '../ui/PromptEditor.svelte'
  import { compareAB, comparisonState, resetComparison } from '../../stores/worker'
  import type { DatasetItem, RunConfig } from '../../lib/types'

  let {
    open = $bindable(false),
    taskId,
    config,
    initialPromptA = '',
    initialPromptB = '',
    items,
  }: { open?: boolean; taskId: string; config: RunConfig; initialPromptA?: string; initialPromptB?: string; items: DatasetItem[] } = $props()

  let promptA = $state('')
  let promptB = $state('')
  let selected = $state<string[]>([])

  $effect(() => {
    if (open) {
      promptA = initialPromptA
      promptB = initialPromptB
      selected = items.map((i) => i.id)
      resetComparison()
    }
  })

  function toggle(id: string) {
    selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
  }
  function selectAll() { selected = items.map((i) => i.id) }
  function selectNone() { selected = [] }

  function run() {
    if (!promptA.trim() || !promptB.trim() || selected.length === 0) return
    compareAB(taskId, promptA, promptB, selected, config)
  }

  const lastCompare = $derived($comparisonState.results)
  const compareError = $derived($comparisonState.error)
  const running = $derived($comparisonState.running)

  const stats = $derived.by(() => {
    if (!lastCompare) return null
    let aWins = 0, bWins = 0, ties = 0
    let scoreA = 0, scoreB = 0
    for (const r of lastCompare) {
      scoreA += r.verdict.scoreA; scoreB += r.verdict.scoreB
      if (r.verdict.winner === 'A') aWins++
      else if (r.verdict.winner === 'B') bWins++
      else ties++
    }
    const n = Math.max(1, lastCompare.length)
    return { aWins, bWins, ties, scoreA: scoreA / n, scoreB: scoreB / n, n }
  })
</script>

<Dialog bind:open title={$_('compare.title')} maxWidth="720px">
  <div class="form">
    <div class="col">
      <PromptEditor bind:value={promptA} label={$_('compare.promptA')} rows={5} />
    </div>
    <div class="col">
      <PromptEditor bind:value={promptB} label={$_('compare.promptB')} rows={5} />
    </div>
  </div>

  <div class="items">
    <div class="items-head">
      <span class="lbl">{$_('compare.items')} ({selected.length}/{items.length})</span>
      <div class="row">
        <button type="button" class="link" onclick={selectAll}>{$_('common.all')}</button>
        <button type="button" class="link" onclick={selectNone}>{$_('common.none')}</button>
      </div>
    </div>
    <div class="list">
      {#each items as it (it.id)}
        <label class="item-row">
          <input
            type="checkbox"
            checked={selected.includes(it.id)}
            onchange={() => toggle(it.id)}
          />
          <span class="item-input">{it.input}</span>
        </label>
      {/each}
    </div>
  </div>

  <div class="actions-row">
    <Button onclick={run} loading={running} disabled={running || !promptA.trim() || !promptB.trim() || selected.length === 0}>
      {$_('compare.run')}
    </Button>
  </div>

  {#if compareError}
    <div class="err" role="alert">{compareError}</div>
  {/if}

  {#if stats && lastCompare}
    <div class="results">
      <h4>{$_('compare.results')}</h4>
      <div class="score-row">
        <Tag tone={stats.aWins > stats.bWins ? 'ok' : 'neutral'}>
          {$_('compare.winnerA')}: {stats.aWins}/{stats.n}
        </Tag>
        <Tag tone={stats.bWins > stats.aWins ? 'ok' : 'neutral'}>
          {$_('compare.winnerB')}: {stats.bWins}/{stats.n}
        </Tag>
        <Tag tone="neutral">{$_('compare.tie')}: {stats.ties}</Tag>
        <span class="dim">A avg {stats.scoreA.toFixed(2)} · B avg {stats.scoreB.toFixed(2)}</span>
      </div>
      <details>
        <summary class="dim">{$_('compare.perItem.title', { values: { n: lastCompare.length } })}</summary>
        <ol class="verdicts">
          {#each lastCompare as r, i (i)}
            <li>
              <span class="v">{$_('compare.perItem.winner', { values: { w: r.verdict.winner } })}</span>
              <span class="dim">{$_('compare.perItem.scores', { values: { a: r.verdict.scoreA, b: r.verdict.scoreB } })}</span>
              <span class="reason">{r.verdict.reasoning}</span>
            </li>
          {/each}
        </ol>
      </details>
    </div>
  {/if}

  {#snippet actions()}
    <Button variant="ghost" onclick={() => (open = false)}>{$_('common.close')}</Button>
  {/snippet}
</Dialog>

<style>
  .form { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-3); margin-bottom: var(--s-4); }
  .col { display: flex; flex-direction: column; }
  .items { margin-bottom: var(--s-3); }
  .items-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--s-2); }
  .lbl { font-size: var(--fs-sm); color: var(--ink-2); font-weight: 500; }
  .row { display: flex; gap: var(--s-2); }
  .link { appearance: none; background: none; border: none; color: var(--secondary); font: inherit; font-size: var(--fs-xs); cursor: pointer; }
  .link:hover { text-decoration: underline; }
  .list { max-height: 160px; overflow-y: auto; border: 1px solid var(--border-1); border-radius: var(--r-sm); padding: var(--s-2); display: flex; flex-direction: column; gap: 2px; }
  .item-row { display: flex; gap: var(--s-2); align-items: flex-start; font-size: var(--fs-sm); padding: 4px 6px; border-radius: var(--r-sm); cursor: pointer; }
  .item-row:hover { background: var(--bg-2); }
  .item-input { font-family: var(--font-mono); color: var(--ink-2); }
  .actions-row { display: flex; justify-content: flex-end; }
  .err { margin-top: var(--s-3); color: var(--err); font-size: var(--fs-sm); }
  .results { margin-top: var(--s-4); padding-top: var(--s-4); border-top: 1px solid var(--border-1); display: flex; flex-direction: column; gap: var(--s-2); }
  .results h4 { margin: 0; font-size: var(--fs-md); }
  .score-row { display: flex; gap: var(--s-2); align-items: center; flex-wrap: wrap; }
  .dim { color: var(--ink-3); font-size: var(--fs-sm); }
  .verdicts { padding-left: var(--s-4); margin: var(--s-2) 0 0; max-height: 200px; overflow-y: auto; }
  .verdicts li { padding: 4px 0; display: flex; gap: var(--s-2); flex-wrap: wrap; font-size: var(--fs-sm); }
  .v { font-weight: 600; }
  .reason { color: var(--ink-2); flex: 1 1 100%; }
</style>
