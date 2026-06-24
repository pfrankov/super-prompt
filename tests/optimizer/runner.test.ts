import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Run, RunConfig, Task, ProviderConfig, DatasetItem, PromptCandidate } from '../../src/lib/types'

vi.mock('../../src/lib/api/openaiLike', () => ({
  chatCompletionWithRetry: vi.fn(),
}))

vi.mock('../../src/lib/db/runs', () => ({
  addIteration: vi.fn(),
  addCandidate: vi.fn(),
  patchRun: vi.fn(),
}))

vi.mock('../../src/lib/optimizer/judge', () => ({
  runJudge: vi.fn(),
}))

vi.mock('../../src/lib/optimizer/mutator', () => ({
  runMutator: vi.fn(),
  forceVariation: (text: string) => `${text}\n\nThink step by step before responding.`,
}))

const { createRunner } = await import('../../src/worker/loop')
const { chatCompletionWithRetry } = await import('../../src/lib/api/openaiLike')
const { addCandidate, patchRun } = await import('../../src/lib/db/runs')
const { runJudge } = await import('../../src/lib/optimizer/judge')
const { runMutator } = await import('../../src/lib/optimizer/mutator')

const config: RunConfig = {
  iterationsCap: 1,
  tokenBudget: 0,
  concurrency: 1,
  sampleSizePerIter: 2,
  earlyStopPlateau: 0,
  judgeTemperature: 0.2,
  targetTemperature: 0.7,
  mutatorTemperature: 0.7,
}

const run: Run = {
  id: 'run1',
  taskId: 'task1',
  config,
  status: 'idle',
  bestCandidateId: null,
  totalTokensIn: 0,
  totalTokensOut: 0,
  iterationCount: 0,
  startedAt: 1,
  finishedAt: null,
  errorMessage: null,
}

const task: Task = {
  id: 'task1',
  name: 'Task',
  description: 'Do task',
  initialPrompt: 'Parent prompt',
  seedPrompts: [],
  rubric: { text: 'Score it' },
  datasetId: 'ds1',
  providerId: null,
  createdAt: 1,
  updatedAt: 1,
}

const provider: ProviderConfig = {
  id: 'p1',
  label: 'Provider',
  baseUrl: 'http://local',
  apiKey: '',
  targetModel: 'target',
  judgeModel: 'judge',
  requestTimeoutMs: 1000,
  maxRetries: 2,
}

const items: DatasetItem[] = [
  { id: 'i1', datasetId: 'ds1', input: 'one' },
  { id: 'i2', datasetId: 'ds1', input: 'two' },
]

const parent: PromptCandidate = {
  id: 'parent',
  runId: 'run1',
  parentId: null,
  text: 'Parent prompt',
  source: 'seed',
  score: null,
  wins: 0,
  losses: 0,
  ties: 0,
  iterations: 0,
  tokensIn: 0,
  tokensOut: 0,
  createdAt: 1,
}

function makeRunner(send = vi.fn()) {
  return createRunner({
    runId: 'run1',
    initialRun: { ...run },
    initialCandidates: [{ ...parent }],
    ctx: { task, items, provider, config },
    send,
  })
}

