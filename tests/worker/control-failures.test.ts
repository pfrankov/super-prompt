import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get, writable } from 'svelte/store'
import type { MainToWorker, WorkerToMain } from '../../src/lib/optimizer/protocol'
import type { RunConfig } from '../../src/lib/types'

const mocks = vi.hoisted(() => ({ completion: vi.fn() }))
vi.mock('../../src/lib/api/openaiLike', () => ({ chatCompletionWithRetry: mocks.completion }))
vi.mock('../../src/stores/settings', () => ({ settings: writable({ provider: {}, arbitrator: {} }) }))
vi.mock('../../src/lib/db/settings', () => ({ getSettings: async () => ({ provider: {
  baseUrl: 'http://local', apiKey: '', targetModel: 'target', judgeModel: 'judge', requestTimeoutMs: 1000, maxRetries: 0,
} }) }))
vi.mock('../../src/lib/db/datasets', () => ({
  getDataset: async () => ({ id: 'dataset' }),
  getAllItems: async () => [{ id: 'one', input: 'One' }, { id: 'two', input: 'Two' }],
}))

const config: RunConfig = {
  iterationsCap: 2, tokenBudget: 0, concurrency: 1, sampleSizePerIter: 1, earlyStopPlateau: 0,
  targetTemperature: 0, judgeTemperature: 0, mutatorTemperature: 0,
}
let endpoint: { location: Location; onmessage: (event: { data: MainToWorker }) => Promise<void>; postMessage: (message: WorkerToMain) => void }
let bridge: WorkerBridge | null
let messages: WorkerToMain[]
class WorkerBridge {
  onmessage: ((event: { data: WorkerToMain }) => void) | null = null
  onerror: unknown
  requests: { message: MainToWorker; done: Promise<void> }[] = []
  constructor() { bridge = this }
  postMessage = vi.fn((message: MainToWorker) => {
    const done = Promise.resolve().then(() => endpoint.onmessage({ data: structuredClone(message) }))
    this.requests.push({ message, done })
  })
  terminate = vi.fn()
  last(type: MainToWorker['type']) { return this.requests.filter((request) => request.message.type === type).at(-1)!.done }
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  bridge = null
  messages = []
  endpoint = {
    location: window.location,
    onmessage: async () => {},
    postMessage: (message) => {
      const data = structuredClone(message)
      messages.push(data)
      bridge?.onmessage?.({ data })
    },
  }
  vi.stubGlobal('self', endpoint)
  vi.stubGlobal('Worker', WorkerBridge)
  await import('../../src/worker/optimizer.worker')
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function runningFixture() {
  const runs = await import('../../src/lib/db/runs')
  const { createTask } = await import('../../src/lib/db/tasks')
  const task = await createTask({ initialPrompt: 'Original', datasetId: 'dataset' })
  const run = await runs.createRun(task.id, config)
  const store = await import('../../src/stores/worker')
  store.optimizationState.set({ run, candidates: [], history: [], log: [], stage: null })
  let notify!: () => void
  const pending = new Promise<void>((resolve) => { notify = resolve })
  const aborts: (() => void)[] = []
  const failures: (() => void)[] = []
  mocks.completion.mockImplementation(async (args) => {
    if (args.model === 'target') {
      notify()
      return new Promise<never>((_, reject) => {
        failures.push(() => reject(new Error('Target unavailable')))
        const abort = () => aborts.push(() => reject(args.signal.reason))
        if (args.signal.aborted) abort()
        else args.signal.addEventListener('abort', abort, { once: true })
      })
    }
    return { text: JSON.stringify({ newPrompt: 'Revised', rationale: 'Improve' }), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
  })
  store.start(run.id)
  await pending
  const worker = bridge!
  const actualPatch = runs.patchRun
  const patch = vi.spyOn(runs, 'patchRun')
  const releaseAborts = () => { for (const abort of aborts.splice(0)) abort() }
  const cleanup = async () => {
    patch.mockImplementation(actualPatch)
    store.stop(run.id)
    await worker.last('STOP')
    releaseAborts()
    await worker.last('START')
  }
  return { runs, run, store, worker, actualPatch, patch, releaseAborts, failTargets: () => { for (const fail of failures.splice(0)) fail() }, cleanup }
}

describe('production worker/store control failure ownership', () => {
  it.each(['pause', 'resume'] as const)('keeps ownership and supports retry after a failed %s write', async (control) => {
    const fixture = await runningFixture()
    const { runs, run, store, worker, patch, actualPatch, cleanup } = fixture
    try {
      if (control === 'resume') {
        store.pause(run.id)
        await worker.last('PAUSE')
      }
      const status = control === 'pause' ? 'paused' : 'running'
      let failed = false
      patch.mockImplementation(async (id, values) => {
        if (!failed && values.status === status) { failed = true; throw new Error(`${control} storage failed`) }
        await actualPatch(id, values)
      })
      store[control](run.id)
      await worker.last(control === 'pause' ? 'PAUSE' : 'RESUME')
      expect(get(store.activeRunId)).toBe(run.id)
      expect(get(store.optimizationState).run).toMatchObject({ status, errorMessage: expect.stringContaining(`${control} storage failed`) })
      const count = worker.requests.filter((request) => request.message.type === 'START').length
      store.start('new-run-must-not-start')
      expect(worker.requests.filter((request) => request.message.type === 'START')).toHaveLength(count)
      store[control](run.id)
      await worker.last(control === 'pause' ? 'PAUSE' : 'RESUME')
      expect(await runs.getRun(run.id)).toMatchObject({ status, errorMessage: null })
      expect(get(store.optimizationState).run?.errorMessage).toBeNull()
      expect(get(store.activeRunId)).toBe(run.id)
    } finally { await cleanup() }
  })

  it('keeps a failed Stop owned until pending work settles and stopped status is saved', async () => {
    const fixture = await runningFixture()
    const { runs, run, store, worker, patch, actualPatch, releaseAborts, cleanup } = fixture
    try {
      let failed = false
      patch.mockImplementation(async (id, values) => {
        if (!failed && values.status === 'stopped') { failed = true; throw new Error('stop storage failed') }
        await actualPatch(id, values)
      })
      store.stop(run.id)
      await worker.last('STOP')
      expect(get(store.activeRunId)).toBe(run.id)
      expect(get(store.optimizationState).run?.errorMessage).toContain('stop storage failed')
      store.start('new-run-must-not-start')
      expect(worker.requests.filter((request) => request.message.type === 'START')).toHaveLength(1)
      releaseAborts()
      await worker.last('START')
      expect(await runs.getRun(run.id)).toMatchObject({ status: 'stopped', finishedAt: expect.any(Number), errorMessage: null })
      expect(get(store.optimizationState).run?.errorMessage).toBeNull()
      expect(get(store.activeRunId)).toBeNull()
    } finally { await cleanup() }
  })

  it('retains ownership when Stop and its finalization writes fail, then recovers on Stop retry', async () => {
    const fixture = await runningFixture()
    const { runs, run, store, worker, patch, actualPatch, releaseAborts, cleanup } = fixture
    try {
      patch.mockImplementation(async (id, values) => {
        if (values.status === 'stopped') throw new Error('storage remains unavailable')
        await actualPatch(id, values)
      })
      store.stop(run.id)
      await worker.last('STOP')
      releaseAborts()
      await worker.last('START')
      expect(get(store.activeRunId)).toBe(run.id)
      expect(messages.some((message) => message.type === 'ERROR' || message.type === 'DONE')).toBe(false)
      expect(get(store.optimizationState).run?.errorMessage).toContain('Reload')
      expect(await runs.getRun(run.id)).toMatchObject({ status: 'running' })
      store.start('new-run-must-not-start')
      expect(worker.requests.filter((request) => request.message.type === 'START')).toHaveLength(1)
      patch.mockImplementation(actualPatch)
      store.stop(run.id)
      await worker.last('STOP')
      expect(await runs.getRun(run.id)).toMatchObject({ status: 'stopped', errorMessage: null })
      expect(get(store.activeRunId)).toBeNull()
    } finally { await cleanup() }
  })
})


it('releases a genuine terminal error only after its failed status commits', async () => {
  const { runs, run, store, worker, patch, actualPatch, failTargets, cleanup } = await runningFixture()
  let release!: () => void
  const committed = new Promise<void>((resolve) => { release = resolve })
  try {
    let notify!: () => void
    const saving = new Promise<void>((resolve) => { notify = resolve })
    patch.mockImplementation(async (id, values) => {
      if (values.status === 'failed') { notify(); await committed }
      await actualPatch(id, values)
    })
    failTargets()
    await saving
    expect(get(store.activeRunId)).toBe(run.id)
    expect(messages.some((message) => message.type === 'ERROR')).toBe(false)
    release()
    await worker.last('START')
    expect(await runs.getRun(run.id)).toMatchObject({ status: 'failed', errorMessage: expect.stringContaining('Target unavailable') })
    expect(get(store.activeRunId)).toBeNull()
    expect(messages.some((message) => message.type === 'ERROR')).toBe(true)
  } finally { release(); await cleanup() }
})

it('keeps an unpersisted genuine terminal error recoverable without releasing ownership', async () => {
  const { runs, run, store, worker, patch, actualPatch, failTargets, cleanup } = await runningFixture()
  try {
    patch.mockImplementation(async (id, values) => {
      if (values.status === 'failed') throw new Error('Final status unavailable')
      await actualPatch(id, values)
    })
    failTargets()
    await worker.last('START')
    expect(get(store.activeRunId)).toBe(run.id)
    expect(messages.some((message) => message.type === 'ERROR' || message.type === 'DONE')).toBe(false)
    expect(get(store.optimizationState).run?.errorMessage).toContain('Reload')
    patch.mockImplementation(actualPatch)
    store.stop(run.id)
    await worker.last('STOP')
    expect(await runs.getRun(run.id)).toMatchObject({ status: 'stopped', errorMessage: null })
    expect(get(store.activeRunId)).toBeNull()
  } finally { await cleanup() }
})
