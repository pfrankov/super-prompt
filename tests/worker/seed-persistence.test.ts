import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MainToWorker, WorkerToMain } from '../../src/lib/optimizer/protocol'
import type { RunConfig, Task } from '../../src/lib/types'

const mocks = vi.hoisted(() => ({ completion: vi.fn(), getTask: vi.fn() }))
vi.mock('../../src/lib/api/openaiLike', () => ({ chatCompletionWithRetry: mocks.completion }))
vi.mock('../../src/lib/db/tasks', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/db/tasks')>(), getTask: mocks.getTask,
}))
vi.mock('../../src/lib/db/datasets', () => ({
  getDataset: async () => ({ id: 'dataset' }),
  getAllItems: async () => [{ id: 'one', input: 'One' }, { id: 'two', input: 'Two' }],
}))
vi.mock('../../src/lib/db/settings', () => ({
  getSettings: async () => ({ provider: {
    baseUrl: 'http://local', apiKey: '', targetModel: 'target', judgeModel: 'judge',
    requestTimeoutMs: 1000, maxRetries: 0,
  } }),
}))

const config: RunConfig = {
  iterationsCap: 1, tokenBudget: 0, concurrency: 1, sampleSizePerIter: 2,
  earlyStopPlateau: 0, targetTemperature: 0, judgeTemperature: 0, mutatorTemperature: 0,
}
const task: Task = {
  id: 'task', name: 'Task', description: 'Task', initialPrompt: 'Original system prompt', seedPrompts: [],
  rubric: { text: 'Quality' }, datasetId: 'dataset', providerId: null, createdAt: 1, updatedAt: 1,
}

let worker: { onmessage: (event: { data: MainToWorker }) => Promise<void>; postMessage: ReturnType<typeof vi.fn> }
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.getTask.mockResolvedValue({ ...task })
  worker = { onmessage: async () => {}, postMessage: vi.fn<(message: WorkerToMain) => void>() }
  vi.stubGlobal('self', worker)
  const { db } = await import('../../src/lib/db/db')
  await (await db()).put('tasks', task)
  await import('../../src/worker/optimizer.worker')
})
afterEach(() => { vi.unstubAllGlobals() })

function send(data: MainToWorker) { return worker.onmessage({ data }) }

function blockRequest(phase: 'mutation' | 'target' | 'judge') {
  let notify!: () => void
  const started = new Promise<void>((resolve) => { notify = resolve })
  mocks.completion.mockImplementation(async (args) => {
    const current = args.model === 'target' ? 'target'
      : args.messages[0].content.includes('meticulous prompt engineer') ? 'mutation' : 'judge'
    if (current === phase) {
      notify()
      return new Promise((_, reject) => {
        if (args.signal.aborted) reject(args.signal.reason)
        else args.signal.addEventListener('abort', () => reject(args.signal.reason), { once: true })
      })
    }
    return {
      text: current === 'mutation' ? JSON.stringify({ newPrompt: 'Revised prompt', rationale: 'Improve' })
        : current === 'judge' ? JSON.stringify({ winner: 'A', scoreA: 8, scoreB: 4 }) : 'Answer',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }
  })
  return started
}

describe('seed candidates survive cancellation', () => {
  it.each(['mutation', 'target', 'judge'] as const)('reloads the original seed after Stop during the first pending %s', async (phase) => {
    const { createRun, getRun, getCandidates } = await import('../../src/lib/db/runs')
    const run = await createRun(task.id, config)
    const pending = blockRequest(phase)
    const running = send({ type: 'START', payload: { runId: run.id } })
    await pending
    await send({ type: 'STOP', payload: { runId: run.id } })
    await running
    expect(await getRun(run.id)).toMatchObject({ status: 'stopped', iterationCount: 0 })
    expect((await getCandidates(run.id)).filter((candidate) => candidate.source === 'seed')).toEqual([
      expect.objectContaining({ text: task.initialPrompt, score: null, source: 'seed', runId: run.id }),
    ])
  })

  it('persists every supplied seed before the first target request begins', async () => {
    mocks.getTask.mockResolvedValue({ ...task, seedPrompts: ['Seed one', 'Seed two'] })
    const { createRun, getCandidates } = await import('../../src/lib/db/runs')
    const run = await createRun(task.id, config)
    const pending = blockRequest('target')
    const running = send({ type: 'START', payload: { runId: run.id } })
    await pending
    const savedBeforeStop = await getCandidates(run.id)
    await send({ type: 'STOP', payload: { runId: run.id } })
    await running
    expect(savedBeforeStop.map((candidate) => candidate.text).sort()).toEqual([
      task.initialPrompt, 'Seed one', 'Seed two',
    ].sort())
  })
})
