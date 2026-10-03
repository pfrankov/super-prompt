import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { db, wipeAll } from '../../src/lib/db/db'
import * as databaseModule from '../../src/lib/db/db'
import { createTask, deleteTask, patchTask } from '../../src/lib/db/tasks'
import { addItems, createDataset, ensureTaskDataset, getAllItems } from '../../src/lib/db/datasets'

beforeEach(async () => { await wipeAll(); sessionStorage.clear() })
afterEach(() => vi.restoreAllMocks())

it('atomically links a new dataset and reuses it across concurrent and repeated attempts', async () => {
  const task = await createTask({ initialPrompt: 'Prompt' })
  const [first, second] = await Promise.all([ensureTaskDataset(task.id), ensureTaskDataset(task.id)])
  const third = await ensureTaskDataset(task.id)
  expect(second.id).toBe(first.id)
  expect(third.id).toBe(first.id)
  const database = await db()
  expect((await database.get('tasks', task.id))?.datasetId).toBe(first.id)
  expect(await database.countFromIndex('datasets', 'by-taskId', task.id)).toBe(1)
})

it.each(['before opening', 'while opening'] as const)('does not create or assign a dataset when cancelled %s', async (phase) => {
  const task = await createTask()
  const database = await db()
  const controller = new AbortController()
  if (phase === 'before opening') controller.abort()
  else vi.spyOn(databaseModule, 'db').mockImplementationOnce(async () => { controller.abort(); return database })
  await expect(ensureTaskDataset(task.id, 'Generated', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect((await database.get('tasks', task.id))?.datasetId).toBeNull()
  expect(await database.countFromIndex('datasets', 'by-taskId', task.id)).toBe(0)
})

it.each(['dataset inserted', 'task assigned'] as const)('rolls back both records when cancelled after %s but before commit', async (phase) => {
  const task = await createTask()
  const controller = new AbortController()
  const method = phase === 'dataset inserted' ? 'add' : 'put'
  const native = IDBObjectStore.prototype[method]
  let aborted = false
  vi.spyOn(IDBObjectStore.prototype, method).mockImplementation(function (...args) {
    const request = native.apply(this, args)
    if (this.name === (phase === 'dataset inserted' ? 'datasets' : 'tasks')) request.addEventListener('success', () => {
      aborted = true
      controller.abort()
    })
    return request
  })
  await expect(ensureTaskDataset(task.id, 'Generated', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(aborted).toBe(true)
  const database = await db()
  expect((await database.get('tasks', task.id))?.datasetId).toBeNull()
  expect(await database.countFromIndex('datasets', 'by-taskId', task.id)).toBe(0)
})

it('keeps a discoverable dataset when cancellation arrives at the committed transaction boundary', async () => {
  const task = await createTask()
  const controller = new AbortController()
  const transaction = IDBDatabase.prototype.transaction
  const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (...args) {
    const tx = transaction.apply(this, args)
    tx.addEventListener('complete', () => controller.abort(), { once: true })
    return tx
  })
  const dataset = await ensureTaskDataset(task.id, 'Generated', controller.signal)
  spy.mockRestore()
  expect(controller.signal.aborted).toBe(true)
  const database = await db()
  expect((await database.get('tasks', task.id))?.datasetId).toBe(dataset.id)
  const manual = await addItems(dataset.id, [{ input: 'Added after commit' }])
  expect((await ensureTaskDataset(task.id)).id).toBe(dataset.id)
  expect(await getAllItems(dataset.id)).toEqual(manual)
  expect(await database.countFromIndex('datasets', 'by-taskId', task.id)).toBe(1)
})

it('uses a manual dataset assigned while the caller was waiting, without overwriting metadata or other datasets', async () => {
  const task = await createTask({ initialPrompt: 'Original' })
  const unrelated = await createDataset(task.id, 'Unrelated')
  const unrelatedRows = await addItems(unrelated.id, [{ input: 'Other manual data' }])
  const manual = await createDataset(task.id, 'Manual')
  const manualRows = await addItems(manual.id, [{ input: 'Preserve me' }])
  const database = await db()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  vi.spyOn(databaseModule, 'db').mockImplementationOnce(async () => { await gate; return database })
  const pending = ensureTaskDataset(task.id, 'Generated')
  await patchTask(task.id, { name: 'Later rename', initialPrompt: 'Later prompt', datasetId: manual.id })
  release()
  expect((await pending).id).toBe(manual.id)
  expect(await database.get('tasks', task.id)).toMatchObject({ datasetId: manual.id, name: 'Later rename', initialPrompt: 'Later prompt' })
  expect(await getAllItems(manual.id)).toEqual(manualRows)
  expect(await getAllItems(unrelated.id)).toEqual(unrelatedRows)
  expect(await database.countFromIndex('datasets', 'by-taskId', task.id)).toBe(2)
})

it('does not create a dataset for a deleted task', async () => {
  const task = await createTask()
  await deleteTask(task.id)
  await expect(ensureTaskDataset(task.id)).rejects.toThrow('This prompt no longer exists')
  expect(await (await db()).countFromIndex('datasets', 'by-taskId', task.id)).toBe(0)
})
