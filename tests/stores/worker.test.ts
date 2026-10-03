import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get, writable } from 'svelte/store'
import type { RunConfig } from '../../src/lib/types'

vi.mock('../../src/stores/settings', () => ({ settings: writable({ provider: {}, arbitrator: {} }) }))
beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function fixture(failure: 'construction' | 'delivery') {
  let broken = true
  let created = 0
  const postMessage = vi.fn(() => { if (broken && failure === 'delivery') throw new Error('Delivery failed') })
  const terminate = vi.fn()
  vi.stubGlobal('Worker', class {
    onmessage: unknown
    onerror: unknown
    constructor() { created++; if (broken && failure === 'construction') throw new Error('Worker unavailable') }
    postMessage = postMessage
    terminate = terminate
  })
  const runs = await import('../../src/lib/db/runs')
  const { createTask } = await import('../../src/lib/db/tasks')
  const task = await createTask({ initialPrompt: 'Original' })
  const run = await runs.createRun(task.id, { iterationsCap: 1 } as RunConfig)
  const store = await import('../../src/stores/worker')
  store.optimizationState.set({ run, candidates: [], history: [], log: [], stage: null })
  return { runs, task, run, store, postMessage, terminate, fixWorker: () => { broken = false }, created: () => created }
}

describe.each(['construction', 'delivery'] as const)('worker %s startup failure', (failure) => {
  it('saves failed status before allowing another run', async () => {
    const f = await fixture(failure)
    await expect(Promise.resolve().then(() => f.store.start(f.run.id))).rejects.toThrow(failure === 'construction' ? 'Worker unavailable' : 'Delivery failed')
    expect(await f.runs.getRun(f.run.id)).toMatchObject({ status: 'failed', finishedAt: expect.any(Number), errorMessage: expect.any(String) })
    expect(get(f.store.activeRunId)).toBeNull()
    f.fixWorker()
    const next = await f.runs.createRun(f.task.id, { iterationsCap: 1 } as RunConfig)
    await f.store.start(next.id)
    expect(f.postMessage).toHaveBeenCalledWith({ type: 'START', payload: { runId: next.id } })
    expect(f.created()).toBe(2)
    if (failure === 'delivery') expect(f.terminate).toHaveBeenCalledTimes(1)
  })

  it('holds ownership until the failed-status write finishes', async () => {
    const f = await fixture(failure)
    let notify!: () => void
    let release!: () => void
    const saving = new Promise<void>((resolve) => { notify = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const actualPatch = f.runs.patchRun
    vi.spyOn(f.runs, 'patchRun').mockImplementationOnce(async (...args) => { notify(); await gate; await actualPatch(...args) })
    const failed = expect(Promise.resolve().then(() => f.store.start(f.run.id))).rejects.toThrow()
    await saving
    expect(get(f.store.activeRunId)).toBe(f.run.id)
    await f.store.start('must-not-start')
    expect(f.created()).toBe(1)
    release()
    await failed
    expect(await f.runs.getRun(f.run.id)).toMatchObject({ status: 'failed' })
    expect(get(f.store.activeRunId)).toBeNull()
  })

  it('keeps storage rejection distinct from a deleted run and provides recovery guidance', async () => {
    const f = await fixture(failure)
    vi.spyOn(f.runs, 'patchRun').mockRejectedValueOnce(new Error('Storage unavailable'))
    await expect(Promise.resolve().then(() => f.store.start(f.run.id))).rejects.toThrow('Reload to retry recovery')
    expect(await f.runs.getRun(f.run.id)).toMatchObject({ status: 'idle' })
    expect(get(f.store.activeRunId)).toBe(f.run.id)
    expect(get(f.store.optimizationState).run?.errorMessage).toContain('Storage unavailable')
    f.fixWorker()
    await f.store.start('must-not-start')
    expect(f.created()).toBe(1)
  })
})
