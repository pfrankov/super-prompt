/* ===========================================
   Super-Prompt — Type model (single source of truth)
   =========================================== */

export type Lang = 'en' | 'ru'

export interface JudgeRubric {
  text: string
}

export interface ProviderConfig {
  id: string
  label: string
  baseUrl: string
  apiKey: string
  targetModel: string
  judgeModel: string
  requestTimeoutMs: number
  maxRetries: number
}

/**
 * Optional override provider used by the judge (and the mutator, which always
 * reuses the judge's model). When `enabled` is false the main `provider` is
 * used for judging. When `enabled` is true the judge's URL/key/model come from
 * this object so users can route judge calls to a different endpoint (e.g.
 * a stronger reasoning model on a separate account).
 */
export interface ArbitratorConfig {
  enabled: boolean
  baseUrl: string
  apiKey: string
  model: string
}

export interface Task {
  id: string
  name: string
  description: string
  initialPrompt: string
  seedPrompts: string[]
  rubric: JudgeRubric
  datasetId: string | null
  providerId: string | null
  createdAt: number
  updatedAt: number
}

export interface DatasetItem {
  id: string
  datasetId: string
  input: string
  expectedOutput?: string
  meta?: Record<string, string>
}

export interface Dataset {
  id: string
  taskId: string
  name: string
  itemCount: number
  createdAt: number
}

export type CandidateSource = 'seed' | 'mutated'
export interface PromptCandidate {
  id: string
  runId: string
  parentId: string | null
  text: string
  source: CandidateSource
  score: number | null
  wins: number
  losses: number
  ties: number
  iterations: number
  tokensIn: number
  tokensOut: number
  rationale?: string
  createdAt: number
}

export type Winner = 'A' | 'B' | 'tie'

export interface JudgeVerdict {
  winner: Winner
  scoreA: number
  scoreB: number
  reasoning: string
  feedbackA: string
  feedbackB: string
}

export interface PairwiseResult {
  id: string
  iterationId: string
  itemId: string
  outputA: string
  outputB: string
  verdict: JudgeVerdict
  abSwapped: boolean
  tokensIn: number
  tokensOut: number
  latencyMs: number
  errorMessage?: string
}

export interface IterationRecord {
  id: string
  runId: string
  index: number
  parentCandidateId: string
  childCandidateId: string
  sampleItemIds: string[]
  aggregatedFeedback: string
  rationale?: string
  tokensIn: number
  tokensOut: number
  startedAt: number
  finishedAt: number
}

export interface RunConfig {
  iterationsCap: number
  tokenBudget: number
  concurrency: number
  sampleSizePerIter: number
  earlyStopPlateau: number
  judgeTemperature: number
  targetTemperature: number
  mutatorTemperature: number
}

export type RunStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'completed'
  | 'failed'

export interface Run {
  id: string
  taskId: string
  config: RunConfig
  status: RunStatus
  bestCandidateId: string | null
  totalTokensIn: number
  totalTokensOut: number
  iterationCount: number
  startedAt: number
  finishedAt: number | null
  errorMessage: string | null
}

export interface LogEntry {
  ts: number
  level: 'info' | 'warn' | 'error'
  msg: string
}

export type RunStageKey =
  | 'intake'
  | 'preflight'
  | 'starting'
  | 'selecting'
  | 'mutating'
  | 'sampling'
  | 'answering'
  | 'judging'
  | 'scoring'
  | 'persisting'
  | 'paused'
  | 'stopped'
  | 'completed'
  | 'failed'

export interface RunStage {
  key: RunStageKey
  iteration: number
  totalIterations: number
  sampleIndex?: number
  sampleCount?: number
  parentCandidateId?: string | null
  challengerCandidateId?: string | null
  parentScore?: number | null
  challengerScore?: number | null
  wins?: number
  losses?: number
  ties?: number
  failedPairs?: number
  changeSummary?: string
  updatedAt: number
}

export interface OptimizationState {
  run: Run | null
  candidates: PromptCandidate[]
  history: IterationRecord[]
  log: LogEntry[]
  stage: RunStage | null
}

export interface AppSettings {
  lang: Lang
  provider: ProviderConfig
  arbitrator: ArbitratorConfig
  judgeTemperature: number
  targetTemperature: number
  mutatorTemperature: number
  sampleSizePerIter: number
  concurrency: number
}
