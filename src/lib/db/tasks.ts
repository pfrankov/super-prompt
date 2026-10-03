import { db } from './db'
import type { Task } from '../types'
import { newId } from '../util/id'
import { storeAppliedRevision } from '../improve/applied-revision'
import { readPromptDraft, clearPromptDraft } from './prompt-drafts'

export class TaskNotFoundError extends Error {
  constructor(readonly taskId: string) {
    super('This prompt no longer exists. Return to your prompts and open an existing one.')
    this.name = 'TaskNotFoundError'
  }
}

export async function listTasks(): Promise<Task[]> {
  const d = await db()
  const all = await d.getAll('tasks')
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getTask(id: string): Promise<Task | undefined> {
  const d = await db()
  const task = await d.get('tasks', id)
  const draft = readPromptDraft(id)
  return task && draft !== null ? { ...task, initialPrompt: draft } : task
}

export type TaskPatch = Partial<Omit<Task, 'id' | 'createdAt' | 'updatedAt'>>
type TaskUpdate = TaskPatch | ((current: Task) => TaskPatch)
const pendingWrites = new Map<string, Promise<Task>>()

/** Serialize writes across mounted editors; merge only the fields they own. */
export function patchTask(id: string, update: TaskUpdate): Promise<Task> {
  const previous = pendingWrites.get(id) ?? Promise.resolve()
  const write: Promise<Task> = previous.catch(() => {}).then(async () => {
    const d = await db()
    const tx = d.transaction('tasks', 'readwrite')
    const current = await tx.store.get(id)
    if (!current) {
      await tx.done
      throw new TaskNotFoundError(id)
    }
    const patch = typeof update === 'function' ? update(current) : update
    const next = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: Date.now() }
    await tx.store.put(next)
    await tx.done
    // An older matching write must not erase a reverted draft while a newer
    // write is still queued. The final commit can clear only its durable text.
    if (pendingWrites.get(id) === write) clearPromptDraft(id, next.initialPrompt)
    return next
  })
  pendingWrites.set(id, write)
  const cleanup = () => { if (pendingWrites.get(id) === write) pendingWrites.delete(id) }
  void write.then(cleanup, cleanup)
  return write
}

/** Explicit full-task replacement; editor autosaves should use patchTask. */
export async function saveTask(t: Task): Promise<void> {
  const { id, createdAt: _createdAt, updatedAt: _updatedAt, ...fields } = t
  await patchTask(id, fields)
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
  const d = await db()
  await d.put('tasks', t)
  return t
}

export async function deleteTask(id: string): Promise<void> {
  const d = await db()
  const tx = d.transaction(
    ['tasks', 'datasets', 'datasets_items', 'runs', 'candidates', 'iterations', 'pairs'],
    'readwrite'
  )
  const finished = tx.done
  void finished.catch(() => {})
  try {
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
    await finished
  } catch (error) {
    try { tx.abort() } catch { /* Already settled. */ }
    await finished.catch(() => {})
    throw error
  }
  clearPromptDraft(id)
  storeAppliedRevision(id, null)
}
