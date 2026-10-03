import { writable, get } from 'svelte/store'
import type {
  OptimizationState,
  RunConfig,
} from '../lib/types'
import type {
  CompareResult,
  MainToWorker,
  WorkerToMain,
} from '../lib/optimizer/protocol'
import { settings } from './settings'
import { patchRun } from '../lib/db/runs'

export const optimizationState = writable<OptimizationState>({
  run: null,
  candidates: [],
  history: [],
  log: [],
  stage: null,
})

export const comparisonState = writable<{
  running: boolean
  results: CompareResult | null
  error: string
}>({
  running: false,
  results: null,
  error: '',
})

let comparisonRequestId = 0

export function resetComparison(): void {
  comparisonRequestId++
  worker?.postMessage({ type: 'CANCEL_COMPARE' } satisfies MainToWorker)
  comparisonState.set({ running: false, results: null, error: '' })
}

let worker: Worker | null = null
export const activeRunId = writable<string | null>(null)
let runActive = false
let settingsSyncTimer: number | undefined

function disposeWorker(): void {
  worker?.terminate()
  worker = null
  if (settingsSyncTimer) clearTimeout(settingsSyncTimer)
  settingsSyncTimer = undefined
}

function failRunState(runId: string, message: string, finishedAt: number): void {
  runActive = false
  optimizationState.update((s) => {
    if (s.run && s.run.id !== runId) return s
    return {
      ...s,
      run: s.run ? { ...s.run, status: 'failed', finishedAt, errorMessage: message } : s.run,
      stage: {
        key: 'failed',
        iteration: s.stage?.iteration ?? s.run?.iterationCount ?? 0,
        totalIterations: s.stage?.totalIterations ?? s.run?.config.iterationsCap ?? 0,
        changeSummary: message,
        updatedAt: finishedAt,
      },
    }
  })
  if (get(activeRunId) === runId) activeRunId.set(null)
}

function ensureWorker(): Worker {
  if (!worker) {
    const currentWorker = new Worker(new URL('../worker/optimizer.worker.ts', import.meta.url), {
      type: 'module',
    })
    worker = currentWorker
    currentWorker.onmessage = (e) => {
      if (worker === currentWorker) onWorkerMessage(e)
    }
    currentWorker.onerror = async (e) => {
      if (worker !== currentWorker) return
      const runId = get(activeRunId)
      const message = e.message || 'Worker failed'
      const finishedAt = Date.now()
      console.error('[worker]', e)
      runActive = false
      disposeWorker()
      if (get(comparisonState).running) comparisonState.set({ running: false, results: null, error: message })
      if (!runId) return
      try {
        // Keep ownership until the terminated worker's run is durably terminal.
        await patchRun(runId, { status: 'failed', finishedAt, errorMessage: message })
      } catch (error) {
        console.error('[worker] Could not save failed run', error)
        if (get(activeRunId) !== runId) return
        const persistenceMessage = `${message}; could not save run status: ${error instanceof Error ? error.message : String(error)}. Reload to retry recovery.`
        optimizationState.update((s) => s.run?.id === runId ? {
          ...s,
          run: { ...s.run, errorMessage: persistenceMessage },
        } : s)
        return
      }
      if (get(activeRunId) === runId) failRunState(runId, message, finishedAt)
    }
  }
  return worker
}

function onWorkerMessage(e: MessageEvent<WorkerToMain>) {
  const msg = e.data
  switch (msg.type) {
    case 'STATE':
      if (get(activeRunId) && msg.state.run?.id !== get(activeRunId)) break
      optimizationState.set(msg.state)
      break
    case 'STAGE':
      optimizationState.update((s) => ({
        ...s,
        stage: msg.stage,
      }))
      break
    case 'PROGRESS':
      optimizationState.update((s) => ({
        ...s,
        run: s.run
          ? {
              ...s.run,
              iterationCount: msg.progress.iter,
              totalTokensIn: msg.progress.tokensIn,
              totalTokensOut: msg.progress.tokensOut,
            }
          : s.run,
      }))
      break
    case 'LOG':
      optimizationState.update((s) => ({
        ...s,
        log: [...s.log, msg.entry].slice(-200),
      }))
      break
    case 'CONTROL_ERROR':
      if (get(activeRunId) !== msg.runId) break
      optimizationState.update((s) => s.run?.id === msg.runId ? {
        ...s, run: { ...s.run, errorMessage: msg.message },
      } : s)
      break
    case 'ERROR': {
      const runId = get(activeRunId)
      if (runId) failRunState(runId, msg.message, Date.now())
      break
    }
    case 'DONE':
      runActive = false
      activeRunId.set(null)
      break
    case 'COMPARE_RESULT':
      if (msg.requestId !== comparisonRequestId) break
      comparisonState.set({ running: false, results: msg.results, error: '' })
      break
    case 'COMPARE_ERROR':
      if (msg.requestId !== comparisonRequestId) break
      comparisonState.set({ running: false, results: null, error: msg.message })
      break
  }
}

// Forward live settings changes to the worker (debounced — typing in the
// API key field would otherwise spam messages). Only the provider is forwarded
// — the run config is baked into the run record at start time.
settings.subscribe((s) => {
  if (!runActive || !worker) return
  if (settingsSyncTimer) clearTimeout(settingsSyncTimer)
  settingsSyncTimer = window.setTimeout(() => {
    const run = get(optimizationState).run
    if (!run || !runActive || !worker) return
    worker!.postMessage({
      type: 'UPDATE_SETTINGS',
      payload: { provider: s.provider, arbitrator: s.arbitrator, config: run.config },
    } satisfies MainToWorker)
  }, 300)
})

export function start(runId: string): void {
  if (get(activeRunId)) return
  activeRunId.set(runId)
  runActive = true
  try {
    ensureWorker().postMessage({ type: 'START', payload: { runId } } satisfies MainToWorker)
  } catch (error) {
    runActive = false
    activeRunId.set(null)
    disposeWorker()
    throw error
  }
}

export function pause(runId?: string): void {
  ensureWorker().postMessage({
    type: 'PAUSE',
    payload: runId ? { runId } : undefined,
  } satisfies MainToWorker)
}

export function resume(runId?: string): void {
  ensureWorker().postMessage({
    type: 'RESUME',
    payload: runId ? { runId } : undefined,
  } satisfies MainToWorker)
}

export function stop(runId?: string): void {
  ensureWorker().postMessage({
    type: 'STOP',
    payload: runId ? { runId } : undefined,
  } satisfies MainToWorker)
}

export function compareAB(
  taskId: string,
  promptA: string,
  promptB: string,
  itemIds: string[],
  config: RunConfig
): void {
  const requestId = ++comparisonRequestId
  comparisonState.set({ running: true, results: null, error: '' })
  try {
    ensureWorker().postMessage({
      type: 'COMPARE_AB',
      payload: {
        requestId,
        taskId,
        promptA,
        promptB,
        itemIds: [...itemIds],
        config: { ...config },
      },
    } satisfies MainToWorker)
  } catch (err) {
    comparisonState.set({
      running: false,
      results: null,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function getState(): void {
  ensureWorker().postMessage({ type: 'GET_STATE' } satisfies MainToWorker)
}

/** Reset state — used when navigating away from a task. */
export function reset(): void {
  optimizationState.set({ run: null, candidates: [], history: [], log: [], stage: null })
  resetComparison()
}
