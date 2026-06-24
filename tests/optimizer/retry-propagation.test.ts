import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '../../src/lib/types'

vi.mock('../../src/lib/api/openaiLike', () => ({
  chatCompletionWithRetry: vi.fn(),
}))

const { chatCompletionWithRetry } = await import('../../src/lib/api/openaiLike')
const { runJudge } = await import('../../src/lib/optimizer/judge')
const { runMutator } = await import('../../src/lib/optimizer/mutator')

const provider: ProviderConfig = {
  id: 'p1',
  label: 'Provider',
  baseUrl: 'http://local',
  apiKey: '',
  targetModel: 'target',
  judgeModel: 'judge',
  requestTimeoutMs: 1000,
  maxRetries: 7,
}

describe('optimizer retry propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes provider.maxRetries to judge calls', async () => {
    vi.mocked(chatCompletionWithRetry).mockResolvedValueOnce({
      text: JSON.stringify({
        winner: 'A',
        scoreA: 8,
        scoreB: 5,
        reasoning: 'A is better',
        feedbackA: '',
        feedbackB: 'missing detail',
      }),
      model: 'judge',
      usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
      raw: {},
    })

    await runJudge({
      provider,
      taskDescription: 'Task',
      rubric: 'Rubric',
      input: 'Input',
      outputA: 'A',
      outputB: 'B',
      temperature: 0.2,
    })

    expect(chatCompletionWithRetry).toHaveBeenCalledWith(expect.any(Object), provider.maxRetries)
  })

  it('passes provider.maxRetries to mutator calls', async () => {
    vi.mocked(chatCompletionWithRetry).mockResolvedValueOnce({
      text: JSON.stringify({ newPrompt: 'New prompt', rationale: 'clearer' }),
      model: 'judge',
      usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
      raw: {},
    })

    await runMutator({
      provider,
      taskDescription: 'Task',
      rubric: 'Rubric',
      parentText: 'Parent',
      parentScore: 5,
      childScore: null,
      aggregatedFeedback: 'Improve clarity',
      temperature: 0.7,
    })

    expect(chatCompletionWithRetry).toHaveBeenCalledWith(expect.any(Object), provider.maxRetries)
  })
})
