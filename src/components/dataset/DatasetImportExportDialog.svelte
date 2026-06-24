<script lang="ts">
  import { _ } from 'svelte-i18n'
  import Dialog from '../ui/Dialog.svelte'
  import Button from '../ui/Button.svelte'
  import { readDatasetFile } from '../../lib/io/csv'
  import { addItems, getDatasetByTask, createDataset } from '../../lib/db/datasets'
  import { getTask, saveTask } from '../../lib/db/tasks'
  import type { ParsedRow } from '../../lib/io/jsonl'
  import { t } from '../../stores/toast'

  let {
    open = $bindable(false),
    taskId,
    onimported,
  }: { open?: boolean; taskId: string; onimported?: (datasetId: string) => void } = $props()

  let file: File | null = $state(null)
  let preview: ParsedRow[] = $state([])
  let loading = $state(false)
  let drag = $state(false)

  const ALLOWED_EXT = ['.jsonl', '.ndjson', '.csv', '.tsv']

  function isAllowed(f: File): boolean {
    const lower = f.name.toLowerCase()
    return ALLOWED_EXT.some((ext) => lower.endsWith(ext))
  }

  async function handleFile(f: File) {
    if (!isAllowed(f)) {
      t.error($_('common.invalidType'))
      return
    }
    file = f
    loading = true
    try {
      preview = await readDatasetFile(f)
    } catch (e) {
      t.error(String(e))
      preview = []
    } finally {
      loading = false
    }
  }

  async function commit() {
    if (!preview.length) return
    let ds = await getDatasetByTask(taskId)
    if (!ds) {
      ds = await createDataset(taskId)
    }
    await addItems(ds.id, preview)
    const t0 = await getTask(taskId)
    if (t0) await saveTask({ ...t0, datasetId: ds.id })
    open = false
    file = null
    preview = []
    t.success($_('toast.imported'))
    onimported?.(ds.id)
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    drag = false
    const f = e.dataTransfer?.files?.[0]
    if (f) handleFile(f)
  }
</script>

<Dialog bind:open title={$_('dataset.import.title')} maxWidth="640px">
  <div
    class="drop"
    class:drag
    ondragover={(e) => { e.preventDefault(); drag = true }}
    ondragleave={(e) => {
      if (e.relatedTarget && (e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) return
      drag = false
    }}
    ondrop={onDrop}
    role="region"
    aria-label={$_('dataset.import.drop')}
  >
    {#if drag && !file}
      <div class="drop-overlay">
        <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
          <path d="M12 3v12M6 9l6-6 6 6M5 21h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        </svg>
        <strong>{$_('common.dropHere')}</strong>
      </div>
    {:else if file}
      <div class="file">
        <strong>{file.name}</strong>
        <span class="dim">{(file.size / 1024).toFixed(1)} KB</span>
      </div>
      {#if loading}
        <p class="muted">{$_('common.loading')}</p>
      {:else if preview.length}
        <div class="preview">
          <span class="preview-title">{$_('dataset.import.preview')}</span>
          <ol>
            {#each preview.slice(0, 5) as row, i (i)}
              <li>
                <span class="cell">{row.input}</span>
                {#if row.expectedOutput}<span class="muted">-&gt; {row.expectedOutput}</span>{/if}
              </li>
            {/each}
          </ol>
          <p class="dim">{$_('dataset.import.rowsTotal', { values: { count: preview.length } })}</p>
        </div>
      {/if}
    {:else}
      <p class="drop-text">{$_('dataset.import.drop')}</p>
      <span class="muted">{$_('dataset.import.or')}</span>
      <input
        class="file-input"
        type="file"
        accept=".jsonl,.ndjson,.csv,.tsv"
        aria-label={$_('dataset.import.browse')}
        onchange={(e) => {
          const f = (e.currentTarget as HTMLInputElement).files?.[0]
          if (f) handleFile(f)
        }}
      />
    {/if}
  </div>
  {#snippet actions()}
    <Button variant="ghost" onclick={() => (open = false)}>{$_('common.cancel')}</Button>
    <Button onclick={commit} disabled={!preview.length}>{$_('dataset.import.commit')}</Button>
  {/snippet}
</Dialog>

<style>
  .drop {
    position: relative;
    border: 2px dashed var(--border-2);
    border-radius: var(--r-md);
    padding: var(--s-6);
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--s-2);
    transition: border-color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
  }
  .drop.drag { border-color: var(--primary); background: rgba(238, 183, 124, 0.04); }
  .drop-overlay {
    position: absolute; inset: 0;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: var(--s-2);
    background: rgba(238, 183, 124, 0.08);
    border: 2px dashed var(--primary);
    border-radius: var(--r-md);
    color: var(--primary);
    pointer-events: none;
    z-index: 1;
  }
  .drop-text { color: var(--ink-2); margin: 0; }
  .file { display: flex; align-items: center; gap: var(--s-3); }
  .preview { width: 100%; text-align: left; margin-top: var(--s-2); }
  .preview-title { font-size: var(--fs-sm); color: var(--ink-3); display: block; margin-bottom: var(--s-2); }
  .preview ol { padding-left: var(--s-4); margin: 0; }
  .preview li { padding: 4px 0; font-size: var(--fs-sm); }
  .cell { font-family: var(--font-mono); color: var(--ink-1); margin-right: var(--s-2); }
  .muted { color: var(--ink-3); margin: 0; }
  .dim { color: var(--ink-3); }
  .file-input {
    appearance: none;
    background: var(--bg-2); padding: var(--s-2) var(--s-3);
    border: 1px solid var(--border-1); border-radius: var(--r-md);
    color: var(--ink-1);
    font: inherit; font-size: var(--fs-sm);
    cursor: pointer;
  }
  .file-input:hover { background: var(--bg-3); }
  .file-input:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
</style>
