import { db } from './db'
import type { Dataset, DatasetItem } from '../types'
import { newId } from '../util/id'
import { TaskNotFoundError } from './tasks'

type DatasetItemInput = Omit<DatasetItem, 'id' | 'datasetId'>

function plainMeta(meta: DatasetItemInput['meta']): DatasetItemInput['meta'] {
  if (!meta) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (value == null) continue
    out[String(key)] = String(value)
  }
  return Object.keys(out).length ? out : undefined
}

export function toPlainDatasetItemInput(item: DatasetItemInput): DatasetItemInput {
  const expectedOutput = item.expectedOutput == null ? undefined : String(item.expectedOutput)
  return {
    input: String(item.input),
    expectedOutput,
    meta: plainMeta(item.meta),
  }
}

export function toPlainDatasetItem(item: DatasetItem): DatasetItem {
  const input = toPlainDatasetItemInput(item)
  return {
    id: String(item.id),
    datasetId: String(item.datasetId),
    ...input,
  }
}

export async function createDataset(taskId: string, name = 'Default'): Promise<Dataset> {
  const d = await db()
  const ds: Dataset = {
    id: newId(),
    taskId,
    name,
    itemCount: 0,
    createdAt: Date.now(),
  }
  // A concurrent deletion must either see this child or prevent its creation.
  const tx = d.transaction(['tasks', 'datasets'], 'readwrite')
  if (!await tx.objectStore('tasks').get(taskId)) {
    await tx.done
    throw new TaskNotFoundError(taskId)
  }
  await tx.objectStore('datasets').put(ds)
  await tx.done
  return ds
}

/** Reuse the durable task link or atomically create and link its first dataset. */
export async function ensureTaskDataset(taskId: string, name = 'Default', signal?: AbortSignal): Promise<Dataset> {
  signal?.throwIfAborted()
  const d = await db()
  signal?.throwIfAborted()
  const tx = d.transaction(['tasks', 'datasets'], 'readwrite')
  const finished = tx.done
  void finished.catch(() => {})
  const abort = () => { try { tx.abort() } catch { /* Already committed. */ } }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const tasks = tx.objectStore('tasks')
    const datasets = tx.objectStore('datasets')
    const task = await tasks.get(taskId)
    if (!task) throw new TaskNotFoundError(taskId)
    const existing = task.datasetId ? await datasets.get(task.datasetId) : undefined
    signal?.throwIfAborted()
    if (existing) {
      await finished
      return existing
    }
    const dataset: Dataset = { id: newId(), taskId, name, itemCount: 0, createdAt: Date.now() }
    await datasets.add(dataset)
    await tasks.put({ ...task, datasetId: dataset.id, updatedAt: Date.now() })
    await finished
    // Cancellation after commit cannot undo the transaction. The linked dataset
    // remains discoverable and reusable, including any manual rows added later.
    return dataset
  } catch (error) {
    abort()
    await finished.catch(() => {})
    if (signal?.aborted) throw signal.reason
    throw error
  } finally { signal?.removeEventListener('abort', abort) }
}

export async function getDataset(id: string): Promise<Dataset | undefined> {
  const d = await db()
  return d.get('datasets', id)
}

export async function getDatasetByTask(taskId: string): Promise<Dataset | undefined> {
  const d = await db()
  return d.getFromIndex('datasets', 'by-taskId', taskId)
}

export async function addItems(datasetId: string, items: Omit<DatasetItem, 'id' | 'datasetId'>[]): Promise<DatasetItem[]> {
  const d = await db()
  const tx = d.transaction(['datasets', 'datasets_items'], 'readwrite')
  const dsStore = tx.objectStore('datasets')
  const itStore = tx.objectStore('datasets_items')
  const ds = await dsStore.get(datasetId)
  if (!ds) throw new Error('dataset not found')
  const out: DatasetItem[] = items.map(toPlainDatasetItemInput).map((it) => ({
    id: newId(),
    datasetId,
    input: it.input,
    expectedOutput: it.expectedOutput,
    meta: it.meta,
  }))
  for (const it of out) await itStore.add(it)
  await dsStore.put({ ...ds, itemCount: ds.itemCount + out.length })
  await tx.done
  return out
}

