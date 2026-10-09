import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { db, wipeAll } from '../../src/lib/db/db'
import { createTask, deleteTask, patchTask, replaceTaskPrompt } from '../../src/lib/db/tasks'
import { readPromptDraft, stagePromptDraft } from '../../src/lib/db/prompt-drafts'

beforeEach(async () => { await wipeAll(); sessionStorage.clear() })
afterEach(() => vi.restoreAllMocks())

it('replaces exact prompt text while preserving newer metadata', async () => {
  const before = '  original\r\n\n🧭'
  const after = 'revised\n\r'
  const task = await createTask({ initialPrompt: before, name: 'Old name' })
  await patchTask(task.id, { name: 'New name', rubric: { text: 'Updated rubric' } })
  const saved = await replaceTaskPrompt(task.id, before, after)
  expect(saved).toMatchObject({ initialPrompt: after, name: 'New name', rubric: { text: 'Updated rubric' } })
  expect(await (await db()).get('tasks', task.id)).toEqual(saved)
  await replaceTaskPrompt(task.id, after, before)
  expect((await (await db()).get('tasks', task.id))?.initialPrompt).toBe(before)
})

it('compares durable text rather than the tab journal and leaves a conflicting draft intact', async () => {
  const task = await createTask({ initialPrompt: 'Newer saved text' })
  stagePromptDraft(task.id, 'Stale expected text')
  await expect(replaceTaskPrompt(task.id, 'Stale expected text', 'Replacement')).rejects.toMatchObject({
    name: 'TaskPromptConflictError', current: { initialPrompt: 'Newer saved text' },
  })
  expect(await (await db()).get('tasks', task.id)).toEqual(task)
  expect(readPromptDraft(task.id)).toBe('Stale expected text')
  // A rejected conditional write must release the queue for a deliberate retry.
  await replaceTaskPrompt(task.id, 'Newer saved text', 'Accepted replacement')
  expect((await (await db()).get('tasks', task.id))?.initialPrompt).toBe('Accepted replacement')
})

it('allows only one simultaneous replacement from independent app instances', async () => {
  const task = await createTask({ initialPrompt: 'Original' })
  // A fresh module graph owns a separate queue and IndexedDB connection, like
  // a second tab. The transaction, not the in-memory queue, must arbitrate.
  vi.resetModules()
  const otherTasks = await import('../../src/lib/db/tasks')
  const otherDatabase = await import('../../src/lib/db/db')
  try {
    const outcomes = await Promise.allSettled([
      replaceTaskPrompt(task.id, 'Original', 'First revision'),
      otherTasks.replaceTaskPrompt(task.id, 'Original', 'Second revision'),
    ])
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ name: 'TaskPromptConflictError' })
    const accepted = outcomes.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof replaceTaskPrompt>>>
    expect(await (await db()).get('tasks', task.id)).toEqual(accepted.value)
  } finally { (await otherDatabase.db()).close() }
})

it('does not report success or clear a draft when the write transaction aborts after put succeeds', async () => {
  const task = await createTask({ initialPrompt: 'Original' })
  stagePromptDraft(task.id, 'Replacement')
  const put = IDBObjectStore.prototype.put
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (...args) {
    const request = put.apply(this, args)
    if (this.name === 'tasks') request.addEventListener('success', () => this.transaction.abort())
    return request
  })
  await expect(replaceTaskPrompt(task.id, 'Original', 'Replacement')).rejects.toMatchObject({ name: 'AbortError' })
  expect(await (await db()).get('tasks', task.id)).toEqual(task)
  expect(readPromptDraft(task.id)).toBe('Replacement')
  spy.mockRestore()
  await replaceTaskPrompt(task.id, 'Original', 'Replacement')
  expect((await (await db()).get('tasks', task.id))?.initialPrompt).toBe('Replacement')
  expect(readPromptDraft(task.id)).toBeNull()
})

it('rejects a deleted task instead of recreating it', async () => {
  const task = await createTask({ initialPrompt: 'Original' })
  await deleteTask(task.id)
  await expect(replaceTaskPrompt(task.id, 'Original', 'Replacement')).rejects.toMatchObject({ name: 'TaskNotFoundError' })
  expect(await (await db()).get('tasks', task.id)).toBeUndefined()
})
