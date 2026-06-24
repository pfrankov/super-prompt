<script lang="ts">
  import { _ } from 'svelte-i18n'
  import type { PromptCandidate } from '../../lib/types'
  import Tag from '../ui/Tag.svelte'
  import { optimizationState } from '../../stores/worker'

  const state = $derived($optimizationState)

  function scoreColor(score: number | null): string {
    if (score == null) return 'var(--ink-3)'
    if (score >= 7) return 'var(--ok)'
    if (score >= 5) return 'var(--primary)'
    return 'var(--err)'
  }
</script>

<div class="timeline">
  <h4 class="title">{$_('candidate.title')}</h4>
  {#if state.candidates.length === 0}
    <p class="muted">-</p>
  {:else}
    <ol class="list">
      {#each state.candidates as c (c.id)}
        {@const isBest = c.id === state.run?.bestCandidateId}
        <li class="cand" class:best={isBest}>
          <div class="cand-head">
            <Tag tone={c.source === 'seed' ? 'accent' : 'neutral'}>{c.source}</Tag>
            <span class="score numeric" style="color: {scoreColor(c.score)}">{c.score != null ? c.score.toFixed(2) : '-'}</span>
            {#if isBest}<Tag tone="ok">best</Tag>{/if}
          </div>
          <div class="cand-text">{c.text}</div>
          {#if c.rationale}
            <div class="rationale">{c.rationale}</div>
          {/if}
          <div class="cand-meta dim">
            <span>W{c.wins} L{c.losses} T{c.ties}</span>
            <span>· {(c.tokensIn + c.tokensOut).toLocaleString()} tok</span>
          </div>
        </li>
      {/each}
    </ol>
  {/if}
</div>

<style>
  .timeline { display: flex; flex-direction: column; gap: var(--s-2); }
  .title { margin: 0 0 var(--s-1); font-size: var(--fs-md); color: var(--ink-2); }
  .muted { color: var(--ink-3); margin: 0; }
  .list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--s-2); max-height: 400px; overflow-y: auto; }
  .cand {
    border: 1px solid var(--border-1);
    background: color-mix(in srgb, var(--bg-1) 92%, black);
    border-radius: var(--r-md);
    padding: var(--s-3);
    display: flex; flex-direction: column; gap: 4px;
  }
  .cand.best { border-color: rgba(238, 183, 124, 0.65); box-shadow: 0 0 0 1px rgba(238, 183, 124, 0.3); }
  .cand-head { display: flex; align-items: center; gap: var(--s-2); }
  .score { font-size: var(--fs-lg); font-weight: 600; }
  .cand-text {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--ink-2);
    max-height: 60px;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.5;
  }
  .rationale { font-size: var(--fs-xs); color: var(--ink-3); }
  .cand-meta { display: flex; gap: var(--s-2); font-size: var(--fs-xs); }
</style>