describe('createRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(chatCompletionWithRetry).mockResolvedValue({
      text: 'target output',
      model: 'target',
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      raw: {},
    })
    vi.mocked(runMutator).mockResolvedValue({
      newPrompt: 'Child prompt',
      rationale: 'try a clearer instruction',
      tokensIn: 1,
      tokensOut: 1,
    })
    vi.mocked(runJudge).mockResolvedValue({
      verdict: {
        winner: 'B',
        scoreA: 5,
        scoreB: 8,
        reasoning: 'B is better',
        feedbackA: 'be clearer',
        feedbackB: '',
      },
      tokensIn: 1,
      tokensOut: 1,
      latencyMs: 1,
    })
  })

  it('creates and scores a mutated challenger when there is only one seed', async () => {
    await makeRunner().start()

    expect(runMutator).toHaveBeenCalledTimes(1)
    expect(chatCompletionWithRetry).toHaveBeenCalledWith(expect.any(Object), provider.maxRetries)
    expect(addCandidate).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Child prompt',
      score: 6.5,
      parentId: 'parent',
    }))
    expect(patchRun).toHaveBeenCalledWith('run1', expect.objectContaining({
      iterationCount: 1,
      totalTokensIn: expect.any(Number),
      totalTokensOut: expect.any(Number),
    }))
  })

  it('emits granular stage events during a desktop improvement run', async () => {
    const send = vi.fn()
    await makeRunner(send).start()

    const stages = send.mock.calls
      .map(([msg]) => msg)
      .filter((msg) => msg.type === 'STAGE')
      .map((msg) => msg.stage.key)

    expect(stages).toEqual(expect.arrayContaining([
      'starting',
      'selecting',
      'mutating',
      'sampling',
      'answering',
      'judging',
      'scoring',
      'persisting',
      'completed',
    ]))
  })

  it('mutates a promising frontier parent instead of only the top score', async () => {
    const provenBest: PromptCandidate = {
      ...parent,
      id: 'proven',
      text: 'Proven best prompt',
      score: 8,
      wins: 18,
      losses: 2,
      iterations: 20,
    }
    const promising: PromptCandidate = {
      ...parent,
      id: 'promising',
      text: 'Promising prompt',
      score: 7.8,
      wins: 1,
      losses: 0,
      iterations: 1,
      createdAt: 2,
    }

    const runner = createRunner({
      runId: 'run1',
      initialRun: { ...run },
      initialCandidates: [provenBest, promising],
      ctx: { task, items, provider, config },
      send: vi.fn(),
    })

    await runner.start()

    expect(runMutator).toHaveBeenCalledWith(expect.objectContaining({
      parentText: 'Promising prompt',
      parentScore: 7.8,
    }))
    expect(addCandidate).toHaveBeenCalledWith(expect.objectContaining({
      parentId: 'promising',
      text: 'Child prompt',
    }))
  })

  it('does not explore a Pareto-dominated parent just because it has few trials', async () => {
    const reliable: PromptCandidate = {
      ...parent,
      id: 'reliable',
      text: 'Reliable prompt',
      score: 8,
      wins: 8,
      losses: 1,
      iterations: 9,
    }
    const dominated: PromptCandidate = {
      ...parent,
      id: 'dominated',
      text: 'Dominated prompt',
      score: 7.7,
      wins: 0,
      losses: 1,
      iterations: 1,
      createdAt: 2,
    }

    const runner = createRunner({
      runId: 'run1',
      initialRun: { ...run },
      initialCandidates: [reliable, dominated],
      ctx: { task, items, provider, config },
      send: vi.fn(),
    })

    await runner.start()

    expect(runMutator).toHaveBeenCalledWith(expect.objectContaining({
      parentText: 'Reliable prompt',
      parentScore: 8,
    }))
    expect(addCandidate).toHaveBeenCalledWith(expect.objectContaining({
      parentId: 'reliable',
      text: 'Child prompt',
    }))
  })

  it('persists paused and resumed status', async () => {
    const runner = createRunner({
      runId: 'run1',
      initialRun: { ...run, status: 'running' },
      initialCandidates: [{ ...parent }],
      ctx: { task, items, provider, config },
      send: vi.fn(),
    })

    await runner.pause()
    await runner.resume()

    expect(patchRun).toHaveBeenCalledWith('run1', { status: 'paused' })
    expect(patchRun).toHaveBeenCalledWith('run1', { status: 'running' })
  })

  it('fails the run when every sampled pair fails', async () => {
    vi.mocked(chatCompletionWithRetry).mockRejectedValue(new Error('provider down'))

    const send = vi.fn()
    await makeRunner(send).start()

    expect(patchRun).toHaveBeenCalledWith('run1', expect.objectContaining({
      status: 'failed',
      errorMessage: expect.stringContaining('all pairs failed'),
    }))
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ERROR',
      message: expect.stringContaining('all pairs failed'),
    }))
  })
})
