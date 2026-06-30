<script lang="ts">
  import { _ } from 'svelte-i18n'
  import type { Dataset, DatasetItem } from '../../lib/types'
  import { addItems, getItems, deleteItem, updateItem, countItems, createDataset } from '../../lib/db/datasets'
  import { getTask, saveTask } from '../../lib/db/tasks'
  import Button from '../ui/Button.svelte'
  import Tag from '../ui/Tag.svelte'
  import { t } from '../../stores/toast'

  let {
    dataset,
    taskId,
    reloadKey = 0,
    oncreated,
    onchanged,
  }: {
    dataset: Dataset | null
    taskId: string
    reloadKey?: number
    oncreated?: (datasetId: string) => void
    onchanged?: () => void
  } = $props()

  let items: DatasetItem[] = $state([])
  let total = $state(0)
  let offset = $state(0)
  let localDataset: Dataset | null = $state(null)
  const pageSize = 10

  let newInput = $state('')
  let newExpected = $state('')
  let pendingDelete: string | null = $state(null)
  let pendingSave: Set<string> = $state(new Set())
  const activeDataset = $derived(dataset ?? localDataset)

  async function reload() {
    if (!activeDataset) {
      items = []
      total = 0
      return
    }
    total = await countItems(activeDataset.id)
    items = await getItems(activeDataset.id, { offset, limit: pageSize })
  }

  $effect(() => {
    dataset
    if (dataset) localDataset = dataset
    reloadKey
    reload()
  })

  async function ensureDataset(): Promise<Dataset> {
    if (activeDataset) return activeDataset
    const ds = await createDataset(taskId)
    localDataset = ds
    const task = await getTask(taskId)
    if (task) await saveTask({ ...task, datasetId: ds.id })
    oncreated?.(ds.id)
    return ds
  }

  async function add() {
    if (!newInput.trim()) return
    const ds = await ensureDataset()
    await addItems(ds.id, [{ input: newInput.trim(), expectedOutput: newExpected.trim() || undefined }])
    newInput = ''
    newExpected = ''
    offset = 0
    await reload()
    onchanged?.()
    t.success($_('toast.saved'))
  }

  function requestDelete(id: string) {
    if (pendingDelete === id) {
      void remove(id)
      pendingDelete = null
      return
    }
    pendingDelete = id
    setTimeout(() => {
      if (pendingDelete === id) pendingDelete = null
    }, 3000)
  }

  async function remove(id: string) {
    await deleteItem(id)
    await reload()
    onchanged?.()
  }

  async function edit(it: DatasetItem, field: 'input' | 'expectedOutput', val: string) {
    const next = {
      ...it,
      [field]: val,
      meta: { ...(it.meta ?? {}), touched: 'manual' },
    }
    items = items.map((row) => row.id === it.id ? next : row)
    pendingSave = new Set([...pendingSave, it.id])
    try {
      await updateItem(next)
    } catch (e) {
      t.error(String(e))
    } finally {
      const next = new Set(pendingSave)
      next.delete(it.id)
      pendingSave = next
      onchanged?.()
    }
  }
</script>

