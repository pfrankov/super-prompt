<script lang="ts">
  import type { Snippet } from 'svelte'
  import { diffPrompts, getPromptDiffPage, type PromptDiffCursor, type PromptLineEnding } from '../../lib/improve/prompt-diff'

  const defaults = {
    ariaLabel: 'Changes to prompt',
    unchanged: 'unchanged',
    removed: 'removed',
    added: 'added',
    empty: 'Both prompts are empty',
    limited: 'Detailed matching is limited for this prompt. Unmatched sections are shown as removed and added; counts describe this comparison.',
    page: 'Diff lines {from}–{to} of {total}',
    previous: 'Previous lines',
    next: 'Show more lines',
    continued: 'continued',
    lineEnding: 'Line ending',
    noLineEnding: 'No final line break',
    currentLine: 'Current line',
    proposedLine: 'Proposed line',
  }

  let { before, after, labels = {}, controls }: {
    before: string
    after: string
    labels?: Partial<typeof defaults>
    controls?: Snippet
  } = $props()

  const text = $derived({ ...defaults, ...labels })
  const diff = $derived(diffPrompts(before, after))
  let cursors = $state<PromptDiffCursor[]>([{ line: 0, offset: 0 }])
  let pageIndex = $state(0)
  let body: HTMLDivElement | undefined
  const page = $derived(getPromptDiffPage(diff, cursors[pageIndex]))
  const pageLabel = $derived(text.page
    .replace('{from}', String((page.lines[0]?.index ?? 0) + 1))
    .replace('{to}', String((page.lines.at(-1)?.index ?? 0) + 1))
    .replace('{total}', String(diff.lineCount)))

  $effect(() => {
    before
    after
    cursors = [{ line: 0, offset: 0 }]
    pageIndex = 0
    if (body) body.scrollTop = 0
  })

  function nextPage() {
    if (!page.next) return
    cursors = [...cursors.slice(0, pageIndex + 1), page.next]
    pageIndex++
    if (body) body.scrollTop = 0
  }

  function previousPage() {
    if (pageIndex === 0) return
    pageIndex--
    if (body) body.scrollTop = 0
  }

  function endingLabel(ending: PromptLineEnding) {
    return ending === '\r\n' ? 'CRLF' : ending === '\r' ? 'CR' : ending === '\n' ? 'LF' : text.noLineEnding
  }
</script>

