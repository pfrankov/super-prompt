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
    const { createRun, getRun, getCandidates, getIterations } = await import('../../src/lib/db/runs')
    const run = await createRun(task.id, config)
    const pending = blockRequest(phase)
    const running = send({ type: 'START', payload: { runId: run.id } })
    await pending
    await send({ type: 'STOP', payload: { runId: run.id } })
    await running
    const tokens = phase === 'mutation' ? 0 : phase === 'target' ? 1 : 3
    expect(await getRun(run.id)).toMatchObject({ status: 'stopped', iterationCount: 0, totalTokensIn: tokens, totalTokensOut: tokens })
    expect(await getIterations(run.id)).toEqual([])
    expect(mocks.completion.mock.calls.filter(([args]) => requestPhase(args) === 'target')).toHaveLength(phase === 'mutation' ? 0 : 2)
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

function requestPhase(args: { model: string; messages: { content: string }[] }) {
  return args.model === 'target' ? 'target'
    : args.messages[0].content.includes('meticulous prompt engineer') ? 'mutation' : 'judge'
}

function completedResponse(phase: 'mutation' | 'target' | 'judge') {
  return {
    text: phase === 'mutation' ? JSON.stringify({ newPrompt: 'Revised prompt', rationale: 'Improve' })
      : phase === 'judge' ? JSON.stringify({ winner: 'A', scoreA: 8, scoreB: 4 }) : 'Answer',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  }
}

function waitForAbortedRequest(signal: AbortSignal) {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

describe('cancellation preserves genuine evaluation evidence', () => {
  it.each(['target', 'judge'] as const)('keeps a completed pair but omits a later aborted %s pair', async (phase) => {
    const { createRun, getRun, getCandidates, getIterations, getPairs } = await import('../../src/lib/db/runs')
    const run = await createRun(task.id, config)
    let notify!: () => void
    const pending = new Promise<void>((resolve) => { notify = resolve })
    mocks.completion.mockImplementation(async (args) => {
      const current = requestPhase(args)
      const secondItem = args.messages[1].content === 'Two' || args.messages[1].content.includes('INPUT:\nTwo')
      if (current === phase && secondItem) {
        notify()
        return waitForAbortedRequest(args.signal)
      }
      return completedResponse(current)
    })
    const running = send({ type: 'START', payload: { runId: run.id } })
    await pending
    await send({ type: 'STOP', payload: { runId: run.id } })
    await running
    const history = await getIterations(run.id)
    expect(history).toHaveLength(1)
    expect(history[0].sampleItemIds).toEqual(['one'])
    const pairs = await getPairs(history[0].id)
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ itemId: 'one', verdict: { winner: 'A', scoreA: 8, scoreB: 4 } })
    expect(pairs[0].errorMessage).toBeUndefined()
    expect((await getCandidates(run.id)).find((candidate) => candidate.source === 'seed')).toMatchObject({ score: 8, iterations: 1, ties: 0 })
    const tokens = phase === 'target' ? 4 : 6
    expect(await getRun(run.id)).toMatchObject({ status: 'stopped', iterationCount: 1, totalTokensIn: tokens, totalTokensOut: tokens })
  })

  it.each(['target', 'judge'] as const)('preserves an earlier iteration when the next %s request is aborted', async (phase) => {
    const { createRun, getRun, getIterations, getPairs } = await import('../../src/lib/db/runs')
    const run = await createRun(task.id, { ...config, iterationsCap: 2, sampleSizePerIter: 1 })
    let mutations = 0
    let notify!: () => void
    const pending = new Promise<void>((resolve) => { notify = resolve })
    mocks.completion.mockImplementation(async (args) => {
      const current = requestPhase(args)
      if (current === 'mutation') mutations++
      if (current === phase && mutations >= 2) {
        notify()
        return waitForAbortedRequest(args.signal)
      }
      return completedResponse(current)
    })
    const running = send({ type: 'START', payload: { runId: run.id } })
    await pending
    const completed = await getIterations(run.id)
    expect(completed).toHaveLength(1)
    await send({ type: 'STOP', payload: { runId: run.id } })
    await running
    expect(await getIterations(run.id)).toEqual(completed)
    const pairs = await getPairs(completed[0].id)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].errorMessage).toBeUndefined()
    expect(await getRun(run.id)).toMatchObject({ status: 'stopped', iterationCount: 1 })
  })

  it('keeps the original item ID when a cancelled pair precedes a completed genuine failure', async () => {
    const { createRun, getRun, getIterations, getPairs } = await import('../../src/lib/db/runs')
    const run = await createRun(task.id, { ...config, concurrency: 2 })
    let notify!: () => void
    const failureFinished = new Promise<void>((resolve) => { notify = resolve })
    mocks.completion.mockImplementation(async (args) => {
      const current = requestPhase(args)
      if (current === 'target' && args.messages[1].content === 'One') return waitForAbortedRequest(args.signal)
      if (current === 'judge') {
        // Notify after rejection handlers have consumed this genuine failure.
        setTimeout(notify, 0)
        throw new Error('Judge unavailable for Two')
      }
      return completedResponse(current)
    })
    const running = send({ type: 'START', payload: { runId: run.id } })
    await failureFinished
    await send({ type: 'STOP', payload: { runId: run.id } })
    await running
    const history = await getIterations(run.id)
    expect(history).toHaveLength(1)
    expect(history[0].sampleItemIds).toEqual(['two'])
    const pairs = await getPairs(history[0].id)
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ itemId: 'two', errorMessage: 'judge_failed: Judge unavailable for Two' })
    expect(await getRun(run.id)).toMatchObject({ status: 'stopped', iterationCount: 0, totalTokensIn: 3, totalTokensOut: 3 })
  })

  it.each(['target', 'judge'] as const)('still persists real all-failed %s diagnostics', async (phase) => {
    const { createRun, getRun, getIterations, getPairs } = await import('../../src/lib/db/runs')
    const run = await createRun(task.id, config)
    mocks.completion.mockImplementation(async (args) => {
      const current = requestPhase(args)
      if (current === phase) throw new Error('Provider unavailable')
      return completedResponse(current)
    })
    await send({ type: 'START', payload: { runId: run.id } })
    expect(await getRun(run.id)).toMatchObject({ status: 'failed', iterationCount: 0 })
    const history = await getIterations(run.id)
    expect(history).toHaveLength(1)
    const pairs = await getPairs(history[0].id)
    expect(pairs).toHaveLength(2)
    expect(pairs.every((pair) => pair.errorMessage?.includes('Provider unavailable'))).toBe(true)
  })
})
