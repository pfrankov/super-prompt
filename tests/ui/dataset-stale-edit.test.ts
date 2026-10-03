import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import DatasetTable from '../../src/components/dataset/DatasetTable.svelte'
import { createTask } from '../../src/lib/db/tasks'
import { addItems, clearDataset, createDataset, deleteItem, getAllItems, replaceGeneratedItems, updateItem } from '../../src/lib/db/datasets'
import { db, wipeAll } from '../../src/lib/db/db'
import * as databaseModule from '../../src/lib/db/db'
import * as datasets from '../../src/lib/db/datasets'
import { t } from '../../src/stores/toast'
import { locale } from '../../src/lib/i18n'
import type { Dataset } from '../../src/lib/types'

const mounted: ReturnType<typeof mount>[] = []
function show(dataset: Dataset) {
  const target = document.createElement('div')
  document.body.appendChild(target)
  mounted.push(mount(DatasetTable, { target, props: { taskId: dataset.taskId, dataset } }))
  flushSync()
  return target
}
function input(element: HTMLTextAreaElement, value: string) {
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
  flushSync()
}
beforeEach(async () => { await wipeAll(); locale.set('en') })
afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component)
  document.body.replaceChildren(); vi.restoreAllMocks()
})

it.each(['delete', 'clear', 'regenerate'] as const)('rejects and reconciles a stale table edit after another context performs %s', async (action) => {
  const dataset = await createDataset((await createTask()).id)
  await addItems(dataset.id, Array.from({ length: 11 }, (_, index) => ({ input: `Original ${index}`, meta: { source: 'generated' } })))
  const original = await getAllItems(dataset.id)
  const target = show(dataset)
  await vi.waitFor(() => expect(target.querySelectorAll('tbody tr')).toHaveLength(10))
  target.querySelectorAll<HTMLButtonElement>('.pager button')[1].click(); flushSync()
  await vi.waitFor(() => expect(target.querySelectorAll('tbody tr')).toHaveLength(1))
  const stale = target.querySelector<HTMLTextAreaElement>('tbody textarea')!
  if (action === 'delete') await deleteItem(original[10].id)
  else if (action === 'clear') await clearDataset(dataset.id)
  else await replaceGeneratedItems(dataset.id, [{ input: 'Replacement one' }, { input: 'Replacement two' }])
  const error = vi.spyOn(t, 'error')
  input(stale, 'Attempted stale edit')
  await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining('not saved')))
  await vi.waitFor(() => {
    flushSync()
    expect([...target.querySelectorAll<HTMLTextAreaElement>('tbody textarea')].map((element) => element.value)).not.toContain('Attempted stale edit')
    expect(target.querySelectorAll('tbody tr')).toHaveLength(action === 'delete' ? 10 : action === 'clear' ? 0 : 2)
  })
  expect(target.querySelector('.count')?.textContent).toContain(String(action === 'delete' ? 10 : action === 'clear' ? 0 : 2))
  expect(target.querySelector('.busy-dot')).toBeNull()
  expect(await (await db()).get('datasets_items', original[10].id)).toBeUndefined()
  expect((await getAllItems(dataset.id)).some((item) => item.input === 'Attempted stale edit')).toBe(false)
})

it('the refresh from a missing row preserves a different row edit still waiting to commit', async () => {
  const dataset = await createDataset((await createTask()).id)
  await addItems(dataset.id, [{ input: 'One' }, { input: 'Two' }])
  const original = await getAllItems(dataset.id)
  const database = await db()
  const target = show(dataset)
  await vi.waitFor(() => expect(target.querySelectorAll('tbody tr')).toHaveLength(2))
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let waiting = false
  vi.spyOn(databaseModule, 'db').mockImplementationOnce(async () => { waiting = true; await gate; return database })
  input(target.querySelectorAll<HTMLTextAreaElement>('tbody tr textarea')[2], 'Other row pending')
  await vi.waitFor(() => expect(waiting).toBe(true))
  await deleteItem(original[0].id)
  const error = vi.spyOn(t, 'error')
  input(target.querySelector<HTMLTextAreaElement>('tbody textarea')!, 'Missing row edit')
  await vi.waitFor(() => expect(error).toHaveBeenCalled())
  await vi.waitFor(() => { flushSync(); expect(target.querySelectorAll('tbody tr')).toHaveLength(1) })
  expect(target.querySelector<HTMLTextAreaElement>('tbody textarea')?.value).toBe('Other row pending')
  expect((await database.get('datasets_items', original[1].id))?.input).toBe(original[1].input)
  release()
  await vi.waitFor(async () => expect((await database.get('datasets_items', original[1].id))?.input).toBe('Other row pending'))
  await vi.waitFor(() => { flushSync(); expect(target.querySelector('.busy-dot')).toBeNull() })
})

