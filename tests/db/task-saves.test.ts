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
    await saveTask({...task,initialPrompt:'new'})
    expect(await getTask(task.id)).toBeUndefined()
  })
  it('concurrent patches preserve independent run fields', async () => {
    const run = await createRun('task',{} as RunConfig)
    await Promise.all([patchRun(run.id,{status:'paused'}),patchRun(run.id,{totalTokensIn:42})])
    expect(await getRun(run.id)).toMatchObject({status:'paused',totalTokensIn:42})
  })
  it('a late patch cannot recreate a deleted run', async () => {
    const run = await createRun('task',{} as RunConfig)
    await (await db()).delete('runs',run.id)
    await patchRun(run.id,{totalTokensIn:42})
    expect(await getRun(run.id)).toBeUndefined()
  })
})

it('a queued item update cannot resurrect a removed row', async () => {
  const { createDataset, addItems, deleteItem, updateItem, countItems, getDataset } = await import('../../src/lib/db/datasets')
  const dataset = await createDataset('task')
  const [item] = await addItems(dataset.id,[{input:'old'}])
  await deleteItem(item.id)
  await updateItem({...item,input:'late write'})
  expect(await countItems(dataset.id)).toBe(0)
  expect((await getDataset(dataset.id))?.itemCount).toBe(0)
})