export async function updateItem(item: DatasetItem): Promise<void> {
  const d = await db()
  const tx = d.transaction('datasets_items', 'readwrite')
  const existing = await tx.store.get(item.id)
  if (existing && existing.datasetId === item.datasetId) await tx.store.put(toPlainDatasetItem(item))
  await tx.done
}

export async function deleteItem(itemId: string): Promise<void> {
  const d = await db()
  const tx = d.transaction(['datasets', 'datasets_items'], 'readwrite')
  const it = await tx.objectStore('datasets_items').get(itemId)
  if (it) {
    await tx.objectStore('datasets_items').delete(itemId)
    const ds = await tx.objectStore('datasets').get(it.datasetId)
    if (ds) {
      await tx.objectStore('datasets').put({
        ...ds,
        itemCount: Math.max(0, ds.itemCount - 1),
      })
    }
  }
  await tx.done
}

export async function getItems(
  datasetId: string,
  { offset = 0, limit = 50 }: { offset?: number; limit?: number } = {}
): Promise<DatasetItem[]> {
  const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0
  const size = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 50
  if (size === 0) return []
  const d = await db()
  const tx = d.transaction('datasets_items', 'readonly')
  const index = tx.store.index('by-datasetId')
  let cursor = await index.openCursor(datasetId)
  // advance skips index entries without materializing every skipped row. The
  // existing index orders equal dataset keys by primary key, just like getAll.
  if (cursor && start > 0) cursor = await cursor.advance(start)
  const items: DatasetItem[] = []
  while (cursor && items.length < size) {
    items.push(cursor.value)
    if (items.length < size) cursor = await cursor.continue()
  }
  await tx.done
  return items
}

export async function getAllItems(datasetId: string): Promise<DatasetItem[]> {
  const d = await db()
  return d.getAllFromIndex('datasets_items', 'by-datasetId', datasetId)
}

export async function countItems(datasetId: string): Promise<number> {
  const d = await db()
  return d.countFromIndex('datasets_items', 'by-datasetId', datasetId)
}

export async function clearDataset(datasetId: string): Promise<void> {
  const d = await db()
  const tx = d.transaction(['datasets', 'datasets_items'], 'readwrite')
  const idx = tx.objectStore('datasets_items').index('by-datasetId')
  for await (const c of idx.iterate(datasetId)) await c.delete()
  const ds = await tx.objectStore('datasets').get(datasetId)
  if (ds) await tx.objectStore('datasets').put({ ...ds, itemCount: 0 })
  await tx.done
}


/** Replace auto-generated examples atomically; never overwrite newly added manual rows. */
export async function replaceGeneratedItems(
  datasetId: string,
  items: DatasetItemInput[],
  signal?: AbortSignal
): Promise<boolean> {
  signal?.throwIfAborted()
  const d = await db()
  signal?.throwIfAborted()
  const tx = d.transaction(['datasets', 'datasets_items'], 'readwrite')
  // Observe abort rejection even when a preceding request rejects first.
  const finished = tx.done.catch((error: unknown) => { throw error })
  void finished.catch(() => {})
  const abort = () => { try { tx.abort() } catch { /* Already committed. */ } }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const ds = await tx.objectStore('datasets').get(datasetId)
    if (!ds) throw new Error('dataset not found')
    const existing = await tx.objectStore('datasets_items').index('by-datasetId').getAll(datasetId)
    signal?.throwIfAborted()
    if (existing.some((item) => item.meta?.source !== 'generated' || item.meta?.touched === 'manual')) {
      await finished
      return false
    }
    const store = tx.objectStore('datasets_items')
    const writes: Promise<unknown>[] = existing.map((item) => store.delete(item.id))
    for (const item of items) writes.push(store.put({ ...toPlainDatasetItemInput(item), id: newId(), datasetId }))
    await Promise.all(writes)
    await tx.objectStore('datasets').put({ ...ds, itemCount: items.length })
    await finished
    return true
  } catch (error) {
    abort()
    await finished.catch(() => {})
    if (signal?.aborted) throw signal.reason
    throw error
  } finally { signal?.removeEventListener('abort', abort) }
}