<section class="prompt-diff" aria-label={text.ariaLabel} data-testid="prompt-diff" data-exact={diff.exact} data-coarse={diff.coarse}>
  <div class="diff-toolbar">
    <div class="diff-summary" data-testid="prompt-diff-summary" data-unchanged={diff.counts.unchanged} data-removed={diff.counts.removed} data-added={diff.counts.added}>
      <span>{diff.counts.unchanged} {text.unchanged}</span>
      <span class="removed-count">{diff.counts.removed} {text.removed}</span>
      <span class="added-count">{diff.counts.added} {text.added}</span>
    </div>
    {#if controls}<div class="diff-controls">{@render controls()}</div>{/if}
  </div>

  {#if !diff.exact}
    <p class="diff-notice" data-testid="prompt-diff-limited">{text.limited}</p>
  {/if}

  <div class="diff-body" bind:this={body}>
    {#if diff.lineCount === 0}
      <p class="diff-empty">{text.empty}</p>
    {:else}
      {#each page.lines as line (`${line.index}:${line.offset}`)}
        <div class="diff-line" class:removed={line.kind === 'removed'} class:added={line.kind === 'added'} data-testid="prompt-diff-row" data-kind={line.kind}>
          <span class="line-number" aria-hidden="true">{line.continued ? '·' : line.beforeLine ?? ''}</span>
          <span class="line-number proposed-number" aria-hidden="true">{line.continued ? '·' : line.afterLine ?? ''}</span>
          <span class="line-sign" aria-hidden="true">{line.kind === 'removed' ? '−' : line.kind === 'added' ? '+' : ' '}</span>
          <span class="sr-only">{text[line.kind]}. {line.beforeLine !== null ? `${text.currentLine} ${line.beforeLine}. ` : ''}{line.afterLine !== null ? `${text.proposedLine} ${line.afterLine}. ` : ''}{line.continued ? `${text.continued}. ` : ''}</span>
          <div class="line-content">
            <span class="line-text">{line.text}</span>{#if line.continues}<span class="continuation"> · {text.continued}</span>{:else if diff.showLineEndings && line.kind !== 'unchanged'}<span class="line-ending" title={`${text.lineEnding}: ${endingLabel(line.ending)}`}>{endingLabel(line.ending)}</span>{/if}
          </div>
        </div>
      {/each}
    {/if}
  </div>

  {#if page.next || pageIndex > 0}
    <div class="diff-pagination" data-testid="prompt-diff-pagination">
      <span aria-live="polite">{pageLabel}</span>
      <div class="page-actions">
        <button type="button" disabled={pageIndex === 0} onclick={previousPage} data-testid="prompt-diff-previous">{text.previous}</button>
        <button type="button" disabled={!page.next} onclick={nextPage} data-testid="prompt-diff-next">{text.next}</button>
      </div>
    </div>
  {/if}
</section>

<style>
  .prompt-diff { border: 1px solid var(--border-2); border-radius: 4px; overflow: hidden; background: var(--bg-0); min-width: 0; }
  .diff-toolbar { min-height: 56px; padding: 14px 22px; display: flex; align-items: center; justify-content: space-between; gap: 16px; background: color-mix(in srgb, var(--bg-1) 75%, transparent); border-bottom: 1px solid var(--border-1); }
  .diff-summary { display: flex; flex-wrap: wrap; gap: 8px 24px; color: var(--ink-2); font-family: var(--font-mono); font-size: 13px; }
  .removed-count { color: var(--err); }
  .added-count { color: var(--ok); }
  .diff-controls { flex-shrink: 0; }
  .diff-body { min-height: 160px; padding: 12px 0 24px; max-height: 680px; overflow: auto; }
  .diff-line { display: grid; grid-template-columns: 4ch 4ch 2ch minmax(0, 1fr); padding: 8px 20px 8px 12px; font-family: var(--font-mono); font-size: 15px; line-height: 1.65; color: var(--ink-1); }
  .diff-line.removed { background: color-mix(in srgb, var(--err) 12%, transparent); color: var(--err); }
  .diff-line.added { background: color-mix(in srgb, var(--ok) 13%, transparent); color: var(--ok); }
  .line-number { color: var(--ink-3); font-size: 12px; text-align: right; padding-right: 12px; user-select: none; align-self: start; }
  .proposed-number { border-right: 1px solid var(--border-1); }
  .line-sign { text-align: center; user-select: none; }
  .line-content { min-width: 0; padding-left: 12px; }
  .line-text { white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 4; }
  .line-ending, .continuation { font-family: var(--font-sans); font-size: 11px; color: var(--ink-2); }
  .line-ending { margin-left: 12px; padding: 1px 4px; border: 1px solid var(--border-2); border-radius: 3px; white-space: nowrap; }
  .diff-empty { padding: 24px; color: var(--ink-3); }
  .diff-notice { margin: 0; padding: 12px 22px; color: var(--ink-2); background: var(--bg-1); border-bottom: 1px solid var(--border-1); font-size: 13px; }
  .diff-pagination { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 12px 20px; border-top: 1px solid var(--border-1); color: var(--ink-2); font-size: 12px; }
  .page-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .page-actions button { padding: 7px 10px; color: var(--ink-1); background: var(--bg-1); border: 1px solid var(--border-2); border-radius: 4px; font: inherit; cursor: pointer; }
  .page-actions button:hover:not(:disabled) { background: var(--bg-3); }
  .page-actions button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  .page-actions button:disabled { opacity: .45; cursor: default; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  @media (max-width: 600px) {
    .diff-toolbar { padding: 12px; flex-wrap: wrap; }
    .diff-summary { gap: 8px 14px; font-size: 12px; }
    .diff-body { min-height: 160px; }
    .diff-line { grid-template-columns: 3.5ch 3.5ch 2ch minmax(0, 1fr); padding: 8px 10px 8px 2px; }
    .line-number { padding-right: 7px; font-size: 11px; }
    .line-content { padding-left: 6px; }
    .diff-pagination, .diff-notice { padding: 12px; }
  }
</style>
