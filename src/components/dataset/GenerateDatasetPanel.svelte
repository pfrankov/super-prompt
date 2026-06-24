<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { settings } from '../../stores/settings'
  import { chatCompletion } from '../../lib/api/openaiLike'
  import { addItems, createDataset, getDatasetByTask } from '../../lib/db/datasets'
  import { getTask, saveTask } from '../../lib/db/tasks'
  import Button from '../ui/Button.svelte'
  import NumberField from '../ui/NumberField.svelte'
  import TextArea from '../ui/TextArea.svelte'
  import Tag from '../ui/Tag.svelte'
  import type { ParsedRow } from '../../lib/io/jsonl'
  import { t } from '../../stores/toast'
  import { judgeRoute } from '../../lib/optimizer/judge'

  let { taskId, oncommitted }: { taskId: string; oncommitted?: (datasetId: string) => void } = $props()

  let count = $state(8)
  let generating = $state(false)
  let preview: ParsedRow[] = $state([])
  let error = $state('')
  let extraContext = $state('')

  async function generate() {
    generating = true
    error = ''
    preview = []
    try {
      const p = $settings.provider
      const route = judgeRoute(p, $settings.arbitrator)
      const sys = `You generate dataset examples for evaluating system prompts. Output ONLY a JSON array, no prose, no fences. Each item: {"input": string, "expectedOutput": string, "notes": string}. "input" is the user message. "expectedOutput" is what an excellent response looks like. "notes" explains the difficulty or edge case. Cover diverse, realistic cases.`
      const user = `Task: ${extraContext || 'Generate examples that cover varied difficulty, edge cases, and common pitfalls.'}\n\nProduce exactly ${count} examples. JSON array only.`
      const resp = await chatCompletion({
        baseUrl: route.baseUrl,
        apiKey: route.apiKey,
        model: route.model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        temperature: 0.8,
        maxTokens: 2000,
        timeoutMs: p.requestTimeoutMs,
      })
      const jsonMatch = resp.text.match(/\[[\s\S]*\]/)
      if (!jsonMatch) throw new Error('No JSON array found in response')
      const arr = JSON.parse(jsonMatch[0]) as Array<{ input: string; expectedOutput?: string; notes?: string }>
      preview = arr
        .filter((r) => typeof r.input === 'string' && r.input.trim())
        .map((r) => ({
          input: r.input,
          expectedOutput: r.expectedOutput,
          meta: r.notes ? { notes: r.notes } : undefined,
        }))
      if (!preview.length) throw new Error('No valid examples parsed')
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      generating = false
    }
  }

  async function commit() {
    if (!preview.length) return
    let ds = await getDatasetByTask(taskId)
    if (!ds) ds = await createDataset(taskId)
    await addItems(ds.id, preview)
    const tk = await getTask(taskId)
    if (tk) await saveTask({ ...tk, datasetId: ds.id })
    preview = []
    t.success($_('toast.imported'))
    oncommitted?.(ds.id)
  }
</script>

<details class="panel surface">
  <summary>
    <span>
      <strong>{$_('dataset.generate.title')}</strong>
      <small>{$_('dataset.generate.body')}</small>
    </span>
  </summary>

  <div class="body">
    <div class="controls">
      <NumberField bind:value={count} label={$_('dataset.generate.count')} min={1} max={50} />
      <TextArea bind:value={extraContext} label={$_('dataset.generate.extraContext.label')} placeholder={$_('dataset.generate.extraContext.placeholder')} rows={2} />
    </div>

    <div class="actions">
      <Button onclick={generate} loading={generating}>{$_('dataset.generate.regenerate')}</Button>
      {#if preview.length}
        <Button variant="primary" onclick={commit}>{$_('dataset.generate.commit')} ({preview.length})</Button>
      {/if}
    </div>

    {#if error}
      <div class="err"><Tag tone="err">{error}</Tag></div>
    {/if}

    {#if preview.length}
      <div class="preview">
        <span class="preview-title">{$_('dataset.generate.preview')}</span>
        <ol>
          {#each preview as row, i (i)}
            <li>
              <span class="cell">{row.input}</span>
              {#if row.expectedOutput}<span class="muted">-> {row.expectedOutput}</span>{/if}
              {#if row.meta?.notes}<span class="dim">- {row.meta.notes}</span>{/if}
            </li>
          {/each}
        </ol>
      </div>
    {/if}
  </div>
</details>

<style>
  .panel { margin-top: var(--s-4); padding: 0; overflow: hidden; }
  summary {
    display: flex;
    align-items: center;
    cursor: pointer;
    padding: var(--s-4);
    color: var(--ink-1);
    list-style: none;
  }
  summary::-webkit-details-marker { display: none; }
  summary span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  summary strong { font-size: var(--fs-md); font-weight: 600; }
  summary small { color: var(--ink-3); font-size: var(--fs-sm); font-weight: 400; }
  summary::after {
    content: "+";
    margin-left: auto;
    color: var(--ink-3);
    font-size: var(--fs-xl);
    line-height: 1;
    transition: transform var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }
  .panel[open] summary::after {
    content: "-";
    color: var(--primary);
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    padding: 0 var(--s-4) var(--s-4);
  }
  .muted { color: var(--ink-3); margin: 0; }
  .controls { display: grid; grid-template-columns: 200px 1fr; gap: var(--s-3); }
  .actions { display: flex; gap: var(--s-2); }
  .err { color: var(--err); }
  .preview { background: var(--bg-2); border: 1px solid var(--border-1); border-radius: var(--r-md); padding: var(--s-3); }
  .preview-title { font-size: var(--fs-sm); color: var(--ink-3); display: block; margin-bottom: var(--s-2); }
  .preview ol { padding-left: var(--s-4); margin: 0; max-height: 240px; overflow-y: auto; }
  .preview li { padding: 4px 0; font-size: var(--fs-sm); }
  .cell { font-family: var(--font-mono); color: var(--ink-1); margin-right: var(--s-2); }
  .dim { color: var(--ink-3); }
  @media (max-width: 760px) {
    .controls { grid-template-columns: 1fr; }
    .actions { flex-wrap: wrap; }
  }
</style>
