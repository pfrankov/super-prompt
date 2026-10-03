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
  iterationsCap: 1, tokenBudget: 0, concurrency: 1, sampleSizePerIter: 1, earlyStopPlateau: 0,
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

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
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
  mocks.completion.mockImplementation(async (args) => ({
    text: args.model === 'target' ? 'Answer'
      : args.messages[0].content.includes('meticulous prompt engineer')
        ? JSON.stringify({ newPrompt: 'Revised', rationale: 'Improve' })
        : JSON.stringify({ winner: 'A', scoreA: 8, scoreB: 4 }),
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  }))
  await import('../../src/worker/optimizer.worker')
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

type Boundary = 'mutation usage' | 'new candidate' | 'evaluation usage' | 'iteration' | 'scored challenger' | 'scored parent' | 'run summary'

async function fixture(
  boundary: Boundary,
  failure: Error = new Error(`${boundary} write failed`),
  stopGate?: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> },
) {
  const runs = await import('../../src/lib/db/runs')
  const { createTask } = await import('../../src/lib/db/tasks')
  const task = await createTask({ initialPrompt: 'Original', datasetId: 'dataset' })
  const run = await runs.createRun(task.id, config)
  const store = await import('../../src/stores/worker')
  store.optimizationState.set({ run, candidates: [], history: [], log: [], stage: null })
  const reached = deferred()
  const release = deferred()
  const fail = async () => { reached.resolve(); await release.promise; throw failure }
  const actualPatch = runs.patchRun
  const actualCandidate = runs.addCandidate
  const actualIteration = runs.addIteration
  const patch = vi.spyOn(runs, 'patchRun').mockImplementation(async (id, values) => {
    if (values.status === 'stopped' && stopGate) { stopGate.entered.resolve(); await stopGate.release.promise }
    if (!values.status && (
      (boundary === 'mutation usage' && values.totalTokensIn === 1)
      || (boundary === 'evaluation usage' && values.totalTokensIn === 4 && values.iterationCount === undefined)
      || (boundary === 'run summary' && values.iterationCount === 1)
    )) return fail()
    return actualPatch(id, values)
  })
  vi.spyOn(runs, 'addCandidate').mockImplementation(async (candidate) => {
    if ((boundary === 'new candidate' && candidate.source === 'mutated' && candidate.score === null)
      || (boundary === 'scored challenger' && candidate.source === 'mutated' && candidate.score !== null)
      || (boundary === 'scored parent' && candidate.source === 'seed' && candidate.score !== null)) return fail()
    return actualCandidate(candidate)
  })
  vi.spyOn(runs, 'addIteration').mockImplementation(async (iteration, pairs) => {
    if (boundary === 'iteration') return fail()
    return actualIteration(iteration, pairs)
  })
  await store.start(run.id)
  await reached.promise
  const worker = bridge!
  store.stop(run.id)
  if (stopGate) await stopGate.entered.promise
  else {
    await worker.last('STOP')
    expect(await runs.getRun(run.id)).toMatchObject({ status: 'stopped', errorMessage: null })
  }
  expect(get(store.activeRunId)).toBe(run.id)
  expect(messages.some((message) => message.type === 'DONE')).toBe(false)
  return { runs, run, store, worker, release, patch, actualPatch }
}

