import { db } from './db'
import type {
  Run,
  PromptCandidate,
  IterationRecord,
  PairwiseResult,
  RunConfig,
} from '../types'
import { newId } from '../util/id'
import { TaskNotFoundError } from './tasks'

export async function createRun(taskId: string, config: RunConfig): Promise<Run> {
  const d = await db()
  const run: Run = {
    id: newId(),
    taskId,
    config: { ...config },
    status: 'idle',
    bestCandidateId: null,
    totalTokensIn: 0,
    totalTokensOut: 0,
    iterationCount: 0,
    startedAt: Date.now(),
    finishedAt: null,
    errorMessage: null,
  }
  // Serialize existence checking and insertion against deleteTask's cascade.
  const tx = d.transaction(['tasks', 'runs'], 'readwrite')
  if (!await tx.objectStore('tasks').get(taskId)) {
    await tx.done
    throw new TaskNotFoundError(taskId)
  }
  await tx.objectStore('runs').put(run)
  await tx.done
  return run
}

export async function getRun(id: string): Promise<Run | undefined> {
  const d = await db()
  return d.get('runs', id)
}

export async function patchRun(id: string, patch: Partial<Run>): Promise<void> {
  const d = await db()
  const tx = d.transaction('runs', 'readwrite')
  const r = await tx.store.get(id)
  if (r) await tx.store.put({ ...r, ...patch })
  await tx.done
}

export async function listRuns(taskId: string): Promise<Run[]> {
  const d = await db()
  const all = await d.getAllFromIndex('runs', 'by-taskId', taskId)
  return all.sort((a, b) => b.startedAt - a.startedAt)
}

export interface RunPage {
  runs: Run[]
  total: number
}

/**
 * Page run metadata independently of the (much larger) candidate records.
 * Version 1 has no task/date index, so newest-first sorting still needs all
 * metadata for this task. Candidate bodies are never read by this query.
 */
export async function listRunsPage(
  taskId: string,
  { offset = 0, limit = 20 }: { offset?: number; limit?: number } = {}
): Promise<RunPage> {
  const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0
  const size = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 20
  const runs = await listRuns(taskId)
  return { runs: runs.slice(start, start + size), total: runs.length }
}

export async function addCandidate(c: PromptCandidate): Promise<void> {
  const d = await db()
  await d.put('candidates', c)
}

export async function getCandidate(id: string): Promise<PromptCandidate | undefined> {
  const d = await db()
  return d.get('candidates', id)
}

export async function getCandidates(runId: string): Promise<PromptCandidate[]> {
  const d = await db()
  const all = await d.getAllFromIndex('candidates', 'by-runId', runId)
  return all.sort((a, b) => a.createdAt - b.createdAt)
}

/** Only scored candidates have valid keys in the existing score index. */
export async function getTopCandidates(
  runId: string,
  { limit = 8 }: { limit?: number } = {}
): Promise<PromptCandidate[]> {
  const size = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 8
  if (size === 0) return []
  const d = await db()
  const tx = d.transaction('candidates', 'readonly')
  const range = IDBKeyRange.bound([runId, -Infinity], [runId, Infinity])
  let cursor = await tx.store.index('by-runId-score').openCursor(range, 'prev')
  const candidates: PromptCandidate[] = []
  while (cursor && candidates.length < size) {
    candidates.push(cursor.value)
    if (candidates.length < size) cursor = await cursor.continue()
  }
  await tx.done
  return candidates
}

export async function addIteration(it: IterationRecord, pairs: PairwiseResult[]): Promise<void> {
  const d = await db()
  const tx = d.transaction(['iterations', 'pairs'], 'readwrite')
  await tx.objectStore('iterations').put(it)
  for (const p of pairs) await tx.objectStore('pairs').put(p)
  await tx.done
}

export async function getIterations(runId: string): Promise<IterationRecord[]> {
  const d = await db()
  const all = await d.getAllFromIndex('iterations', 'by-runId', runId)
  return all.sort((a, b) => a.index - b.index)
}

export async function getPairs(iterationId: string): Promise<PairwiseResult[]> {
  const d = await db()
  return d.getAllFromIndex('pairs', 'by-iterationId', iterationId)
}

export async function deleteRun(runId: string): Promise<void> {
  const d = await db()
  const tx = d.transaction(['runs', 'candidates', 'iterations', 'pairs'], 'readwrite')
  await tx.objectStore('runs').delete(runId)
  const candIdx = tx.objectStore('candidates').index('by-runId')
  for await (const c of candIdx.iterate(runId)) await c.delete()
  const iterIdx = tx.objectStore('iterations').index('by-runId')
  for await (const it of iterIdx.iterate(runId)) {
    const iterId = it.value.id
    await it.delete()
    const pairsIdx = tx.objectStore('pairs').index('by-iterationId')
    for await (const p of pairsIdx.iterate(iterId)) await p.delete()
  }
  await tx.done
}
