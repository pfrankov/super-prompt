// @vitest-environment node
import 'fake-indexeddb/auto'
import { IDBCursor, IDBIndex } from 'fake-indexeddb'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { db, wipeAll } from '../../src/lib/db/db'
import { getItems } from '../../src/lib/db/datasets'
import { getTopCandidates, listRunsPage } from '../../src/lib/db/runs'
import type { DatasetItem, PromptCandidate, Run, RunConfig } from '../../src/lib/types'

const config: RunConfig = {
  iterationsCap: 100, tokenBudget: 0, concurrency: 4, sampleSizePerIter: 8,
  earlyStopPlateau: 0, judgeTemperature: 0, targetTemperature: 0, mutatorTemperature: 0,
}
const itemId = (i: number) => `item-${String(i).padStart(5, '0')}`
const runId = (i: number) => `run-${String(i).padStart(5, '0')}`
const candidateId = (i: number) => `candidate-${String(i).padStart(5, '0')}`
const candidateCount = 1024

// idb caches these method identities on first access. Install the transparent
// spies before opening the database, then clear counters instead of replacing
// methods between tests (which would break idb's promise-wrapping detection).
const getAll = vi.spyOn(IDBIndex.prototype, 'getAll')
const openCursor = vi.spyOn(IDBIndex.prototype, 'openCursor')
const advance = vi.spyOn(IDBCursor.prototype, 'advance')
const next = vi.spyOn(IDBCursor.prototype, 'continue')

beforeAll(async () => {
  await wipeAll()
  const d = await db()
  const tx = d.transaction(['datasets_items', 'runs', 'candidates'], 'readwrite')
  const writes: Promise<unknown>[] = []
  for (let i = 0; i < 10_000; i++) {
    const item: DatasetItem = {
      id: itemId(i), datasetId: 'dataset-large', input: `Example ${i} ${'x'.repeat(768)}`,
      expectedOutput: 'y'.repeat(256), meta: { source: 'import', difficulty: String(i % 4) },
    }
    writes.push(tx.objectStore('datasets_items').put(item))
  }
  for (let i = 0; i < 13; i++) {
    writes.push(tx.objectStore('datasets_items').put({ id: `short-${i.toString().padStart(2, '0')}`, datasetId: 'dataset-short', input: `Short ${i}` }))
  }
  writes.push(tx.objectStore('datasets_items').put({
    id: 'other-item', datasetId: 'dataset-other', input: 'Not in this dataset',
  }))
  for (let i = 0; i < 1000; i++) {
    const run: Run = {
      id: runId(i), taskId: 'task-large', config, status: 'completed', bestCandidateId: null,
      totalTokensIn: 1000, totalTokensOut: 200, iterationCount: 100,
      startedAt: 1_700_000_000_000 + i, finishedAt: 1_700_000_100_000 + i, errorMessage: null,
    }
    writes.push(tx.objectStore('runs').put(run))
  }
  for (let i = 0; i < candidateCount; i++) {
    const candidate: PromptCandidate = {
      id: candidateId(i), runId: runId(999), parentId: null,
      text: `Synthetic prompt ${i} ${'p'.repeat(2048)}`, source: 'mutated', score: (i % 101) / 10,
      wins: 1, losses: 0, ties: 0, iterations: 1, tokensIn: 10, tokensOut: 20, createdAt: i,
    }
    writes.push(tx.objectStore('candidates').put(candidate))
  }
  const baseCandidate: PromptCandidate = {
    id: 'unscored', runId: runId(999), parentId: null, text: 'Unscored', source: 'seed', score: null,
    wins: 0, losses: 0, ties: 0, iterations: 0, tokensIn: 0, tokensOut: 0, createdAt: 20_000,
  }
  writes.push(tx.objectStore('candidates').put(baseCandidate))
  writes.push(tx.objectStore('candidates').put({ ...baseCandidate, id: 'other-candidate', runId: 'other-run', score: 10 }))
  await Promise.all(writes)
  await tx.done
  vi.clearAllMocks()
}, 30_000)

afterEach(() => { vi.clearAllMocks() })
afterAll(async () => { (await db()).close(); vi.restoreAllMocks() })

