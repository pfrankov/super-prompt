import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatasetItem, PromptCandidate, ProviderConfig, Run, RunConfig, Task } from '../../src/lib/types'
import type { WorkerToMain } from '../../src/lib/optimizer/protocol'

vi.mock('../../src/lib/api/openaiLike', () => ({ chatCompletionWithRetry: vi.fn() }))
vi.mock('../../src/lib/db/runs', () => ({ addIteration: vi.fn(), addCandidate: vi.fn(), patchRun: vi.fn() }))
vi.mock('../../src/lib/optimizer/mutator', () => ({
  runMutator: vi.fn(),
  forceVariation: (text: string) => `${text}\nVariation`,
}))

const { chatCompletionWithRetry } = await import('../../src/lib/api/openaiLike')
const { addIteration } = await import('../../src/lib/db/runs')
const { runMutator } = await import('../../src/lib/optimizer/mutator')
const { comparePrompts, createRunner } = await import('../../src/worker/loop')

const config: RunConfig = {
  iterationsCap: 1, tokenBudget: 0, concurrency: 1, sampleSizePerIter: 2,
  earlyStopPlateau: 0, judgeTemperature: 0.2, targetTemperature: 0.7, mutatorTemperature: 0.7,
}
const task: Task = {
  id: 'task', name: 'Task', description: 'Do task', initialPrompt: 'Parent', seedPrompts: [],
  rubric: { text: 'Score it' }, datasetId: 'dataset', providerId: null, createdAt: 1, updatedAt: 1,
}
const provider: ProviderConfig = {
  id: 'provider', label: 'Provider', baseUrl: 'http://local', apiKey: '', targetModel: 'target',
  judgeModel: 'judge', requestTimeoutMs: 1000, maxRetries: 0,
}
const items: DatasetItem[] = [
  { id: 'one', datasetId: 'dataset', input: 'one' },
  { id: 'two', datasetId: 'dataset', input: 'two' },
]
const parent: PromptCandidate = {
  id: 'parent', runId: 'run', parentId: null, text: 'Parent', source: 'seed', score: null,
  wins: 0, losses: 0, ties: 0, iterations: 0, tokensIn: 0, tokensOut: 0, createdAt: 1,
}
const verdict = { winner: 'A', scoreA: 8, scoreB: 4, reasoning: 'A is better', feedbackA: 'Good', feedbackB: 'Improve' }
function response(text: string, promptTokens = 1, completionTokens = 1) {
  return { text, model: 'model', usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }, raw: {} }
}
function makeRunner(patch: Partial<RunConfig> = {}, send: (event: WorkerToMain) => void = () => {}) {
  const runConfig = { ...config, ...patch }
  const run: Run = {
    id: 'run', taskId: task.id, config: runConfig, status: 'idle', bestCandidateId: null,
    totalTokensIn: 0, totalTokensOut: 0, iterationCount: 0, startedAt: 1, finishedAt: null, errorMessage: null,
  }
  return createRunner({ runId: run.id, initialRun: run, initialCandidates: [{ ...parent }], ctx: { task, items, provider, config: runConfig }, send })
}
function mockJudgeTexts(texts: string[]) {
  let index = 0
  vi.mocked(chatCompletionWithRetry).mockImplementation(async (args) => args.model === 'target'
    ? response(args.messages[0].content, 3, 2)
    : response(texts[Math.min(index++, texts.length - 1)]))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runMutator).mockReset().mockResolvedValue({ newPrompt: 'Child', rationale: 'Improve', tokensIn: 1, tokensOut: 1 })
  mockJudgeTexts([JSON.stringify(verdict)])
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('comparison orientation', () => {
  it.each([false, true])('returns user-entered A/B labels when swapped=%s', async (swapped) => {
    vi.spyOn(Math, 'random').mockReturnValue(swapped ? 0 : 0.9)
    mockJudgeTexts([JSON.stringify(swapped ? {
      ...verdict, winner: 'B', scoreA: 4, scoreB: 8, feedbackA: 'Improve', feedbackB: 'Good',
    } : verdict)])
    const [result] = await comparePrompts({ task, items, provider, config }, 'Best', 'Worst', ['one'])
    expect(result).toMatchObject({
      outputA: 'Best', outputB: 'Worst', abSwapped: swapped,
      verdict: { winner: 'A', scoreA: 8, scoreB: 4, feedbackA: 'Good', feedbackB: 'Improve' },
    })
  })
})

