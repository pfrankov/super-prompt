import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as databaseModule from '../../src/lib/db/db'
import { db, wipeAll } from '../../src/lib/db/db'
import { createTask, deleteTask } from '../../src/lib/db/tasks'
import { createDataset, addItems } from '../../src/lib/db/datasets'
import { stagePromptDraft, readPromptDraft } from '../../src/lib/db/prompt-drafts'
import { storeAppliedRevision, readAppliedRevision } from '../../src/lib/improve/applied-revision'

beforeEach(async () => { await wipeAll(); sessionStorage.clear() })
afterEach(() => vi.restoreAllMocks())

it('preserves the latest draft and undo when a real deletion transaction aborts at its final cursor', async () => {
  const task = await createTask({ initialPrompt: 'Durable' })
  const dataset = await createDataset(task.id)
  await addItems(dataset.id, [{ input: 'Keep me' }])
  stagePromptDraft(task.id, 'Latest draft')
  storeAppliedRevision(task.id, { before: 'Earlier', after: 'Latest draft' })
  const openCursor = IDBIndex.prototype.openCursor
  let aborted = false
  vi.spyOn(IDBIndex.prototype, 'openCursor').mockImplementation(function (...args) {
    const request = openCursor.apply(this, args)
    if (this.objectStore.name === 'runs') request.addEventListener('success', () => {
      if (!request.result) { aborted = true; this.objectStore.transaction.abort() }
    })
    return request
  })
  await expect(deleteTask(task.id)).rejects.toMatchObject({ name: 'AbortError' })
  expect(aborted).toBe(true)
  const database = await db()
  expect(await database.get('tasks', task.id)).toBeDefined()
  expect(await database.get('datasets', dataset.id)).toBeDefined()
  expect(await database.count('datasets_items')).toBe(1)
  expect(readPromptDraft(task.id)).toBe('Latest draft')
  expect(readAppliedRevision(task.id, 'Latest draft')).toEqual({ before: 'Earlier', after: 'Latest draft' })
})

it('clears only the deleted task recovery copies after successful commit', async () => {
  const task = await createTask()
  stagePromptDraft(task.id, 'Delete')
  stagePromptDraft('other', 'Keep')
  storeAppliedRevision(task.id, { before: 'old', after: 'Delete' })
  storeAppliedRevision('other', { before: 'old', after: 'Keep' })
  await deleteTask(task.id)
  expect(readPromptDraft(task.id)).toBeNull()
  expect(readAppliedRevision(task.id, 'Delete')).toBeNull()
  expect(readPromptDraft('other')).toBe('Keep')
  expect(readAppliedRevision('other', 'Keep')).toEqual({ before: 'old', after: 'Keep' })
})

it('a failed wipe rolls back every store and retains all recovery copies', async () => {
  const task = await createTask({ initialPrompt: 'Durable' })
  const dataset = await createDataset(task.id)
  await addItems(dataset.id, [{ input: 'Keep me' }])
  stagePromptDraft(task.id, 'Latest draft')
  storeAppliedRevision(task.id, { before: 'Earlier', after: 'Latest draft' })
  const clear = IDBObjectStore.prototype.clear
  vi.spyOn(IDBObjectStore.prototype, 'clear').mockImplementation(function () {
    const request = clear.call(this)
    if (this.name === 'datasets') request.addEventListener('success', () => this.transaction.abort())
    return request
  })
  await expect(wipeAll()).rejects.toMatchObject({ name: 'AbortError' })
  const database = await db()
  expect(await database.get('tasks', task.id)).toBeDefined()
  expect(await database.get('datasets', dataset.id)).toBeDefined()
  expect(await database.count('datasets_items')).toBe(1)
  expect(readPromptDraft(task.id)).toBe('Latest draft')
  expect(readAppliedRevision(task.id, 'Latest draft')).toEqual({ before: 'Earlier', after: 'Latest draft' })
})


it.each(['database opening', 'first delete request'] as const)('retains recovery if deletion fails at %s and observes the transaction rejection', async (phase) => {
  const task = await createTask({ initialPrompt: 'Durable' })
  stagePromptDraft(task.id, 'Latest draft')
  storeAppliedRevision(task.id, { before: 'Earlier', after: 'Latest draft' })
  const database = await db()
  if (phase === 'database opening') vi.spyOn(databaseModule, 'db').mockRejectedValueOnce(new DOMException('Cannot open', 'AbortError'))
  else {
    const remove = IDBObjectStore.prototype.delete
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (...args) {
      const request = remove.apply(this, args)
      if (this.name === 'tasks') request.addEventListener('success', () => this.transaction.abort())
      return request
    })
  }
  await expect(deleteTask(task.id)).rejects.toBeInstanceOf(DOMException)
  expect(await database.get('tasks', task.id)).toBeDefined()
  expect(readPromptDraft(task.id)).toBe('Latest draft')
  expect(readAppliedRevision(task.id, 'Latest draft')).toEqual({ before: 'Earlier', after: 'Latest draft' })
})
