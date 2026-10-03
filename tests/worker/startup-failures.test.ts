import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get, writable } from 'svelte/store'
import type { MainToWorker, WorkerToMain } from '../../src/lib/optimizer/protocol'
import type { RunConfig } from '../../src/lib/types'

const mocks = vi.hoisted(() => ({ getSettings: vi.fn() }))
vi.mock('../../src/stores/settings', () => ({ settings: writable({ provider: {}, arbitrator: {} }) }))
vi.mock('../../src/lib/db/settings', () => ({ getSettings: mocks.getSettings }))
const config: RunConfig = {
  iterationsCap: 0, tokenBudget: 0, concurrency: 1, sampleSizePerIter: 1, earlyStopPlateau: 0,
  targetTemperature: 0, judgeTemperature: 0, mutatorTemperature: 0,
}
let endpoint: { location: Location; onmessage: (event: { data: MainToWorker }) => Promise<void>; postMessage: (message: WorkerToMain) => void }
let worker: WorkerBridge | null
let messages: WorkerToMain[]
class WorkerBridge {
  onmessage: ((event: { data: WorkerToMain }) => void) | null = null
  onerror: unknown
  requests: { message: MainToWorker; done: Promise<void> }[] = []
  constructor() { worker = this }
  postMessage(message: MainToWorker) {
    const done = Promise.resolve().then(() => endpoint.onmessage({ data: structuredClone(message) }))
    this.requests.push({ message, done })
  }
  terminate() {}
  last(type: MainToWorker['type']) { return this.requests.filter((request) => request.message.type === type).at(-1)!.done }
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  worker = null
  messages = []
  endpoint = {
    location: window.location,
    onmessage: async () => {},
    postMessage: (message) => {
      const data = structuredClone(message)
      messages.push(data)
      worker?.onmessage?.({ data })
    },
  }
  vi.stubGlobal('self', endpoint)
  vi.stubGlobal('Worker', WorkerBridge)
  mocks.getSettings.mockResolvedValue({ provider: { targetModel: 'target', judgeModel: 'judge' } })
  await import('../../src/worker/optimizer.worker')
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function fixture() {
  const runs = await import('../../src/lib/db/runs')
  const tasks = await import('../../src/lib/db/tasks')
  const datasets = await import('../../src/lib/db/datasets')
  const task = await tasks.createTask({ initialPrompt: 'Original', seedPrompts: ['Seed one', 'Seed two'] })
  const dataset = await datasets.createDataset(task.id)
  await datasets.addItems(dataset.id, [{ input: 'One' }, { input: 'Two' }])
  await tasks.saveTask({ ...task, datasetId: dataset.id })
  const run = await runs.createRun(task.id, config)
  const store = await import('../../src/stores/worker')
  const writes: { runningError?: Error; terminalError?: Error; beforeTerminal?: () => Promise<void> } = {}
  const actualPatch = runs.patchRun
  vi.spyOn(runs, 'patchRun').mockImplementation(async (id, values) => {
    if (values.status === 'running' && writes.runningError) {
      const error = writes.runningError
      writes.runningError = undefined
      throw error
    }
    if (values.status === 'failed') {
      await writes.beforeTerminal?.()
      if (writes.terminalError) throw writes.terminalError
    }
    await actualPatch(id, values)
  })
  const start = async (next = run) => {
    store.optimizationState.set({ run: next, candidates: [], history: [], log: [], stage: null })
    await store.start(next.id)
    await worker!.last('START')
  }
  return { runs, tasks, datasets, task, run, store, writes, start }
}

type Point = 'run read' | 'missing run' | 'task read' | 'missing task' | 'dataset read' | 'items read' | 'too few items' | 'settings read' | 'candidate read' | 'second seed write' | 'initial running write'
function failAt(point: Point, f: Awaited<ReturnType<typeof fixture>>) {
  const error = new Error(`Synthetic ${point} rejection`)
  switch (point) {
    case 'run read': vi.spyOn(f.runs, 'getRun').mockRejectedValueOnce(error); break
    case 'missing run': vi.spyOn(f.runs, 'getRun').mockResolvedValueOnce(undefined); break
    case 'task read': vi.spyOn(f.tasks, 'getTask').mockRejectedValueOnce(error); break
    case 'missing task': vi.spyOn(f.tasks, 'getTask').mockResolvedValueOnce(undefined); break
    case 'dataset read': vi.spyOn(f.datasets, 'getDataset').mockRejectedValueOnce(error); break
    case 'items read': vi.spyOn(f.datasets, 'getAllItems').mockRejectedValueOnce(error); break
    case 'too few items': vi.spyOn(f.datasets, 'getAllItems').mockResolvedValueOnce([]); break
    case 'settings read': mocks.getSettings.mockRejectedValueOnce(error); break
    case 'candidate read': vi.spyOn(f.runs, 'getCandidates').mockRejectedValueOnce(error); break
    case 'initial running write': f.writes.runningError = error; break
    case 'second seed write': {
      const original = f.runs.addCandidate
      let calls = 0
      vi.spyOn(f.runs, 'addCandidate').mockImplementation(async (candidate) => {
        if (++calls === 2) throw error
        await original(candidate)
      })
      break
    }
  }
}

const points: Point[] = ['run read', 'missing run', 'task read', 'missing task', 'dataset read', 'items read', 'too few items', 'settings read', 'candidate read', 'second seed write', 'initial running write']
describe('durable startup failure ownership', () => {
  it.each(points)('persists failure before releasing a rejected %s startup', async (point) => {
    const f = await fixture()
    failAt(point, f)
    await f.start()
    expect(await f.runs.getRun(f.run.id)).toMatchObject({ status: 'failed', finishedAt: expect.any(Number), errorMessage: expect.any(String) })
    expect(get(f.store.activeRunId)).toBeNull()
    expect(get(f.store.optimizationState).run).toMatchObject({ id: f.run.id, status: 'failed' })
    if (point === 'second seed write') expect((await f.runs.getCandidates(f.run.id)).map((candidate) => candidate.text)).toEqual(['Original'])
    const next = await f.runs.createRun(f.task.id, config)
    await f.start(next)
    expect(await f.runs.getRun(next.id)).toMatchObject({ status: 'completed' })
    expect(await f.runs.getRun(f.run.id)).toMatchObject({ status: 'failed' })
  })

  it.each(['run read', 'second seed write', 'initial running write'] as const)('retains ownership when %s failure also cannot be persisted, then permits Stop recovery', async (point) => {
    const f = await fixture()
    failAt(point, f)
    f.writes.terminalError = new Error('Terminal save unavailable')
    await f.start()
    expect(await f.runs.getRun(f.run.id)).toMatchObject({ status: 'idle' })
    expect(get(f.store.activeRunId)).toBe(f.run.id)
    expect(get(f.store.optimizationState).run?.errorMessage).toContain('Reload')
    expect(messages.some((message) => message.type === 'ERROR' || message.type === 'DONE')).toBe(false)
    await f.store.start('must-not-start')
    expect(worker!.requests.filter((request) => request.message.type === 'START')).toHaveLength(1)
    f.writes.terminalError = undefined
    f.store.stop(f.run.id)
    await worker!.last('STOP')
    expect(await f.runs.getRun(f.run.id)).toMatchObject({ status: point === 'initial running write' ? 'failed' : 'stopped' })
    if (point === 'initial running write') {
      expect(get(f.store.optimizationState).run?.errorMessage).toContain('initial running write')
      expect(get(f.store.optimizationState).run?.errorMessage).not.toContain('Reload')
    }
    expect(get(f.store.activeRunId)).toBeNull()
  })

  it('keeps ownership until a delayed startup failure commit finishes', async () => {
    const f = await fixture()
    failAt('run read', f)
    let release!: () => void
    let notify!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const saving = new Promise<void>((resolve) => { notify = resolve })
    f.writes.beforeTerminal = async () => { notify(); await gate }
    const startup = f.start()
    await saving
    expect(get(f.store.activeRunId)).toBe(f.run.id)
    await f.store.start('must-not-start')
    expect(worker!.requests.filter((request) => request.message.type === 'START')).toHaveLength(1)
    release()
    await startup
    expect(await f.runs.getRun(f.run.id)).toMatchObject({ status: 'failed' })
    expect(get(f.store.activeRunId)).toBeNull()
  })

  it('recovers the new failed startup instead of stopping the previous completed runner', async () => {
    const f = await fixture()
    await f.start()
    const next = await f.runs.createRun(f.task.id, config)
    failAt('run read', f)
    f.writes.terminalError = new Error('Terminal save unavailable')
    await f.start(next)
    expect(get(f.store.activeRunId)).toBe(next.id)
    f.writes.terminalError = undefined
    f.store.stop(next.id)
    await worker!.last('STOP')
    expect(await f.runs.getRun(next.id)).toMatchObject({ status: 'stopped' })
    expect(await f.runs.getRun(f.run.id)).toMatchObject({ status: 'completed' })
    expect(get(f.store.activeRunId)).toBeNull()
  })

  it('can retry Stop after terminal status saved but recovery data could not be read', async () => {
    const f = await fixture()
    failAt('run read', f)
    f.writes.terminalError = new Error('Terminal save unavailable')
    await f.start()
    f.writes.terminalError = undefined
    vi.spyOn(f.runs, 'getCandidates').mockRejectedValueOnce(new Error('Candidate reload unavailable'))
    f.store.stop(f.run.id)
    await worker!.last('STOP')
    expect(await f.runs.getRun(f.run.id)).toMatchObject({ status: 'stopped' })
    expect(get(f.store.activeRunId)).toBe(f.run.id)
    expect(get(f.store.optimizationState).run?.errorMessage).toContain('Reload')
    f.store.stop(f.run.id)
    await worker!.last('STOP')
    expect(get(f.store.activeRunId)).toBeNull()
    expect(get(f.store.optimizationState).run).toMatchObject({ id: f.run.id, status: 'stopped' })
  })

  it('releases a genuinely deleted run without recreating its record', async () => {
    const f = await fixture()
    const { db } = await import('../../src/lib/db/db')
    await (await db()).delete('runs', f.run.id)
    await f.start()
    expect(await f.runs.getRun(f.run.id)).toBeUndefined()
    expect(get(f.store.activeRunId)).toBeNull()
  })
})