describe('dataset pagination against IndexedDB', () => {
  it('loads only one ten-row page from 10,000 long records without getAll', async () => {
    const page = await getItems('dataset-large', { limit: 10 })
    expect(page.map((item) => item.id)).toEqual(Array.from({ length: 10 }, (_, i) => itemId(i)))
    expect(getAll).not.toHaveBeenCalled()
    expect(openCursor).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledTimes(9)
  })

  it('skips preceding index entries once instead of visiting each skipped value', async () => {
    const page = await getItems('dataset-large', { offset: 200, limit: 10 })
    expect(page.map((item) => item.id)).toEqual(Array.from({ length: 10 }, (_, i) => itemId(200 + i)))
    expect(getAll).not.toHaveBeenCalled()
    expect(advance).toHaveBeenCalledExactlyOnceWith(200)
    expect(next).toHaveBeenCalledTimes(9)
  })

  it('returns partial last pages, empty missing pages, and stays inside its dataset', async () => {
    expect((await getItems('dataset-short', { offset: 10, limit: 10 })).map((item) => item.id))
      .toEqual(['short-10', 'short-11', 'short-12'])
    expect(await getItems('dataset-short', { offset: 13, limit: 10 })).toEqual([])
    expect(await getItems('missing')).toEqual([])
    expect((await getItems('dataset-other')).map((item) => item.id)).toEqual(['other-item'])
  })

  it('keeps the default page size and normalizes invalid page controls', async () => {
    expect(await getItems('dataset-large')).toHaveLength(50)
    expect((await getItems('dataset-large', { offset: 2.9, limit: 3.9 })).map((item) => item.id))
      .toEqual([itemId(2), itemId(3), itemId(4)])
    expect((await getItems('dataset-large', { offset: -2, limit: 1 }))[0].id).toBe(itemId(0))
    openCursor.mockClear()
    expect(await getItems('dataset-large', { limit: 0 })).toEqual([])
    expect(await getItems('dataset-large', { limit: -5 })).toEqual([])
    expect(openCursor).not.toHaveBeenCalled()
  })
})

describe('bounded history payloads against IndexedDB', () => {
  it('returns 20 newest run summaries and the total without loading any candidates', async () => {
    const page = await listRunsPage('task-large')
    expect(page.total).toBe(1000)
    expect(page.runs.map((run) => run.id)).toEqual(Array.from({ length: 20 }, (_, i) => runId(999 - i)))
    expect(getAll).toHaveBeenCalledTimes(1)
    expect(getAll.mock.instances[0].objectStore.name).toBe('runs')
    expect(openCursor).not.toHaveBeenCalled()
  })

  it('preserves newest-first order across pages and handles the end', async () => {
    const page = await listRunsPage('task-large', { offset: 20, limit: 20 })
    expect(page.runs.map((run) => run.id)).toEqual(Array.from({ length: 20 }, (_, i) => runId(979 - i)))
    expect((await listRunsPage('task-large', { offset: 995 })).runs).toHaveLength(5)
    expect(await listRunsPage('task-large', { offset: 1000 })).toEqual({ runs: [], total: 1000 })
    expect(await listRunsPage('missing')).toEqual({ runs: [], total: 0 })
  })

  it('fetches the top eight scored candidates directly from the score index', async () => {
    const candidates = await getTopCandidates(runId(999))
    const expected = Array.from({ length: candidateCount }, (_, i) => ({ id: candidateId(i), score: (i % 101) / 10 }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? 1 : -1)).slice(0, 8)
    expect(candidates.map(({ id, score }) => ({ id, score }))).toEqual(expected)
    expect(candidates.every((candidate) => candidate.runId === runId(999) && candidate.score !== null)).toBe(true)
    expect(getAll).not.toHaveBeenCalled()
    expect(openCursor).toHaveBeenCalledTimes(1)
    expect(openCursor.mock.instances[0].name).toBe('by-runId-score')
    expect(next).toHaveBeenCalledTimes(7)
  })

  it('handles empty/unscored histories and does no read for a zero-sized page', async () => {
    expect(await getTopCandidates(runId(0))).toEqual([])
    expect(await getTopCandidates('missing')).toEqual([])
    openCursor.mockClear()
    expect(await getTopCandidates(runId(999), { limit: 0 })).toEqual([])
    expect(openCursor).not.toHaveBeenCalled()
  })
})
