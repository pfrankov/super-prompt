import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as databaseModule from '../../src/lib/db/db'
import { db, wipeAll } from '../../src/lib/db/db'
import { createTask, deleteTask } from '../../src/lib/db/tasks'
import { createDataset, addItems } from '../../src/lib/db/datasets'
import { addCandidate, addIteration, createRun } from '../../src/lib/db/runs'
import { stagePromptDraft, readPromptDraft } from '../../src/lib/db/prompt-drafts'
import { storeAppliedRevision, readAppliedRevision } from '../../src/lib/improve/applied-revision'
import type { IterationRecord, PairwiseResult, PromptCandidate, RunConfig } from '../../src/lib/types'

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

it.each(['delete first', 'write first'] as const)('serializes run results against task deletion: %s', async (order) => {
  const task = await createTask()
  const run = await createRun(task.id, {} as RunConfig)
  const candidate: PromptCandidate = {
    id: 'candidate', runId: run.id, parentId: null, text: 'Prompt', source: 'seed', score: null,
    wins: 0, losses: 0, ties: 0, iterations: 0, tokensIn: 0, tokensOut: 0, createdAt: 1,
  }
  const iteration: IterationRecord = {
    id: 'iteration', runId: run.id, index: 0, parentCandidateId: candidate.id,
    childCandidateId: candidate.id, sampleItemIds: [], aggregatedFeedback: '',
    tokensIn: 0, tokensOut: 0, startedAt: 1, finishedAt: 2,
  }
  const pair: PairwiseResult = {
    id: 'pair', iterationId: iteration.id, itemId: 'item', outputA: '', outputB: '',
    verdict: { winner: 'tie', scoreA: 0, scoreB: 0, reasoning: '', feedbackA: '', feedbackB: '' },
    abSwapped: false, tokensIn: 0, tokensOut: 0, latencyMs: 0,
  }
  const writes = [() => addCandidate(candidate), () => addIteration(iteration, [pair])]
  const operations = order === 'delete first'
    ? [deleteTask(task.id), ...writes.map((write) => write())]
    : [...writes.map((write) => write()), deleteTask(task.id)]

  const outcomes = await Promise.allSettled(operations)

  expect(outcomes.map((outcome) => outcome.status)).toEqual(order === 'delete first'
    ? ['fulfilled', 'rejected', 'rejected']
    : ['fulfilled', 'fulfilled', 'fulfilled'])
  const database = await db()
  expect(await database.get('tasks', task.id)).toBeUndefined()
  expect(await database.get('runs', run.id)).toBeUndefined()
  expect(await database.count('candidates')).toBe(0)
  expect(await database.count('iterations')).toBe(0)
  expect(await database.count('pairs')).toBe(0)
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
