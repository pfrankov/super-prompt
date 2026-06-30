import type { Run, RunStatus } from '../types'

const reloadInterruptedStatuses = new Set<RunStatus>(['idle', 'running', 'paused'])

export function shouldStopReloadedRun(run: Run): boolean {
  return reloadInterruptedStatuses.has(run.status)
}

export function stopReloadedRun(run: Run, finishedAt: number, message: string): Run {
  return {
    ...run,
    status: 'stopped',
    finishedAt,
    errorMessage: run.errorMessage ?? message,
  }
}
