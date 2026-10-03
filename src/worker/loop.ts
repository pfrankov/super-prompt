import type {
  Task,
  DatasetItem,
  ProviderConfig,
  ArbitratorConfig,
  PromptCandidate,
  IterationRecord,
  PairwiseResult,
  JudgeVerdict,
  Run,
  OptimizationState,
  LogEntry,
  RunConfig,
  RunStage,
  RunStageKey,
} from '../lib/types'
import { runJudge } from '../lib/optimizer/judge'
import { runMutator, forceVariation } from '../lib/optimizer/mutator'
import { pool } from '../lib/optimizer/pool'
import { mulberry32, sample } from '../lib/optimizer/sampling'
import { chatCompletionWithRetry } from '../lib/api/openaiLike'
import { addIteration, addCandidate, patchRun } from '../lib/db/runs'
import { newId } from '../lib/util/id'
import type { CompareResult, MainToWorker, WorkerToMain } from '../lib/optimizer/protocol'
import { throttle } from '../lib/util/throttle'

export interface Ctx {
  signal?: AbortSignal
  task: Task
  items: DatasetItem[]
  provider: ProviderConfig
  arbitrator?: ArbitratorConfig
  config: RunConfig
}

type Send = (msg: WorkerToMain) => void

interface PairOutcome {
  outputA: string
  outputB: string
  abSwapped: boolean
  verdict: JudgeVerdict
  tokensIn: number
  tokensOut: number
  latencyMs: number
  failed: boolean
  cancelled?: boolean
  errorMessage?: string
}

async function runTarget(provider: ProviderConfig, systemPrompt: string, input: string, temperature: number, signal?: AbortSignal): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  const resp = await chatCompletionWithRetry({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.targetModel,
    signal,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: input },
    ],
    temperature,
    timeoutMs: provider.requestTimeoutMs,
    rateLimits: provider.modelRateLimits,
  }, provider.maxRetries)
  return { text: resp.text, tokensIn: resp.usage.promptTokens, tokensOut: resp.usage.completionTokens }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function failureVerdict(reasoning: string): JudgeVerdict {
  return { winner: 'tie', scoreA: 5, scoreB: 5, reasoning, feedbackA: '', feedbackB: '' }
}