<div class="wrap">
  <div class="head">
    <span class="count">{$_(total === 1 ? 'dataset.rows_one' : 'dataset.rows_other', { values: { count: total } })}</span>
    {#if activeDataset}
      <Tag tone="neutral">{activeDataset?.name ?? ''}</Tag>
    {/if}
  </div>

  {#if !activeDataset || total === 0}
    <div class="empty">
      <p class="muted">{$_('dataset.emptyBody')}</p>
    </div>
  {:else}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="num">#</th>
            <th>{$_('dataset.input')}</th>
            <th>{$_('dataset.expected')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each items as it, i (it.id)}
            <tr>
              <td class="num dim">{offset + i + 1}</td>
              <td>
                <textarea
                  class="cell-input"
                  class:busy={pendingSave.has(it.id)}
                  rows="2"
                  value={it.input}
                  oninput={(e) => edit(it, 'input', (e.currentTarget as HTMLTextAreaElement).value)}
                ></textarea>
              </td>
              <td>
                <textarea
                  class="cell-input"
                  class:busy={pendingSave.has(it.id)}
                  rows="2"
                  value={it.expectedOutput ?? ''}
                  oninput={(e) => edit(it, 'expectedOutput', (e.currentTarget as HTMLTextAreaElement).value)}
                ></textarea>
              </td>
              <td class="actions-cell">
                <button
                  class="row-del"
                  class:confirming={pendingDelete === it.id}
                  type="button"
                  onclick={() => requestDelete(it.id)}
                  aria-label={$_('common.delete')}
                >
                  {#if pendingSave.has(it.id)}
                    <span class="busy-dot" aria-label={$_('common.saving')}></span>
                  {:else if pendingDelete === it.id}
                    <span class="confirm-txt">!</span>
                  {:else}
                    <svg viewBox="0 0 20 20" width="14" height="14"><path d="M5 6h10M8 6V4h4v2M7 6l1 10h4l1-10" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
                  {/if}
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    {#if total > pageSize}
      <div class="pager">
        <Button size="sm" variant="ghost" disabled={offset === 0} onclick={() => { offset = Math.max(0, offset - pageSize); reload() }}>{'<'}</Button>
        <span class="dim numeric">{offset + 1}-{Math.min(offset + pageSize, total)} / {total}</span>
        <Button size="sm" variant="ghost" disabled={offset + pageSize >= total} onclick={() => { offset += pageSize; reload() }}>{'>'}</Button>
      </div>
    {/if}
  {/if}

  <div class="add surface">
    <textarea
      class="add-input"
      rows="2"
      placeholder={$_('dataset.input')}
      bind:value={newInput}
    ></textarea>
    <textarea
      class="add-input"
      rows="2"
      placeholder={$_('dataset.expected')}
      bind:value={newExpected}
    ></textarea>
    <div class="add-action">
      <Button onclick={add} disabled={!newInput.trim()}>{$_('dataset.addItem')}</Button>
    </div>
  </div>
</div>

<style>
  .wrap { display: flex; flex-direction: column; gap: var(--s-3); }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--s-1);
  }
  .count { color: var(--ink-2); font-size: var(--fs-sm); font-weight: 500; }
  .empty { padding: var(--s-8); text-align: center; }
  .muted { color: var(--ink-3); margin: 0; }
  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--border-1);
    border-radius: var(--r-lg);
    background: color-mix(in srgb, var(--bg-1) 92%, black);
    box-shadow: var(--shadow-1);
  }
  table { width: 100%; border-collapse: separate; border-spacing: 0; }
  th, td { padding: var(--s-3); text-align: left; vertical-align: top; }
  thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-3);
    border-bottom: 1px solid var(--border-1);
    padding: 11px var(--s-3);
    background: color-mix(in srgb, var(--bg-2) 82%, black);
  }
  tbody td { border-bottom: 1px solid rgba(241, 238, 231, 0.055); }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr {
    transition: background-color var(--dur-fast) var(--ease);
  }
  tbody tr:hover {
    background: rgba(238, 183, 124, 0.035);
  }
  .num { width: 40px; font-variant-numeric: tabular-nums; }
  .cell-input {
    width: 100%;
    min-width: 140px;
    min-height: 36px;
    height: 36px;
    background: transparent;
    border: 1px solid transparent;
    padding: 7px 9px 6px;
    color: var(--ink-1);
    font: inherit;
    font-size: var(--fs-sm);
    border-radius: var(--r-sm);
    resize: none;
    font-family: var(--font-mono);
    line-height: 1.4;
    overflow: hidden;
    transition:
      background-color var(--dur-fast) var(--ease),
      border-color var(--dur-fast) var(--ease),
      box-shadow var(--dur-fast) var(--ease);
  }
  .cell-input:hover { border-color: var(--border-1); background: rgba(241, 238, 231, 0.025); }
  .cell-input:focus {
    height: auto;
    min-height: 56px;
    overflow: auto;
    outline: none;
    border-color: rgba(238, 183, 124, 0.55);
    background: var(--bg-2);
    box-shadow: 0 0 0 3px rgba(238, 183, 124, 0.1);
  }
  .actions-cell { width: 36px; text-align: right; }
  .row-del {
    appearance: none; background: transparent; border: none; padding: 4px;
    color: var(--ink-4); border-radius: var(--r-sm); cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 24px; min-height: 24px;
  }
  .row-del:hover { background: rgba(232, 170, 163, 0.1); color: var(--err); }
  .row-del.confirming { background: var(--err); color: var(--bg-1); }
  .confirm-txt { font-weight: 700; font-size: var(--fs-sm); }
  .cell-input.busy { opacity: 0.6; }
  .busy-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--primary);
    animation: pulse 1.2s var(--ease) infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.3; }
    50% { opacity: 1; }
  }
  .pager { display: flex; justify-content: flex-end; align-items: center; gap: var(--s-2); }
  .add {
    display: grid;
    grid-template-columns: 1fr 1fr auto;
    gap: var(--s-2);
    padding: var(--s-3);
    margin-top: var(--s-2);
    background: color-mix(in srgb, var(--bg-1) 88%, black);
  }
  .add-input {
    background: var(--bg-2);
    border: 1px solid var(--border-1);
    border-radius: var(--r-md);
    padding: var(--s-3);
    color: var(--ink-1);
    font: inherit;
    font-size: var(--fs-sm);
    font-family: var(--font-mono);
    resize: vertical;
    min-height: 58px;
  }
  .add-input:focus { outline: none; border-color: rgba(238, 183, 124, 0.55); box-shadow: 0 0 0 3px rgba(238, 183, 124, 0.1); }
  .add-action { display: flex; align-items: flex-end; }
  @media (max-width: 760px) {
    .add { grid-template-columns: 1fr; }
    .add-action { align-items: stretch; }
    .add-action :global(.btn) { width: 100%; }
    th, td { padding: var(--s-2); }
  }
</style>
