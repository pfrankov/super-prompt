import type { OptimizationState, ProviderConfig, ArbitratorConfig, RunConfig, PairwiseResult, RunStage } from '../types'

export type CompareResult = Omit<PairwiseResult, 'id' | 'iterationId'>[]

export type MainToWorker =
  | { type: 'START'; payload: { runId: string } }
  | { type: 'PAUSE'; payload?: { runId?: string } }
  | { type: 'RESUME'; payload?: { runId?: string } }
  | { type: 'STOP'; payload?: { runId?: string } }
  | { type: 'COMPARE_AB'; payload: { taskId: string; promptA: string; promptB: string; itemIds: string[]; config: RunConfig } }
  | { type: 'GET_STATE' }
  | { type: 'UPDATE_SETTINGS'; payload: { provider: ProviderConfig; arbitrator?: ArbitratorConfig; config: RunConfig } }

export type WorkerToMain =
  | { type: 'STATE'; state: OptimizationState }
  | { type: 'STAGE'; stage: RunStage }
  | { type: 'PROGRESS'; progress: { iter: number; bestScore: number; tokensIn: number; tokensOut: number; etaMs: number } }
  | { type: 'LOG'; entry: { ts: number; level: 'info' | 'warn' | 'error'; msg: string } }
  | { type: 'COMPARE_RESULT'; results: CompareResult }
  | { type: 'COMPARE_ERROR'; message: string; stack?: string }
  | { type: 'ERROR'; message: string; stack?: string }
  | { type: 'DONE'; finalCandidateId: string | null }