function compactFailureReasons(outcomes: PairOutcome[], max = 600): string {
  const reasons = [...new Set(outcomes.map((o) => o.errorMessage).filter((msg): msg is string => !!msg))]
  const text = reasons.join('; ')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

async function runOnePair(
  parent: PromptCandidate,
  challenger: PromptCandidate,
  item: DatasetItem,
  abSwapped: boolean,
  ctx: Ctx,
  onPhase?: (phase: 'answering' | 'judging') => void
): Promise<PairOutcome> {
  const orderA = abSwapped ? challenger : parent
  const orderB = abSwapped ? parent : challenger
  const t0 = Date.now()
  let tokensIn = 0
  let tokensOut = 0
  let outputA = ''
  let outputB = ''
  function cancelled(): PairOutcome {
    return {
      outputA, outputB, abSwapped,
      verdict: failureVerdict('cancelled'),
      tokensIn, tokensOut,
      latencyMs: Date.now() - t0,
      failed: false,
      cancelled: true,
    }
  }
  if (ctx.signal?.aborted) return cancelled()
  onPhase?.('answering')
  const [rAResult, rBResult] = await Promise.allSettled([
    runTarget(ctx.provider, orderA.text, item.input, ctx.config.targetTemperature, ctx.signal),
    runTarget(ctx.provider, orderB.text, item.input, ctx.config.targetTemperature, ctx.signal),
  ])

  if (rAResult.status === 'fulfilled') {
    tokensIn += rAResult.value.tokensIn
    tokensOut += rAResult.value.tokensOut
  }
  if (rBResult.status === 'fulfilled') {
    tokensIn += rBResult.value.tokensIn
    tokensOut += rBResult.value.tokensOut
  }

  outputA = rAResult.status === 'fulfilled' ? rAResult.value.text : ''
  outputB = rBResult.status === 'fulfilled' ? rBResult.value.text : ''
  if (ctx.signal?.aborted) return cancelled()
  if (rAResult.status === 'rejected' || rBResult.status === 'rejected') {
    const parts: string[] = []
    if (rAResult.status === 'rejected') parts.push(`target_a_failed: ${errorMessage(rAResult.reason)}`)
    if (rBResult.status === 'rejected') parts.push(`target_b_failed: ${errorMessage(rBResult.reason)}`)
    return {
      outputA,
      outputB,
      abSwapped,
      verdict: failureVerdict(parts.join('; ')),
      tokensIn,
      tokensOut,
      latencyMs: Date.now() - t0,
      failed: true,
      errorMessage: parts.join('; '),
    }
  }

  try {
    onPhase?.('judging')
    const jRes = await runJudge(
      {
        provider: ctx.provider,
        arbitrator: ctx.arbitrator,
        taskDescription: ctx.task.description,
        rubric: ctx.task.rubric.text,
        input: item.input,
        outputA,
        outputB,
        expectedOutput: item.expectedOutput,
        temperature: ctx.config.judgeTemperature,
        signal: ctx.signal,
      }
    )
    tokensIn += jRes.tokensIn
    tokensOut += jRes.tokensOut
    return {
      outputA,
      outputB,
      abSwapped,
      verdict: jRes.verdict,
      tokensIn,
      tokensOut,
      latencyMs: Date.now() - t0,
      failed: !!jRes.errorMessage,
      errorMessage: jRes.errorMessage,
    }
  } catch (e) {
    if (ctx.signal?.aborted) return cancelled()
    const msg = `judge_failed: ${errorMessage(e)}`
    return {
      outputA,
      outputB,
      abSwapped,
      verdict: failureVerdict(msg),
      tokensIn,
      tokensOut,
      latencyMs: Date.now() - t0,
      failed: true,
      errorMessage: msg,
    }
  }
}

export async function comparePrompts(ctx: Ctx, promptA: string, promptB: string, itemIds: string[]): Promise<CompareResult> {
  const selectedIds = new Set(itemIds)
  const items = selectedIds.size
    ? ctx.items.filter((it) => selectedIds.has(it.id))
    : ctx.items
  if (items.length === 0) throw new Error('no dataset items selected')
  const outcomes = await pool(items, ctx.config.concurrency, async (item) => {
    ctx.signal?.throwIfAborted()
    const swap = Math.random() < 0.5
    const candA: PromptCandidate = { id: 'A', runId: 'compare', parentId: null, text: promptA, source: 'seed', score: null, wins: 0, losses: 0, ties: 0, iterations: 0, tokensIn: 0, tokensOut: 0, createdAt: 0 }
    const candB: PromptCandidate = { id: 'B', runId: 'compare', parentId: null, text: promptB, source: 'seed', score: null, wins: 0, losses: 0, ties: 0, iterations: 0, tokensIn: 0, tokensOut: 0, createdAt: 0 }
    return runOnePair(candA, candB, item, swap, ctx)
  })
  ctx.signal?.throwIfAborted()
  if (outcomes.every((o) => o.failed)) {
    throw new Error(outcomes[0]?.errorMessage ?? 'all comparison pairs failed')
  }
  // Structured fields use the user's A/B labels; abSwapped records the judge's order.
  return outcomes.map((o, i) => ({
    itemId: items[i].id,
    outputA: o.abSwapped ? o.outputB : o.outputA,
    outputB: o.abSwapped ? o.outputA : o.outputB,
    verdict: o.abSwapped ? {
      ...o.verdict,
      winner: o.verdict.winner === 'A' ? 'B' : o.verdict.winner === 'B' ? 'A' : 'tie',
      scoreA: o.verdict.scoreB,
      scoreB: o.verdict.scoreA,
      feedbackA: o.verdict.feedbackB,
      feedbackB: o.verdict.feedbackA,
    } : o.verdict,
    abSwapped: o.abSwapped,
    tokensIn: o.tokensIn,
    tokensOut: o.tokensOut,
    latencyMs: o.latencyMs,
    errorMessage: o.errorMessage,
  }))
}

export function createRunner(opts: {
  runId: string
  initialRun: Run
  initialCandidates: PromptCandidate[]
  ctx: Ctx
  send: Send
}) {
  const { runId, send } = opts
  let stopRequested = false
  let pauseRequested = false
  let terminalPersisted: Run['status'] | null = null
  let terminalFailure: string | null = null
  let statusWrite: Promise<void> = Promise.resolve()
  const abortController = new AbortController()
  const ctx: Ctx = { ...opts.ctx, signal: abortController.signal }
  let run: Run = opts.initialRun
  let candidates: PromptCandidate[] = [...opts.initialCandidates]
  let history: IterationRecord[] = []
  let log: LogEntry[] = []
  let stage: RunStage | null = null
  let plateauCount = 0
  let lastBestScore: number | null = bestScore(candidates)
  let lastFeedback = ''
  const feedbackByCandidateId = new Map<string, string>()

  function bestScore(c: PromptCandidate[]): number | null {
    let best: number | null = null
    for (const x of c) {
      if (x.score != null && (best == null || x.score > best)) best = x.score
    }
    return best
  }

  function emitLog(level: LogEntry['level'], msg: string) {
    const entry: LogEntry = { ts: Date.now(), level, msg }
    log = [...log, entry].slice(-200)
    send({ type: 'LOG', entry })
  }

  function snapshot(): OptimizationState {
    return { run, candidates, history, log, stage }
  }

  function emitState() {
    send({ type: 'STATE', state: snapshot() })
  }

  function emitStage(key: RunStageKey, patch: Partial<Omit<RunStage, 'key' | 'updatedAt'>> = {}) {
    stage = {
      key,
      iteration: patch.iteration ?? run.iterationCount,
      totalIterations: patch.totalIterations ?? ctx.config.iterationsCap,
      updatedAt: Date.now(),
      ...patch,
    }
    send({ type: 'STAGE', stage })
  }

  const emitProgress = throttle(() => {
    const itersDone = run.iterationCount
    const tokensTotal = run.totalTokensIn + run.totalTokensOut
    const tokensPerIter = itersDone > 0 ? tokensTotal / itersDone : 2000
    const remaining = Math.max(0, ctx.config.iterationsCap - itersDone)
    const etaMs = remaining * (tokensPerIter / Math.max(1, ctx.config.concurrency)) * 1.5
    const bs = bestScore(candidates) ?? 0
    send({
      type: 'PROGRESS',
      progress: {
        iter: itersDone,
        bestScore: bs,
        tokensIn: run.totalTokensIn,
        tokensOut: run.totalTokensOut,
        etaMs,
      },
    })
  }, 200)

  function candidateTrials(c: PromptCandidate): number {
    return Math.max(1, c.iterations || c.wins + c.losses + c.ties || 0)
  }

  function winRate(c: PromptCandidate): number {
    const total = c.wins + c.losses + c.ties
    if (total === 0) return 0.5
    return (c.wins + c.ties * 0.5) / total
  }

  function normalizedScore(c: PromptCandidate): number {
    return Math.max(0, Math.min(1, (c.score ?? 0) / 10))
  }

  function candidateQuality(c: PromptCandidate): number {
    return normalizedScore(c) * 0.8 + winRate(c) * 0.2
  }

  function isDominated(candidate: PromptCandidate, other: PromptCandidate): boolean {
    if (candidate.id === other.id) return false
    const scoreDelta = normalizedScore(other) - normalizedScore(candidate)
    const winRateDelta = winRate(other) - winRate(candidate)
    return scoreDelta >= 0 && winRateDelta >= 0 && (scoreDelta > 0.02 || winRateDelta > 0.02)
  }

  function paretoFrontier(scored: PromptCandidate[]): PromptCandidate[] {
    const frontier = scored.filter((c) => !scored.some((other) => isDominated(c, other)))
    return frontier.length ? frontier : scored
  }

  function parentUtility(c: PromptCandidate, totalTrials: number): number {
    const exploration = Math.sqrt((2 * Math.log(totalTrials + 1)) / candidateTrials(c))
    return candidateQuality(c) + 0.65 * exploration
  }

  function pickParent(): PromptCandidate {
    const scored = candidates.filter((c) => c.score != null)
    if (scored.length === 0) return candidates[0]
    const frontier = paretoFrontier(scored)
    const totalTrials = frontier.reduce((sum, c) => sum + candidateTrials(c), 0)
    return frontier.reduce((best, c) => {
      const delta = parentUtility(c, totalTrials) - parentUtility(best, totalTrials)
      if (delta > 0.0001) return c
      if (Math.abs(delta) <= 0.0001 && candidateQuality(c) > candidateQuality(best)) return c
      return best
    })
  }

  function pickUnevaluatedSeed(parentId: string): PromptCandidate | null {
    return candidates.find((c) => c.source === 'seed' && c.id !== parentId && c.score == null) ?? null
  }

  function feedbackForMutation(parent: PromptCandidate): string {
    const candidateFeedback = feedbackByCandidateId.get(parent.id)
    if (candidateFeedback) return candidateFeedback
    if (lastFeedback) return `Recent judge feedback from nearby comparisons:\n${lastFeedback}`
    return 'No prior feedback yet. Create a meaningfully stronger variant.'
  }

  async function recordUsage(tokensIn: number, tokensOut: number) {
    run = {
      ...run,
      totalTokensIn: run.totalTokensIn + tokensIn,
      totalTokensOut: run.totalTokensOut + tokensOut,
    }
    await patchRun(run.id, { totalTokensIn: run.totalTokensIn, totalTokensOut: run.totalTokensOut })
  }

  async function persistStatus() {
    const status = run.status
    const patch: Partial<Run> = { status, finishedAt: run.finishedAt, errorMessage: run.errorMessage }
    if (status === 'failed') {
      // A preceding usage write may be the failure that brought us here.
      patch.totalTokensIn = run.totalTokensIn
      patch.totalTokensOut = run.totalTokensOut
    }
    // A pending Stop write must settle before a later failure can replace it.
    const pending = statusWrite.catch(() => {}).then(() => patchRun(run.id, patch))
    statusWrite = pending
    try {
      await pending
      terminalPersisted = status === 'stopped' || status === 'completed' || status === 'failed' ? status : null
      if (run.status === status) run = { ...run, errorMessage: patch.errorMessage ?? null }
    } catch (e) {
      const failure = terminalFailure ? `${terminalFailure}; ` : ''
      run = { ...run, errorMessage: `${failure}Could not save ${status} run: ${errorMessage(e)}. Reload to retry recovery.` }
      emitLog('error', run.errorMessage!)
      throw e
    }
  }

  async function persistTerminalStatus(): Promise<boolean> {
    run = { ...run, errorMessage: run.status === 'failed' ? terminalFailure : null }
    if (terminalPersisted === run.status) return true
    try {
      await persistStatus()
      return true
    } catch (e) {
      emitState()
      send({ type: 'CONTROL_ERROR', runId: run.id, message: run.errorMessage!, stack: e instanceof Error ? e.stack : undefined })
      return false
    }
  }

  async function mutateWithRetry(parent: PromptCandidate, feedback: string, parentScore: number | null, childScore: number | null): Promise<{ text: string; rationale: string; tokensIn: number; tokensOut: number }> {
    let tokensIn = 0
    let tokensOut = 0
    for (const t of [ctx.config.mutatorTemperature, 0.9]) {
      const r = await runMutator({
        provider: ctx.provider,
        arbitrator: ctx.arbitrator,
        taskDescription: ctx.task.description,
        rubric: ctx.task.rubric.text,
        parentText: parent.text,
        parentScore,
        childScore,
        aggregatedFeedback: feedback,
        signal: ctx.signal,
        temperature: t,
      })
      tokensIn += r.tokensIn
      tokensOut += r.tokensOut
      await recordUsage(r.tokensIn, r.tokensOut)
      if (r.newPrompt && r.newPrompt !== parent.text) {
        return { text: r.newPrompt, rationale: r.rationale, tokensIn, tokensOut }
      }
    }
    return { text: forceVariation(parent.text), rationale: 'forced_variation', tokensIn, tokensOut }
  }

  async function createChallenger(parent: PromptCandidate): Promise<PromptCandidate> {
    const seed = pickUnevaluatedSeed(parent.id)
    if (seed) {
      emitStage('mutating', {
        iteration: run.iterationCount + 1,
        parentCandidateId: parent.id,
        challengerCandidateId: seed.id,
        parentScore: parent.score,
        challengerScore: seed.score,
        changeSummary: 'Using an unevaluated seed prompt before creating new mutations.',
      })
      return seed
    }
    emitStage('mutating', {
      iteration: run.iterationCount + 1,
      parentCandidateId: parent.id,
      parentScore: parent.score,
      changeSummary: feedbackForMutation(parent),
    })
    const m = await mutateWithRetry(parent, feedbackForMutation(parent), parent.score, null)
    const challenger: PromptCandidate = {
      id: newId(),
      runId: run.id,
      parentId: parent.id,
      text: m.text,
      source: 'mutated',
      score: null,
      wins: 0,
      losses: 0,
      ties: 0,
      iterations: 0,
      tokensIn: m.tokensIn,
      tokensOut: m.tokensOut,
      rationale: m.rationale,
      createdAt: Date.now(),
    }
    await addCandidate(challenger)
    emitStage('mutating', {
      iteration: run.iterationCount + 1,
      parentCandidateId: parent.id,
      challengerCandidateId: challenger.id,
      parentScore: parent.score,
      challengerScore: null,
      changeSummary: m.rationale,
    })
    return challenger
  }

  async function runIteration(iterIndex: number) {
    const startedAt = Date.now()
    const parent = pickParent()
    emitStage('selecting', {
      iteration: iterIndex + 1,
      parentCandidateId: parent.id,
      parentScore: parent.score,
    })
    const challenger = await createChallenger(parent)
    const mutationTokensIn = challenger.source === 'mutated' ? challenger.tokensIn : 0
    const mutationTokensOut = challenger.source === 'mutated' ? challenger.tokensOut : 0
    emitLog('info', `iter ${iterIndex}: parent=${parent.id.slice(0, 6)} (s=${parent.score?.toFixed(2) ?? 'n/a'}) vs challenger=${challenger.id.slice(0, 6)} (s=${challenger.score?.toFixed(2) ?? 'n/a'})`)

    const rng = mulberry32(iterIndex * 1009 + 17)
    const sampleItems = sample(ctx.items, Math.min(ctx.config.sampleSizePerIter, ctx.items.length), rng)
    emitStage('sampling', {
      iteration: iterIndex + 1,
      sampleCount: sampleItems.length,
      parentCandidateId: parent.id,
      challengerCandidateId: challenger.id,
      parentScore: parent.score,
      challengerScore: challenger.score,
    })
    let answerStarted = 0
    let judgeStarted = 0
    const outcomes = await pool(sampleItems, ctx.config.concurrency, async (item) => {
      const swap = rng() < 0.5
      return runOnePair(parent, challenger, item, swap, ctx, (phase) => {
        if (phase === 'answering') {
          answerStarted++
          emitStage('answering', {
            iteration: iterIndex + 1,
            sampleIndex: answerStarted,
            sampleCount: sampleItems.length,
            parentCandidateId: parent.id,
            challengerCandidateId: challenger.id,
            parentScore: parent.score,
            challengerScore: challenger.score,
          })
        } else {
          judgeStarted++
          emitStage('judging', {
            iteration: iterIndex + 1,
            sampleIndex: judgeStarted,
            sampleCount: sampleItems.length,
            parentCandidateId: parent.id,
            challengerCandidateId: challenger.id,
            parentScore: parent.score,
            challengerScore: challenger.score,
          })
        }
      })
    })

    // Completed failures remain diagnostics; cancelled pairs are not evidence.
    // Returned usage still counts, including calls completed before cancellation.
    let sumScoreParent = 0
    let sumScoreChild = 0
    let wins = 0, losses = 0, ties = 0
    let parentTokensIn = 0, parentTokensOut = 0, childTokensIn = 0, childTokensOut = 0
    const parentFeedbackParts: string[] = []
    const childFeedbackParts: string[] = []
    const pairs: PairwiseResult[] = []

    for (let i = 0; i < outcomes.length; i++) {
      const o = outcomes[i]
      parentTokensIn += Math.round(o.tokensIn / 2)
      parentTokensOut += Math.round(o.tokensOut / 2)
      childTokensIn += o.tokensIn - Math.round(o.tokensIn / 2)
      childTokensOut += o.tokensOut - Math.round(o.tokensOut / 2)
      if (o.cancelled) continue

      if (!o.failed) {
        const parentWon = o.abSwapped ? o.verdict.winner === 'B' : o.verdict.winner === 'A'
        const childWon = o.abSwapped ? o.verdict.winner === 'A' : o.verdict.winner === 'B'
        const scoreParent = o.abSwapped ? o.verdict.scoreB : o.verdict.scoreA
        const scoreChild = o.abSwapped ? o.verdict.scoreA : o.verdict.scoreB
        sumScoreParent += scoreParent
        sumScoreChild += scoreChild
        if (o.verdict.winner === 'tie') ties++
        else if (parentWon) wins++
        else if (childWon) losses++

        const parentFeedback = o.abSwapped ? o.verdict.feedbackB : o.verdict.feedbackA
        const childFeedback = o.abSwapped ? o.verdict.feedbackA : o.verdict.feedbackB
        if (parentFeedback && parentFeedback.trim()) parentFeedbackParts.push(`- ${parentFeedback.trim()}`)
        if (childFeedback && childFeedback.trim()) childFeedbackParts.push(`- ${childFeedback.trim()}`)
      }

      pairs.push({
        id: newId(),
        iterationId: '',
        itemId: sampleItems[i].id,
        outputA: o.outputA,
        outputB: o.outputB,
        verdict: o.verdict,
        abSwapped: o.abSwapped,
        tokensIn: o.tokensIn,
        tokensOut: o.tokensOut,
        latencyMs: o.latencyMs,
        errorMessage: o.errorMessage,
      })
    }

    const pairTokensIn = outcomes.reduce((sum, outcome) => sum + outcome.tokensIn, 0)
    const pairTokensOut = outcomes.reduce((sum, outcome) => sum + outcome.tokensOut, 0)
    await recordUsage(pairTokensIn, pairTokensOut)
    if (pairs.length === 0) ctx.signal?.throwIfAborted()
    const iteration: IterationRecord = {
      id: newId(),
      runId: run.id,
      index: iterIndex,
      parentCandidateId: parent.id,
      childCandidateId: challenger.id,
      sampleItemIds: pairs.map((pair) => pair.itemId),
      aggregatedFeedback: '',
      rationale: challenger.rationale,
      tokensIn: mutationTokensIn + pairTokensIn,
      tokensOut: mutationTokensOut + pairTokensOut,
      startedAt,
      finishedAt: Date.now(),
    }
    pairs.forEach((pair) => (pair.iterationId = iteration.id))

    const failedCount = outcomes.filter((o) => !o.cancelled && o.failed).length
    if (failedCount > 0) emitLog('warn', `iter ${iterIndex}: ${failedCount}/${pairs.length} pairs failed`)
    const n = pairs.length - failedCount
    if (n === 0) {
      await addIteration(iteration, pairs)
      history = [...history, iteration]
      if (stopRequested) return
      const reasons = compactFailureReasons(outcomes)
      throw new Error(`iter ${iterIndex}: all pairs failed${reasons ? `: ${reasons}` : ''}`)
    }
    const meanParent = sumScoreParent / n
    const meanChild = sumScoreChild / n
    const parentFeedback = parentFeedbackParts.join('\n')
    const childFeedback = childFeedbackParts.join('\n')
    const parentWeaknesses = parentFeedback ? `Weaknesses in this candidate:\n${parentFeedback}` : ''
    const childWeaknesses = childFeedback ? `Weaknesses in this candidate:\n${childFeedback}` : ''
    const feedback = [
      parentWeaknesses,
      childFeedback ? `Regressions observed in challenger; avoid repeating them:\n${childFeedback}` : '',
    ].filter(Boolean).join('\n\n')
    if (parentWeaknesses) feedbackByCandidateId.set(parent.id, parentWeaknesses)
    if (childWeaknesses) feedbackByCandidateId.set(challenger.id, childWeaknesses)
    if (feedback) lastFeedback = feedback

    emitLog('info', `iter ${iterIndex}: parent=${meanParent.toFixed(2)} child=${meanChild.toFixed(2)} (w${wins}/l${losses}/t${ties})`)
    emitStage('scoring', {
      iteration: iterIndex + 1,
      sampleCount: pairs.length,
      parentCandidateId: parent.id,
      challengerCandidateId: challenger.id,
      parentScore: meanParent,
      challengerScore: meanChild,
      wins,
      losses,
      ties,
      failedPairs: failedCount,
      changeSummary: challenger.rationale || feedback || '',
    })

    // Update parent's running score (EMA toward this round's mean)
    const updatedParent: PromptCandidate = {
      ...parent,
      score: parent.score == null ? meanParent : parent.score * 0.5 + meanParent * 0.5,
      wins: parent.wins + wins,
      losses: parent.losses + losses,
      ties: parent.ties + ties,
      iterations: parent.iterations + n,
      tokensIn: parent.tokensIn + parentTokensIn,
      tokensOut: parent.tokensOut + parentTokensOut,
    }

    const updatedChallenger: PromptCandidate = {
      ...challenger,
      score: meanChild,
      wins: losses, // child won when parent lost
      losses: wins,
      ties,
      iterations: challenger.iterations + n,
      tokensIn: challenger.tokensIn + childTokensIn,
      tokensOut: challenger.tokensOut + childTokensOut,
    }

    iteration.aggregatedFeedback = feedback

    // Persist
    emitStage('persisting', {
      iteration: iterIndex + 1,
      sampleCount: pairs.length,
      parentCandidateId: parent.id,
      challengerCandidateId: updatedChallenger.id,
      parentScore: updatedParent.score,
      challengerScore: updatedChallenger.score,
      wins,
      losses,
      ties,
      failedPairs: failedCount,
      changeSummary: updatedChallenger.rationale || feedback || '',
    })
    await addIteration(iteration, pairs)
    await addCandidate(updatedChallenger)
    await addCandidate(updatedParent) // upsert with updated stats
    candidates = [...candidates.filter((c) => c.id !== parent.id && c.id !== updatedChallenger.id), updatedParent, updatedChallenger]

    // Update run
    const newBest = bestScore(candidates)
    const newBestCand = candidates.reduce<PromptCandidate | null>(
      (b, c) => (c.score != null && (!b || c.score > (b.score ?? 0)) ? c : b),
      null
    )
    if (newBest != null && (lastBestScore == null || newBest > lastBestScore)) {
      plateauCount = 0
      lastBestScore = newBest
    } else {
      plateauCount++
    }

    const totalsIn = run.totalTokensIn
    const totalsOut = run.totalTokensOut
    run = {
      ...run,
      iterationCount: iterIndex + 1,
      totalTokensIn: totalsIn,
      totalTokensOut: totalsOut,
      bestCandidateId: newBestCand?.id ?? run.bestCandidateId,
    }
    history = [...history, iteration]
    await patchRun(run.id, {
      totalTokensIn: totalsIn,
      totalTokensOut: totalsOut,
      iterationCount: iterIndex + 1,
      bestCandidateId: run.bestCandidateId,
    })

    emitState()
    emitProgress()

    if (ctx.config.earlyStopPlateau > 0 && plateauCount >= ctx.config.earlyStopPlateau) {
      emitLog('info', `early stop: no improvement for ${plateauCount} iterations`)
      stopRequested = true
    }
  }

  return {
    snapshot,
    pause: async () => {
      if (stopRequested || (run.status !== 'running' && run.status !== 'paused')) return
      pauseRequested = true
      run = { ...run, status: 'paused', errorMessage: null }
      await persistStatus()
      if (run.status === 'paused') emitStage('paused')
      emitLog('info', 'paused')
      emitState()
    },
    resume: async () => {
      if (stopRequested || (run.status !== 'running' && run.status !== 'paused')) return
      pauseRequested = false
      run = { ...run, status: 'running', errorMessage: null }
      await persistStatus()
      if (run.status === 'running') emitStage('starting')
      emitLog('info', 'resumed')
      emitState()
    },
    stop: async () => {
      if (terminalPersisted === run.status) return
      stopRequested = true
      abortController.abort()
      run = {
        ...run,
        status: terminalFailure !== null ? 'failed' : 'stopped',
        finishedAt: run.finishedAt ?? Date.now(),
        errorMessage: terminalFailure,
      }
      await persistStatus()
      emitStage(run.status === 'failed' ? 'failed' : 'stopped')
      emitLog('info', run.status === 'failed' ? 'saved failed run' : 'stopped by user')
      emitState()
    },
    updateCtx: (patch: Partial<Ctx>) => {
      Object.assign(ctx, patch)
      emitLog('info', `settings updated: ${Object.keys(patch).join(', ')}`)
    },
    getCtx: () => ctx,
    start: async () => {
      stopRequested = false
      pauseRequested = false
      terminalPersisted = null
      terminalFailure = null
      run = { ...run, status: 'running', errorMessage: null }
      try {
        await persistStatus()
        emitStage('starting')
        emitLog('info', `starting run ${runId}`)
        emitState()
        for (let i = run.iterationCount; i < ctx.config.iterationsCap; i++) {
          if (stopRequested) {
            run = { ...run, status: 'stopped', finishedAt: Date.now() }
            emitLog('info', 'stopped by user')
            break
          }
          while (pauseRequested && !stopRequested) {
            await sleep(100)
          }
          if (stopRequested) break
          await runIteration(i)
          if (stopRequested) break
          if (ctx.config.tokenBudget > 0 && (run.totalTokensIn + run.totalTokensOut) >= ctx.config.tokenBudget) {
            emitLog('info', `token budget reached: ${run.totalTokensIn + run.totalTokensOut}`)
            run = { ...run, status: 'completed', finishedAt: Date.now() }
            break
          }
        }
        if (run.status === 'running' || run.status === 'paused') {
          run = { ...run, status: 'completed', finishedAt: Date.now() }
        }
        if (!await persistTerminalStatus()) return
        const best = candidates.reduce<PromptCandidate | null>(
          (b, c) => (c.score != null && (!b || c.score > (b.score ?? 0)) ? c : b),
          null
        )
        emitStage(run.status === 'stopped' ? 'stopped' : 'completed', {
          iteration: run.iterationCount,
          parentCandidateId: best?.parentId ?? null,
          challengerCandidateId: best?.id ?? null,
          challengerScore: best?.score ?? null,
        })
        emitLog('info', `done. best=${best?.id.slice(0, 6) ?? 'none'} score=${best?.score?.toFixed(2) ?? 'n/a'}`)
        emitState()
        send({ type: 'DONE', finalCandidateId: best?.id ?? null })
      } catch (e) {
        if (stopRequested && e === abortController.signal.reason) {
          run = { ...run, status: 'stopped', finishedAt: run.finishedAt ?? Date.now() }
          if (!await persistTerminalStatus()) return
          emitStage('stopped')
          emitState()
          send({ type: 'DONE', finalCandidateId: run.bestCandidateId })
          return
        }
        const err = e instanceof Error || e instanceof DOMException ? e : new Error(String(e))
        emitLog('error', err.message)
        terminalFailure = err.message
        run = { ...run, status: 'failed', finishedAt: Date.now(), errorMessage: err.message }
        if (!await persistTerminalStatus()) return
        emitStage('failed', {
          iteration: stage?.iteration ?? run.iterationCount,
          totalIterations: ctx.config.iterationsCap,
          changeSummary: err.message,
        })
        emitState()
        send({ type: 'ERROR', message: err.message, stack: err.stack })
      }
    },
    compareAB: (promptA: string, promptB: string, itemIds: string[]) => comparePrompts(ctx, promptA, promptB, itemIds),
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

export type { MainToWorker, WorkerToMain }