describe('storage failure while a stopped iteration unwinds', () => {
  it.each<Boundary>(['mutation usage', 'new candidate', 'evaluation usage', 'iteration', 'scored challenger', 'scored parent', 'run summary'])(
    'durably reports a delayed %s rejection after Stop saved its status', async (boundary) => {
      const { runs, run, store, worker, release } = await fixture(boundary)
      release.resolve()
      await worker.last('START')
      const tokens = boundary === 'mutation usage' || boundary === 'new candidate' ? 1 : 4
      expect(await runs.getRun(run.id)).toMatchObject({
        status: 'failed', errorMessage: `${boundary} write failed`, totalTokensIn: tokens, totalTokensOut: tokens,
      })
      expect(get(store.optimizationState).run).toMatchObject({ status: 'failed', errorMessage: `${boundary} write failed` })
      expect(get(store.activeRunId)).toBeNull()
      expect(messages.some((message) => message.type === 'DONE')).toBe(false)
      expect(messages.some((message) => message.type === 'ERROR' && message.message === `${boundary} write failed`)).toBe(true)
      const history = await runs.getIterations(run.id)
      expect(history).toHaveLength(['scored challenger', 'scored parent', 'run summary'].includes(boundary) ? 1 : 0)
      if (history.length) expect(await runs.getPairs(history[0].id)).toHaveLength(1)
      expect((await runs.getCandidates(run.id)).some((candidate) => candidate.source === 'seed' && candidate.text === 'Original')).toBe(true)
    },
  )

  it('does not mistake an IndexedDB AbortError for the request cancellation reason', async () => {
    const { runs, run, store, worker, release } = await fixture('iteration', new DOMException('Evidence transaction aborted', 'AbortError'))
    release.resolve()
    await worker.last('START')
    expect(await runs.getRun(run.id)).toMatchObject({ status: 'failed', errorMessage: 'Evidence transaction aborted' })
    expect(get(store.activeRunId)).toBeNull()
    expect(messages.some((message) => message.type === 'ERROR')).toBe(true)
    expect(messages.some((message) => message.type === 'DONE')).toBe(false)
  })

  it('holds ownership until the later failed status commits despite the earlier stopped commit', async () => {
    const { runs, run, store, worker, release, patch, actualPatch } = await fixture('iteration')
    const savingFailure = deferred()
    const allowFailure = deferred()
    patch.mockImplementation(async (id, values) => {
      if (values.status === 'failed') { savingFailure.resolve(); await allowFailure.promise }
      await actualPatch(id, values)
    })
    release.resolve()
    try {
      await savingFailure.promise
      expect(get(store.activeRunId)).toBe(run.id)
      await store.start('must-not-start')
      expect(worker.requests.filter((request) => request.message.type === 'START')).toHaveLength(1)
      expect(messages.some((message) => message.type === 'DONE' || message.type === 'ERROR')).toBe(false)
    } finally { allowFailure.resolve() }
    await worker.last('START')
    expect(await runs.getRun(run.id)).toMatchObject({ status: 'failed', errorMessage: 'iteration write failed' })
    expect(get(store.activeRunId)).toBeNull()
  })

  it('keeps the original failure and returned usage when the failed-status write needs Stop recovery', async () => {
    const { runs, run, store, worker, release, patch, actualPatch } = await fixture('evaluation usage')
    patch.mockImplementation(async (id, values) => {
      if (values.status === 'failed') throw new Error('Status storage unavailable')
      await actualPatch(id, values)
    })
    release.resolve()
    await worker.last('START')
    expect(await runs.getRun(run.id)).toMatchObject({ status: 'stopped', totalTokensIn: 1 })
    expect(get(store.activeRunId)).toBe(run.id)
    expect(get(store.optimizationState).run?.errorMessage).toContain('evaluation usage write failed')
    expect(get(store.optimizationState).run?.errorMessage).toContain('Status storage unavailable')
    expect(get(store.optimizationState).run?.errorMessage).toContain('Reload')
    expect(messages.some((message) => message.type === 'DONE' || message.type === 'ERROR')).toBe(false)
    await store.start('must-not-start')
    expect(worker.requests.filter((request) => request.message.type === 'START')).toHaveLength(1)
    patch.mockImplementation(actualPatch)
    store.stop(run.id)
    await worker.last('STOP')
    expect(await runs.getRun(run.id)).toMatchObject({
      status: 'failed', errorMessage: 'evaluation usage write failed', totalTokensIn: 4, totalTokensOut: 4,
    })
    expect(get(store.optimizationState).run?.errorMessage).toBe('evaluation usage write failed')
    expect(get(store.activeRunId)).toBeNull()
  })

  it('waits for an earlier pending Stop write before saving and releasing the later failure', async () => {
    const stopGate = { entered: deferred(), release: deferred() }
    const { runs, run, store, worker, release, patch } = await fixture('iteration', undefined, stopGate)
    const failureObserved = deferred()
    const unsubscribe = store.optimizationState.subscribe((state) => {
      if (state.log.some((entry) => entry.level === 'error' && entry.msg === 'iteration write failed')) failureObserved.resolve()
    })
    release.resolve()
    try {
      await failureObserved.promise
      expect(get(store.activeRunId)).toBe(run.id)
      expect(patch.mock.calls.some(([, values]) => values.status === 'failed')).toBe(false)
      expect(messages.some((message) => message.type === 'DONE' || message.type === 'ERROR')).toBe(false)
    } finally { unsubscribe(); stopGate.release.resolve() }
    await Promise.all([worker.last('START'), worker.last('STOP')])
    expect(await runs.getRun(run.id)).toMatchObject({ status: 'failed', errorMessage: 'iteration write failed' })
    expect(get(store.activeRunId)).toBeNull()
  })
})
