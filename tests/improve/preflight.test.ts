import { describe, expect, it, vi } from 'vitest'
import { nextPreflightAction, preflightReady, runPreflight, type PreflightStep } from '../../src/lib/improve/preflight'

describe('preflight status mapping', () => {
  it('is ready when there are no failing steps', () => {
    const steps: PreflightStep[] = [
      { key: 'provider', status: 'ok', message: 'ok', action: '' },
      { key: 'judgeJson', status: 'warn', message: 'fallback', action: 'Pick a stronger judge.' },
    ]
    expect(preflightReady(steps)).toBe(true)
    expect(nextPreflightAction(steps)).toBe('Pick a stronger judge.')
  })

  it('blocks on the first failing step action', () => {
    const steps: PreflightStep[] = [
      { key: 'provider', status: 'ok', message: 'ok', action: '' },
      { key: 'target', status: 'fail', message: 'empty', action: 'Choose another target.' },
      { key: 'judgeJson', status: 'warn', message: 'fallback', action: 'Pick a stronger judge.' },
    ]
    expect(preflightReady(steps)).toBe(false)
    expect(nextPreflightAction(steps)).toBe('Choose another target.')
  })

  it('surfaces rate-limit details as the next action', () => {
    const steps: PreflightStep[] = [
      { key: 'provider', status: 'ok', message: 'ok', action: '' },
      {
        key: 'target',
        status: 'fail',
        message: 'Rate limited: google/gemma via Google AI Studio. Retry in about 60s or switch this role to another model.',
        action: 'Choose another target.',
      },
    ]
    expect(nextPreflightAction(steps)).toContain('Google AI Studio')
  })

  it('does not request a provider model list', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).not.toContain('/models')
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content: string }> }
      const system = body.messages?.find((m) => m.role === 'system')?.content ?? ''
      const content = /impartial expert judge/i.test(system)
        ? JSON.stringify({ winner: 'A', scoreA: 8, scoreB: 4 })
        : /meticulous prompt engineer/i.test(system)
          ? JSON.stringify({ newPrompt: 'Improved prompt.' })
          : 'ok'
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    global.fetch = fetchMock as typeof fetch

    const result = await runPreflight({
      provider: {
        id: 'p',
        label: 'Provider',
        baseUrl: 'https://provider.test/v1',
        apiKey: 'sk-test',
        targetModel: 'target',
        judgeModel: 'judge',
        requestTimeoutMs: 1000,
        maxRetries: 0,
      },
      task: {
        id: 't',
        name: 'Task',
        description: 'Test task.',
        initialPrompt: 'Answer briefly.',
        seedPrompts: [],
        rubric: { text: 'Return useful answers.' },
        datasetId: 'd',
        providerId: null,
        createdAt: 0,
        updatedAt: 0,
      },
      items: [{ id: 'i', datasetId: 'd', input: 'Hello', expectedOutput: 'Hi' }],
    })

    expect(result.ready).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith('/chat/completions'))).toBe(true)
  })
})
