<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { onMount } from 'svelte'
  import type { Task } from '../../lib/types'
  import { getDataset, getAllItems } from '../../lib/db/datasets'
  import { toJsonl } from '../../lib/io/jsonl'
  import { toCsv } from '../../lib/io/csv'
  import { slugify } from '../../lib/util/time'
  import { t } from '../../stores/toast'
  import Button from '../ui/Button.svelte'
  import DatasetTable from './DatasetTable.svelte'
  import DatasetImportExportDialog from './DatasetImportExportDialog.svelte'
  import GenerateDatasetPanel from './GenerateDatasetPanel.svelte'
  import Tag from '../ui/Tag.svelte'

  let { task = $bindable() as Task }: { task: Task } = $props()

  let importOpen = $state(false)
  let reloadKey = $state(0)
  let itemCount = $state(0)

  async function refreshCount() {
    if (!task.datasetId) {
      itemCount = 0
      return
    }
    const ds = await getDataset(task.datasetId)
    itemCount = ds?.itemCount ?? 0
  }

  function onDatasetChanged(datasetId?: string) {
    if (datasetId) task.datasetId = datasetId
    reloadKey++
    void refreshCount()
  }

  $effect(() => {
    task.datasetId
    reloadKey
    refreshCount()
  })

  async function exportJsonl() {
    if (!task.datasetId) return
    const items = await getAllItems(task.datasetId)
    const text = toJsonl(items.map((it) => ({ input: it.input, expectedOutput: it.expectedOutput, meta: it.meta })))
    download(text, `${slugify(task.name)}-dataset.jsonl`, 'application/x-ndjson')
    t.success($_('toast.exported'))
  }

  async function exportCsv() {
    if (!task.datasetId) return
    const items = await getAllItems(task.datasetId)
    const text = toCsv(items.map((it) => ({ input: it.input, expectedOutput: it.expectedOutput, meta: it.meta })))
    download(text, `${slugify(task.name)}-dataset.csv`, 'text/csv')
    t.success($_('toast.exported'))
  }

  function download(text: string, name: string, mime: string) {
    const blob = new Blob([text], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }
</script>

<div class="head">
  <div class="left">
    <h3>{$_('dataset.title')}</h3>
    <p class="muted">{$_('dataset.subtitle')}</p>
  </div>
  <div class="actions">
    {#if itemCount > 0}
      <Tag tone="ok">{$_(itemCount === 1 ? 'dataset.rows_one' : 'dataset.rows_other', { values: { count: itemCount } })}</Tag>
      <Button size="sm" variant="ghost" onclick={exportJsonl}>JSONL</Button>
      <Button size="sm" variant="ghost" onclick={exportCsv}>CSV</Button>
    {/if}
    <Button size="sm" variant="secondary" onclick={() => (importOpen = true)}>{$_('dataset.import.title')}</Button>
  </div>
</div>

<DatasetTable
  dataset={task.datasetId ? { id: task.datasetId, taskId: task.id, name: $_('dataset.namePlaceholder'), itemCount, createdAt: 0 } : null}
  taskId={task.id}
  {reloadKey}
  oncreated={(datasetId) => onDatasetChanged(datasetId)}
  onchanged={() => onDatasetChanged()}
/>

{#key reloadKey}
  <GenerateDatasetPanel taskId={task.id} oncommitted={(datasetId) => onDatasetChanged(datasetId)} />
{/key}

<DatasetImportExportDialog
  bind:open={importOpen}
  taskId={task.id}
  onimported={(datasetId) => onDatasetChanged(datasetId)}
/>

<style>
  .head {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: var(--s-4);
    margin-bottom: var(--s-4);
    flex-wrap: wrap;
  }
  .left h3 { margin: 0 0 var(--s-1); font-size: var(--fs-xl); }
  .muted { color: var(--ink-2); margin: 0; font-size: var(--fs-sm); }
  .actions { display: flex; gap: var(--s-2); align-items: center; flex-wrap: wrap; }
</style>
