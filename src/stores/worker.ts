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

export function resetComparison(): void {
  comparisonState.set({ running: false, results: null, error: '' })
}

let worker: Worker | null = null
let runActive = false
let settingsSyncTimer: number | undefined

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../worker/optimizer.worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = onWorkerMessage
    worker.onerror = (e) => {
      console.error('[worker]', e)
    }
  }
  return worker
}

function onWorkerMessage(e: MessageEvent<WorkerToMain>) {
  const msg = e.data
  switch (msg.type) {
    case 'STATE':
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
    case 'ERROR':
      runActive = false
      optimizationState.update((s) => ({
        ...s,
        run: s.run
          ? { ...s.run, status: 'failed', errorMessage: msg.message }
          : s.run,
        stage: {
          key: 'failed',
          iteration: s.stage?.iteration ?? s.run?.iterationCount ?? 0,
          totalIterations: s.stage?.totalIterations ?? s.run?.config.iterationsCap ?? 0,
          changeSummary: msg.message,
          updatedAt: Date.now(),
        },
      }))
      break
    case 'DONE':
      runActive = false
      break
    case 'COMPARE_RESULT':
      comparisonState.set({ running: false, results: msg.results, error: '' })
      break
    case 'COMPARE_ERROR':
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
    if (!run) return
    worker!.postMessage({
      type: 'UPDATE_SETTINGS',
      payload: { provider: s.provider, arbitrator: s.arbitrator, config: run.config },
    } satisfies MainToWorker)
  }, 300)
})

export function start(runId: string): void {
  runActive = true
  ensureWorker().postMessage({ type: 'START', payload: { runId } } satisfies MainToWorker)
}

export function pause(): void {
  ensureWorker().postMessage({ type: 'PAUSE' } satisfies MainToWorker)
}

export function resume(): void {
  ensureWorker().postMessage({ type: 'RESUME' } satisfies MainToWorker)
}

export function stop(): void {
  runActive = false
  ensureWorker().postMessage({ type: 'STOP' } satisfies MainToWorker)
}

export function compareAB(
  taskId: string,
  promptA: string,
  promptB: string,
  itemIds: string[],
  config: RunConfig
): void {
  comparisonState.set({ running: true, results: null, error: '' })
  try {
    ensureWorker().postMessage({
      type: 'COMPARE_AB',
      payload: {
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
  runActive = false
  optimizationState.set({ run: null, candidates: [], history: [], log: [], stage: null })
  resetComparison()
}