it('updateItem rejects a vanished row and a row belonging to a different dataset', async () => {
  const dataset = await createDataset((await createTask()).id)
  const [item] = await addItems(dataset.id, [{ input: 'Original' }])
  await expect(updateItem({ ...item, datasetId: 'different', input: 'Wrong dataset' })).rejects.toMatchObject({ name: 'DatasetItemNotFoundError', itemId: item.id, datasetId: 'different' })
  expect((await (await db()).get('datasets_items', item.id))?.input).toBe('Original')
  await deleteItem(item.id)
  await expect(updateItem({ ...item, input: 'Late' })).rejects.toMatchObject({ name: 'DatasetItemNotFoundError', itemId: item.id, datasetId: dataset.id })
  expect(await (await db()).get('datasets_items', item.id)).toBeUndefined()
})

it('reports one missing-row failure for the latest of several queued edits and never resurrects it', async () => {
  const dataset = await createDataset((await createTask()).id)
  const [item] = await addItems(dataset.id, [{ input: 'Original' }])
  const database = await db()
  const target = show(dataset)
  await vi.waitFor(() => expect(target.querySelectorAll('tbody tr')).toHaveLength(1))
  await deleteItem(item.id)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let waiting = false
  vi.spyOn(databaseModule, 'db').mockImplementationOnce(async () => { waiting = true; await gate; return database })
  const error = vi.spyOn(t, 'error')
  const changed = target.querySelectorAll<HTMLTextAreaElement>('tbody textarea')
  input(changed[0], 'First queued draft')
  await vi.waitFor(() => expect(waiting).toBe(true))
  input(changed[0], 'Latest queued draft')
  input(changed[1], 'Latest expected output')
  release()
  await vi.waitFor(() => { flushSync(); expect(target.querySelectorAll('tbody tr')).toHaveLength(0) })
  expect(error).toHaveBeenCalledTimes(1)
  expect(error).toHaveBeenCalledWith('This example was removed or replaced. Your edit was not saved.')
  expect(await database.get('datasets_items', item.id)).toBeUndefined()
  expect(target.querySelector('.count')?.textContent).toContain('0')
})


it.each(['before page read', 'during page read'] as const)('preserves a different row edited %s and committed before a delayed refresh returns', async (timing) => {
  const dataset = await createDataset((await createTask()).id)
  const [removed, kept] = await addItems(dataset.id, [{ input: 'Remove original' }, { input: 'Keep original' }])
  const target = show(dataset)
  await vi.waitFor(() => expect(target.querySelectorAll('tbody tr')).toHaveLength(2))
  const keptInput = [...target.querySelectorAll<HTMLTextAreaElement>('tbody textarea')].find((element) => element.value === 'Keep original')!
  const removedInput = [...target.querySelectorAll<HTMLTextAreaElement>('tbody textarea')].find((element) => element.value === 'Remove original')!
  const database = await db()
  let releaseSave!: () => void
  let releaseRead!: () => void
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve })
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve })
  const realUpdate = datasets.updateItem
  const realGet = datasets.getItems
  vi.spyOn(datasets, 'updateItem').mockImplementation(async (item) => {
    if (item.id === kept.id) await saveGate
    return realUpdate(item)
  })
  let readEntered = false
  try {
    if (timing === 'before page read') input(keptInput, 'Keep newly committed')
    await deleteItem(removed.id)
    vi.spyOn(datasets, 'getItems').mockImplementationOnce(async (...args) => {
      const rows = await realGet(...args)
      readEntered = true
      await readGate
      return rows
    })
    input(removedInput, 'Removed edit')
    await vi.waitFor(() => expect(readEntered).toBe(true))
    if (timing === 'during page read') input(keptInput, 'Keep newly committed')
    releaseSave()
    await vi.waitFor(async () => expect((await database.get('datasets_items', kept.id))?.input).toBe('Keep newly committed'))
    await vi.waitFor(() => { flushSync(); expect(keptInput.classList.contains('busy')).toBe(false) })
    releaseRead()
    await vi.waitFor(() => { flushSync(); expect(target.querySelectorAll('tbody tr')).toHaveLength(1) })
    expect(target.querySelector<HTMLTextAreaElement>('tbody textarea')?.value).toBe('Keep newly committed')
    input(target.querySelectorAll<HTMLTextAreaElement>('tbody textarea')[1], 'New expected output')
    await vi.waitFor(async () => expect(await database.get('datasets_items', kept.id)).toMatchObject({ input: 'Keep newly committed', expectedOutput: 'New expected output' }))
  } finally { releaseSave(); releaseRead() }
})
