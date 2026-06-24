import { db } from './db'
import type {
  Run,
  PromptCandidate,
  IterationRecord,
  PairwiseResult,
  RunConfig,
} from '../types'
import { newId } from '../util/id'

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
  await d.put('runs', run)
  return run
}

export async function getRun(id: string): Promise<Run | undefined> {
  const d = await db()
  return d.get('runs', id)
}

export async function patchRun(id: string, patch: Partial<Run>): Promise<void> {
  const d = await db()
  const r = await d.get('runs', id)
  if (!r) return
  await d.put('runs', { ...r, ...patch })
}

export async function listRuns(taskId: string): Promise<Run[]> {
  const d = await db()
  const all = await d.getAllFromIndex('runs', 'by-taskId', taskId)
  return all.sort((a, b) => b.startedAt - a.startedAt)
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
