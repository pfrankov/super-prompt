import { describe, expect, it } from 'vitest'
import type { Run, RunConfig, RunStatus } from '../../src/lib/types'
import { shouldStopReloadedRun, stopReloadedRun } from '../../src/lib/improve/run-recovery'

const config: RunConfig = {
  iterationsCap: 3,
  tokenBudget: 0,
  concurrency: 1,
  sampleSizePerIter: 2,
  earlyStopPlateau: 2,
  judgeTemperature: 0.2,
  targetTemperature: 0.7,
  mutatorTemperature: 0.7,
}

function run(status: RunStatus): Run {
  return {
    id: 'run1',
    taskId: 'task1',
    config,
    status,
    bestCandidateId: null,
    totalTokensIn: 0,
    totalTokensOut: 0,
    iterationCount: 0,
    startedAt: 1,
    finishedAt: null,
    errorMessage: null,
  }
}

describe('run recovery after page reload', () => {
  it.each(['idle', 'running', 'paused'] as RunStatus[])('stops stale %s runs', (status) => {
    const stale = run(status)
    const recovered = stopReloadedRun(stale, 10, 'reloaded')

    expect(shouldStopReloadedRun(stale)).toBe(true)
    expect(recovered.status).toBe('stopped')
    expect(recovered.finishedAt).toBe(10)
    expect(recovered.errorMessage).toBe('reloaded')
  })

  it.each(['stopped', 'completed', 'failed'] as RunStatus[])('leaves terminal %s runs alone', (status) => {
    expect(shouldStopReloadedRun(run(status))).toBe(false)
  })

  it('keeps an existing run message when recovering', () => {
    const stale = { ...run('running'), errorMessage: 'provider failed' }

    expect(stopReloadedRun(stale, 10, 'reloaded').errorMessage).toBe('provider failed')
  })
})