describe('judge failures and usage', () => {
  it.each([
    'This is not a verdict',
    '{"scoreA":8,"scoreB":4}',
    '{"winner":"maybe","scoreA":8,"scoreB":4}',
    '{"winner":"A","scoreA":1e309,"scoreB":4}',
  ])('rejects invalid judging (%s), retaining diagnostics and consumed tokens', async (text) => {
    mockJudgeTexts([text])
    const runner = makeRunner()
    await runner.start()
    expect(runner.snapshot().run).toMatchObject({ status: 'failed', totalTokensIn: 15, totalTokensOut: 11 })
    expect(runner.snapshot().candidates[0]).toMatchObject({ score: null, ties: 0, iterations: 0 })
    expect(addIteration).toHaveBeenCalledWith(
      expect.objectContaining({ tokensIn: 15, tokensOut: 11 }),
      expect.arrayContaining([expect.objectContaining({ errorMessage: 'judge_parse_failed' })]),
    )
  })

  it('retains successful target usage when every pair has a failed target', async () => {
    let calls = 0
    vi.mocked(chatCompletionWithRetry).mockImplementation(async () => {
      if (calls++ % 2 === 0) throw new Error('target failed')
      return response('Output', 3, 2)
    })
    const runner = makeRunner()
    await runner.start()
    expect(chatCompletionWithRetry).toHaveBeenCalledTimes(4)
    expect(runner.snapshot().run).toMatchObject({ status: 'failed', totalTokensIn: 7, totalTokensOut: 5 })
    expect(addIteration).toHaveBeenCalledWith(
      expect.objectContaining({ tokensIn: 7, tokensOut: 5 }),
      expect.arrayContaining([expect.objectContaining({ errorMessage: expect.stringContaining('target failed') })]),
    )
  })

  it('excludes invalid judgments from mixed results while counting their usage', async () => {
    mockJudgeTexts(['not JSON', JSON.stringify(verdict)])
    const runner = makeRunner()
    await runner.start()
    const state = runner.snapshot()
    expect(state.run).toMatchObject({ status: 'completed', totalTokensIn: 15, totalTokensOut: 11 })
    expect(state.candidates.find((candidate) => candidate.id === 'parent')).toMatchObject({ score: 4, losses: 1, ties: 0, iterations: 1 })
    expect(state.candidates.find((candidate) => candidate.source === 'mutated')).toMatchObject({ score: 8, wins: 1, ties: 0, iterations: 1 })
  })

  it('stops at the iteration boundary when mutation usage exceeds the budget', async () => {
    vi.mocked(runMutator).mockResolvedValue({ newPrompt: 'Child', rationale: 'Improve', tokensIn: 1000, tokensOut: 100 })
    const runner = makeRunner({ iterationsCap: 2, tokenBudget: 1000 })
    await runner.start()
    expect(runMutator).toHaveBeenCalledTimes(1)
    expect(runner.snapshot().run).toMatchObject({ status: 'completed', iterationCount: 1, totalTokensIn: 1014, totalTokensOut: 110 })
    expect(runner.snapshot().history[0]).toMatchObject({ tokensIn: 1014, tokensOut: 110 })
  })

  it.each(['Child', 'Parent'])('counts both no-change mutation attempts before using %s', async (secondPrompt) => {
    vi.mocked(runMutator)
      .mockResolvedValueOnce({ newPrompt: 'Parent', rationale: 'No change', tokensIn: 5, tokensOut: 7 })
      .mockResolvedValueOnce({ newPrompt: secondPrompt, rationale: 'Retry', tokensIn: 5, tokensOut: 7 })
    const runner = makeRunner()
    await runner.start()
    const state = runner.snapshot()
    expect(runMutator).toHaveBeenCalledTimes(2)
    expect(state.run).toMatchObject({ totalTokensIn: 24, totalTokensOut: 24 })
    expect(state.history[0]).toMatchObject({ tokensIn: 24, tokensOut: 24 })
    expect(state.candidates.reduce((total, candidate) => total + candidate.tokensIn + candidate.tokensOut, 0)).toBe(48)
  })

  it('retains paid no-change mutation usage when the retry fails', async () => {
    vi.mocked(runMutator)
      .mockResolvedValueOnce({ newPrompt: 'Parent', rationale: 'No change', tokensIn: 5, tokensOut: 7 })
      .mockRejectedValueOnce(new Error('provider down'))
    const runner = makeRunner()
    await runner.start()
    expect(runner.snapshot().run).toMatchObject({ status: 'failed', totalTokensIn: 5, totalTokensOut: 7 })
  })
})

describe('runner controls', () => {
  it('does not begin another iteration after stopping during the pause wait', async () => {
    vi.useFakeTimers()
    let paused = false
    const runner = makeRunner({ iterationsCap: 3 }, (event) => {
      if (event.type === 'STATE' && event.state.run?.iterationCount === 1 && !paused) {
        paused = true
        void runner.pause()
      }
    })
    const running = runner.start()
    await vi.waitFor(() => expect(runner.snapshot().run?.iterationCount).toBe(1))
    await runner.stop()
    await vi.runAllTimersAsync()
    await running
    expect(runMutator).toHaveBeenCalledTimes(1)
    expect(runner.snapshot().run).toMatchObject({ status: 'stopped', iterationCount: 1 })
    expect(runner.snapshot().stage?.key).toBe('stopped')
  })

  it('keeps one runner paused while another starts and completes', async () => {
    vi.useFakeTimers()
    let paused = false
    const first = makeRunner({ iterationsCap: 3 }, (event) => {
      if (event.type === 'STATE' && event.state.run?.iterationCount === 1 && !paused) {
        paused = true
        void first.pause()
      }
    })
    const running = first.start()
    await vi.waitFor(() => expect(first.snapshot().run?.iterationCount).toBe(1))
    try {
      await makeRunner().start()
      await vi.advanceTimersByTimeAsync(200)
      expect(first.snapshot().run).toMatchObject({ status: 'paused', iterationCount: 1 })
    } finally {
      await first.stop()
      await vi.runAllTimersAsync()
      await running
    }
  })

  it('completes consistently if paused during the final iteration', async () => {
    let paused = false
    const runner = makeRunner({}, (event) => {
      if (event.type === 'STAGE' && event.stage.key === 'scoring' && !paused) {
        paused = true
        void runner.pause()
      }
    })
    await runner.start()
    expect(runner.snapshot().run).toMatchObject({ status: 'completed', iterationCount: 1 })
    expect(runner.snapshot().stage?.key).toBe('completed')
  })
})
