import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get, writable } from 'svelte/store'
import type { RunConfig } from '../../src/lib/types'
import type { WorkerToMain } from '../../src/lib/optimizer/protocol'

vi.mock('../../src/stores/settings', () => ({ settings: writable({ provider: {}, arbitrator: {} }) }))

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: { data: WorkerToMain }) => void) | null = null
  onerror: ((event: { message: string }) => unknown) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() { FakeWorker.instances.push(this) }
}

beforeEach(() => {
  vi.resetModules()
  FakeWorker.instances = []
  vi.stubGlobal('Worker', FakeWorker)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function setupRun() {
  const runs = await import('../../src/lib/db/runs')
  const { createTask } = await import('../../src/lib/db/tasks')
  const task = await createTask({ initialPrompt: 'Original prompt' })
  const run = await runs.createRun(task.id, { iterationsCap: 3 } as RunConfig)
  await runs.patchRun(run.id, { status: 'running' })
  const store = await import('../../src/stores/worker')
  store.optimizationState.set({ run: { ...run, status: 'running' }, candidates: [], history: [], log: [], stage: null })
  store.start(run.id)
  return { runs, run, store, worker: FakeWorker.instances[0] }
}

describe('uncaught worker failure recovery', () => {
  it('persists failure before releasing the run and allows a subsequent run', async () => {
    const { runs, run, store, worker } = await setupRun()
    let release!: () => void
    const persisted = new Promise<void>((resolve) => { release = resolve })
    const actualPatch = runs.patchRun
    const patch = vi.spyOn(runs, 'patchRun').mockImplementationOnce(async (...args) => {
      await persisted
      await actualPatch(...args)
    })
    const failed = worker.onerror!({ message: 'Worker crashed' })
    expect(get(store.activeRunId)).toBe(run.id)
    store.start('too-early')
    expect(FakeWorker.instances).toHaveLength(1)
    release()
    await failed
    expect(patch).toHaveBeenCalledWith(run.id, expect.objectContaining({ status: 'failed', errorMessage: 'Worker crashed', finishedAt: expect.any(Number) }))
    expect(await runs.getRun(run.id)).toMatchObject({ status: 'failed', errorMessage: 'Worker crashed', finishedAt: expect.any(Number) })
    expect(get(store.optimizationState).run).toMatchObject({ status: 'failed', finishedAt: expect.any(Number) })
    expect(get(store.activeRunId)).toBeNull()
    store.start('next')
    expect(get(store.activeRunId)).toBe('next')
    expect(FakeWorker.instances).toHaveLength(2)
  })

  it('ignores late error and completion events from a replaced worker', async () => {
    const { run, store, worker } = await setupRun()
    const oldError = worker.onerror!
    const oldMessage = worker.onmessage!
    await oldError({ message: 'First crash' })
    store.start('next')
    store.optimizationState.update((state) => ({ ...state, run: { ...run, id: 'next', status: 'running', errorMessage: null } }))
    await oldError({ message: 'Late crash' })
    oldMessage({ data: { type: 'DONE', finalCandidateId: null } })
    expect(get(store.activeRunId)).toBe('next')
    expect(get(store.optimizationState).run).toMatchObject({ id: 'next', status: 'running', errorMessage: null })
    expect(FakeWorker.instances[1].terminate).not.toHaveBeenCalled()
  })

  it('does not release ownership when persisting the failure fails', async () => {
    const { runs, run, store, worker } = await setupRun()
    vi.spyOn(runs, 'patchRun').mockRejectedValueOnce(new Error('Storage unavailable'))
    await worker.onerror!({ message: 'Worker crashed' })
    expect(get(store.activeRunId)).toBe(run.id)
    expect(await runs.getRun(run.id)).toMatchObject({ status: 'running' })
    expect(get(store.optimizationState).run?.errorMessage).toContain('Storage unavailable')
    expect(get(store.optimizationState).run?.errorMessage).toContain('Reload to retry recovery')
    store.start('next')
    expect(FakeWorker.instances).toHaveLength(1)
  })

  it('does not mark a completed run failed when an idle worker crashes', async () => {
    const { runs, run, store, worker } = await setupRun()
    await runs.patchRun(run.id, { status: 'completed', finishedAt: 2 })
    store.optimizationState.update((state) => ({ ...state, run: { ...run, status: 'completed', finishedAt: 2 } }))
    worker.onmessage!({ data: { type: 'DONE', finalCandidateId: null } })
    await worker.onerror!({ message: 'Idle worker crashed' })
    expect(await runs.getRun(run.id)).toMatchObject({ status: 'completed', finishedAt: 2 })
    expect(get(store.optimizationState).run).toMatchObject({ status: 'completed', finishedAt: 2 })
  })
})
