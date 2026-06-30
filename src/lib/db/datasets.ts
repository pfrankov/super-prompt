import { db } from './db'
import type { Dataset, DatasetItem } from '../types'
import { newId } from '../util/id'

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
  await d.put('datasets', ds)
  return ds
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
  await d.put('datasets_items', toPlainDatasetItem(item))
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
  const d = await db()
  const all = await d.getAllFromIndex('datasets_items', 'by-datasetId', datasetId)
  return all.slice(offset, offset + limit)
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
