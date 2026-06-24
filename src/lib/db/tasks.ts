import { db } from './db'
import type { Task } from '../types'
import { newId } from '../util/id'

export async function listTasks(): Promise<Task[]> {
  const d = await db()
  const all = await d.getAll('tasks')
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getTask(id: string): Promise<Task | undefined> {
  const d = await db()
  return d.get('tasks', id)
}

export async function saveTask(t: Task): Promise<void> {
  const d = await db()
  const next = { ...t, updatedAt: Date.now() }
  await d.put('tasks', next)
}

export async function createTask(partial: Partial<Task> = {}): Promise<Task> {
  const now = Date.now()
  const t: Task = {
    id: newId(),
    name: partial.name ?? '',
    description: partial.description ?? '',
    initialPrompt: partial.initialPrompt ?? '',
    seedPrompts: partial.seedPrompts ?? [],
    rubric: partial.rubric ?? { text: '' },
    datasetId: partial.datasetId ?? null,
    providerId: partial.providerId ?? null,
    createdAt: now,
    updatedAt: now,
  }
  await saveTask(t)
  return t
}

export async function deleteTask(id: string): Promise<void> {
  const d = await db()
  const tx = d.transaction(
    ['tasks', 'datasets', 'datasets_items', 'runs', 'candidates', 'iterations', 'pairs'],
    'readwrite'
  )
  await tx.objectStore('tasks').delete(id)
  // Cascade: delete datasets for this task
  const dsIdx = tx.objectStore('datasets').index('by-taskId')
  for await (const cursor of dsIdx.iterate(id)) {
    const datasetId = cursor.value.id
    await cursor.delete()
    const itemsIdx = tx.objectStore('datasets_items').index('by-datasetId')
    for await (const ic of itemsIdx.iterate(datasetId)) await ic.delete()
  }
  // Cascade runs → candidates + iterations + pairs
  const runsIdx = tx.objectStore('runs').index('by-taskId')
  for await (const cursor of runsIdx.iterate(id)) {
    const runId = cursor.value.id
    await cursor.delete()
    const candIdx = tx.objectStore('candidates').index('by-runId')
    for await (const c of candIdx.iterate(runId)) await c.delete()
    const iterIdx = tx.objectStore('iterations').index('by-runId')
    for await (const it of iterIdx.iterate(runId)) {
      const iterId = it.value.id
      await it.delete()
      const pairsIdx = tx.objectStore('pairs').index('by-iterationId')
      for await (const p of pairsIdx.iterate(iterId)) await p.delete()
    }
  }
  await tx.done
}