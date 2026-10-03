import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { createTask, getTask, deleteTask, saveTask } from '../../src/lib/db/tasks'
import { stagePromptDraft } from '../../src/lib/db/prompt-drafts'
import { createRun, getRun, patchRun } from '../../src/lib/db/runs'
import { db } from '../../src/lib/db/db'
import type { RunConfig } from '../../src/lib/types'
describe('ordered persistence', () => {
  it('a teardown save cannot resurrect a deleted task', async () => {
    const task = await createTask({initialPrompt:'old'})
    stagePromptDraft(task.id,'new')
    await deleteTask(task.id)
    await expect(saveTask({...task,initialPrompt:'new'})).rejects.toThrow('This prompt no longer exists')
    expect(await getTask(task.id)).toBeUndefined()
  })
  it('concurrent patches preserve independent run fields', async () => {
    const run = await createRun((await createTask()).id,{} as RunConfig)
    await Promise.all([patchRun(run.id,{status:'paused'}),patchRun(run.id,{totalTokensIn:42})])
    expect(await getRun(run.id)).toMatchObject({status:'paused',totalTokensIn:42})
  })
  it('a late patch cannot recreate a deleted run', async () => {
    const run = await createRun((await createTask()).id,{} as RunConfig)
    await (await db()).delete('runs',run.id)
    await patchRun(run.id,{totalTokensIn:42})
    expect(await getRun(run.id)).toBeUndefined()
  })
})

it('a queued item update cannot resurrect a removed row', async () => {
  const { createDataset, addItems, deleteItem, updateItem, countItems, getDataset } = await import('../../src/lib/db/datasets')
  const dataset = await createDataset((await createTask()).id)
  const [item] = await addItems(dataset.id,[{input:'old'}])
  await deleteItem(item.id)
  await updateItem({...item,input:'late write'})
  expect(await countItems(dataset.id)).toBe(0)
  expect((await getDataset(dataset.id))?.itemCount).toBe(0)
})

it('generated replacement preserves manual rows added while generation was in flight', async () => {
  const { createDataset, addItems, replaceGeneratedItems, getAllItems } = await import('../../src/lib/db/datasets')
  const dataset = await createDataset((await createTask()).id)
  const [manual] = await addItems(dataset.id,[{input:'manual example'}])
  expect(await replaceGeneratedItems(dataset.id,[{input:'generated',meta:{source:'generated'}}])).toBe(false)
  expect(await getAllItems(dataset.id)).toEqual([manual])
})

it('cancelled generated replacement leaves existing examples untouched', async () => {
  const { createDataset, addItems, replaceGeneratedItems, getAllItems } = await import('../../src/lib/db/datasets')
  const dataset = await createDataset((await createTask()).id)
  const [old] = await addItems(dataset.id,[{input:'old',meta:{source:'generated'}}])
  const controller = new AbortController()
  controller.abort()
  await expect(replaceGeneratedItems(dataset.id,[{input:'new'}],controller.signal)).rejects.toBe(controller.signal.reason)
  expect(await getAllItems(dataset.id)).toEqual([old])
})

it('deleting a prompt removes its tab-local undo without touching other prompts', async () => {
  const { storeAppliedRevision, readAppliedRevision } = await import('../../src/lib/improve/applied-revision')
  const task = await createTask({ initialPrompt: 'new' })
  storeAppliedRevision(task.id, { before: 'old', after: 'new' })
  storeAppliedRevision('another', { before: 'a', after: 'b' })
  await deleteTask(task.id)
  expect(readAppliedRevision(task.id, 'new')).toBeNull()
  expect(readAppliedRevision('another', 'b')).toEqual({ before: 'a', after: 'b' })
})

it('wipe removes prompt recovery and undo copies while preserving unrelated session values', async () => {
  const { wipeAll } = await import('../../src/lib/db/db')
  sessionStorage.setItem('sp.prompt-draft.task', 'private prompt')
  sessionStorage.setItem('sp.applied-revision.task', 'private revision')
  sessionStorage.setItem('unrelated', 'preserve')
  await wipeAll()
  expect(sessionStorage.getItem('sp.prompt-draft.task')).toBeNull()
  expect(sessionStorage.getItem('sp.applied-revision.task')).toBeNull()
  expect(sessionStorage.getItem('unrelated')).toBe('preserve')
})


it('reports missing tasks instead of creating orphan runs or datasets', async () => {
  const { createDataset } = await import('../../src/lib/db/datasets')
  const task = await createTask({ initialPrompt: 'original' })
  await saveTask(task)
  await deleteTask(task.id)
  await expect(createRun(task.id, {} as RunConfig)).rejects.toThrow('This prompt no longer exists')
  await expect(createDataset(task.id)).rejects.toThrow('This prompt no longer exists')
  const d = await db()
  expect(await d.getAllFromIndex('runs', 'by-taskId', task.id)).toEqual([])
  expect(await d.getAllFromIndex('datasets', 'by-taskId', task.id)).toEqual([])
})

it.each(['delete first', 'create first'] as const)('serializes child creation against deletion: %s', async (order) => {
  const { createDataset } = await import('../../src/lib/db/datasets')
  const task = await createTask({ initialPrompt: 'original' })
  const operations = order === 'delete first'
    ? [deleteTask(task.id), createRun(task.id, {} as RunConfig), createDataset(task.id)]
    : [createRun(task.id, {} as RunConfig), createDataset(task.id), deleteTask(task.id)]
  const outcomes = await Promise.allSettled(operations)
  if (order === 'delete first') {
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected', 'rejected'])
  } else {
    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true)
  }
  const d = await db()
  expect(await d.get('tasks', task.id)).toBeUndefined()
  expect(await d.getAllFromIndex('runs', 'by-taskId', task.id)).toEqual([])
  expect(await d.getAllFromIndex('datasets', 'by-taskId', task.id)).toEqual([])
})
