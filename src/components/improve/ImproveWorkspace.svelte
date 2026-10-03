<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { get } from 'svelte/store'
  import { onDestroy, onMount, untrack } from 'svelte'
  import type { Dataset, DatasetItem, RunConfig, RunStage, RunStageKey, Task } from '../../lib/types'
  import { replaceGeneratedItems, createDataset, getAllItems, getDataset } from '../../lib/db/datasets'
  import { createRun, getCandidates, getIterations, getRun, listRuns, patchRun } from '../../lib/db/runs'
  import { saveTask } from '../../lib/db/tasks'
  import { stagePromptDraft } from '../../lib/db/prompt-drafts'
  import { settings } from '../../stores/settings'
  import { optimizationState, activeRunId, pause, resume, start, stop, getState } from '../../stores/worker'
  import { t } from '../../stores/toast'
  import { analyzePrompt, canAutoReplaceExamples, examplesAreManual, generatedItemsFromAnalysis, promptFingerprint } from '../../lib/improve/intake'
  import { shouldStopReloadedRun, stopReloadedRun } from '../../lib/improve/run-recovery'
  import { isRunnableProvider, isRunnableModelSetup, providerKindFromBaseUrl } from '../../lib/improve/model-routing'
  import { nextPreflightAction, runPreflight, type PreflightResult } from '../../lib/improve/preflight'
  import { judgeRoute } from '../../lib/optimizer/judge'

  import { readAppliedRevision, storeAppliedRevision, type AppliedRevision } from '../../lib/improve/applied-revision'
  import PromptDiff from './PromptDiff.svelte'
  import { diffPrompts } from '../../lib/improve/prompt-diff'
  import Button from '../ui/Button.svelte'
  import PromptEditor from '../ui/PromptEditor.svelte'
  import NumberField from '../ui/NumberField.svelte'
  import Tag from '../ui/Tag.svelte'
  import ProgressChart from '../chart/ProgressChart.svelte'
  import RunStats from '../run/RunStats.svelte'
  import CandidateTimeline from '../run/CandidateTimeline.svelte'
  import TokenMeter from '../run/TokenMeter.svelte'
  import CompareModal from '../compare/CompareModal.svelte'
  import ModelSetupDialog from './ModelSetupDialog.svelte'

  let { task = $bindable() as Task }: { task: Task } = $props()

  type FlowState = 'idle' | 'intake' | 'preflight' | 'starting' | 'error'
  type PhaseKey = 'prepare' | 'mutate' | 'answer' | 'judge' | 'decide' | 'done'
  type StageStatus = 'pending' | 'active' | 'done' | 'error'
  type SmartPlan = {
    kind: 'local' | 'cloud'
    iterationsCap: number
    tokenBudget: number
    concurrency: number
    sampleSizePerIter: number
    earlyStopPlateau: number
  }

  let config = $state<RunConfig>({
    iterationsCap: 3,
    tokenBudget: 0,
    concurrency: 1,
    sampleSizePerIter: 2,
    earlyStopPlateau: 2,
    judgeTemperature: $settings.judgeTemperature,
    targetTemperature: $settings.targetTemperature,
    mutatorTemperature: $settings.mutatorTemperature,
  })
  let items = $state<DatasetItem[]>([])
  let flowState = $state<FlowState>('idle')
  let flowMessage = $state('')
  let flowError = $state('')
  let preflight = $state<PreflightResult | null>(null)
  let compareOpen = $state(false)
  let modelsOpen = $state(false)
  let view = $state<'auto' | 'edit' | 'review'>('auto')
  let originalOpen = $state(false)
  let appliedRevision = $state<AppliedRevision | null>(null)
  let detailsOpen = $state(false)
  let candidateOpen = $state(false)
  let alive = true
  let hydrationPending = $state(false)
  let hydrationRequest = 0
  let preparation = 0
  let saveState = $state<'saved' | 'saving' | 'error'>('saved')
  let saveQueue = Promise.resolve()
  let editVersion = 0
  const emptyState = { run: null, candidates: [], history: [], log: [], stage: null }
  const taskState = $derived($optimizationState.run?.taskId === task.id ? $optimizationState : emptyState)
  const activeElsewhere = $derived(!!$activeRunId && $optimizationState.run?.taskId !== task.id)
  const effectiveJudge = $derived(judgeRoute($settings.provider, $settings.arbitrator))
  const isDemo = $derived($settings.provider.baseUrl.startsWith('mock://'))
  const configured = $derived(isRunnableModelSetup($settings.provider, $settings.arbitrator))
  const bestFeedback = $derived.by(() => {
    for (let i = taskState.history.length - 1; i >= 0; i--) {
      if (taskState.history[i].childCandidateId === bestCandidate?.id) return taskState.history[i].aggregatedFeedback
    }
    return ''
  })
  let configEdited = $state(false)
  let tempsEdited = $state(false)
  let taskSaveTimer: number | undefined
  let intakeController: AbortController | null = null
  let preflightController: AbortController | null = null
  const phaseSteps: PhaseKey[] = ['prepare', 'mutate', 'answer', 'judge', 'decide', 'done']

  function smartPlan(baseUrl: string, itemCount: number): SmartPlan {
    const local = providerKindFromBaseUrl(baseUrl) === 'local'
    const sampleSize = Math.max(1, Math.min(local ? 2 : 4, itemCount || 2))
    return {
      kind: local ? 'local' : 'cloud',
      iterationsCap: local ? 3 : 8,
      tokenBudget: 0,
      concurrency: local ? 1 : 4,
      sampleSizePerIter: sampleSize,
      earlyStopPlateau: local ? 2 : 4,
    }
  }

  function applySmartPlan() {
    const plan = smartPlan($settings.provider.baseUrl, items.length)
    config.iterationsCap = plan.iterationsCap
    config.tokenBudget = plan.tokenBudget
    config.concurrency = plan.concurrency
    config.sampleSizePerIter = plan.sampleSizePerIter
    config.earlyStopPlateau = plan.earlyStopPlateau
    configEdited = false
  }

  function markConfigEdited() {
    configEdited = true
  }

  function taskSnapshot(): Task {
    return $state.snapshot(task) as Task
  }

  $effect(() => {
    if (tempsEdited) return
    config.judgeTemperature = $settings.judgeTemperature
    config.targetTemperature = $settings.targetTemperature
    config.mutatorTemperature = $settings.mutatorTemperature
  })

  const promptFingerprintNow = $derived(promptFingerprint(task.initialPrompt))
  const canGenerateExamples = $derived(
    !!task.initialPrompt.trim()
    && !!$settings.provider.targetModel.trim()
    && isRunnableProvider($settings.provider)
    && canAutoReplaceExamples(items, promptFingerprintNow)
  )
  const run = $derived(taskState.run)
  const isRunning = $derived(run?.status === 'running')
  const isPaused = $derived(run?.status === 'paused')
  const isStopped = $derived(run?.status === 'stopped' || run?.status === 'completed' || run?.status === 'failed')
  const canStartRun = $derived(!run || run.status === 'idle' || isStopped)
  const bestCandidate = $derived(
    run?.bestCandidateId
      ? taskState.candidates.find((c) => c.id === run.bestCandidateId) ?? null
      : taskState.candidates.reduce<typeof taskState.candidates[number] | null>(
          (b, c) => (c.score != null && (!b || c.score > (b.score ?? 0)) ? c : b),
          null
        )
  )
  const bestIsCurrent = $derived(!!bestCandidate && task.initialPrompt === bestCandidate.text)
  const reviewing = $derived(!!bestCandidate && view !== 'edit')
  const canUndo = $derived(!!appliedRevision && task.initialPrompt === appliedRevision.after)
  const diffBefore = $derived(canUndo && appliedRevision && appliedRevision.after === bestCandidate?.text ? appliedRevision.before : task.initialPrompt)
  const chartPoints = $derived.by(() => {
    const scores = new Map(taskState.candidates.map((c) => [c.id, c.score]))
    return taskState.history.slice(-500).map((h) => ({ iter: h.index + 1, bestScore: scores.get(h.childCandidateId) ?? 0 }))
  })
  const primaryBusy = $derived(flowState === 'intake' || flowState === 'preflight' || flowState === 'starting')
  const hasPendingRevision = $derived(!!bestCandidate && !bestIsCurrent && !isRunning && !isPaused && !primaryBusy)
  const revisionSegments = $derived.by(() => {
    if (!bestCandidate) return []
    const compared = diffPrompts(diffBefore, bestCandidate.text)
    const segments: { text: string; added: boolean }[] = []
    for (const line of compared.lines) {
      if (line.kind === 'removed') continue
      const added = line.kind === 'added'
      const last = segments.at(-1)
      if (last?.added === added) last.text += line.text + line.ending
      else segments.push({ text: line.text + line.ending, added })
      // Keep the reading view bounded in DOM size; full detail remains in the paged diff.
      if (segments.length > 48) return [{ text: bestCandidate.text, added: false }]
    }
    return segments
  })
  const nextAction = $derived(preflight ? nextPreflightAction(preflight.steps) : '')
  const currentStageKey = $derived(resolveCurrentStageKey())
  const liveStage = $derived(stageForView())
  const showStageFlow = $derived(primaryBusy || isRunning || isPaused || run?.status === 'failed' || run?.status === 'stopped' || run?.status === 'completed')
  const hasRunSummary = $derived(!!run && (isRunning || isPaused || run.status === 'failed' || run.status === 'stopped' || taskState.history.length > 0))
  const stageProgress = $derived(stageProgressPercent())

  $effect(() => {
    if (configEdited) return
    $settings.provider.baseUrl
    items.length
    applySmartPlan()
  })

  onMount(async () => {
    appliedRevision = readAppliedRevision(task.id, task.initialPrompt)
    await loadItems()
    if (alive) await hydrateLatestRun()
  })

  onDestroy(() => {
    alive = false
    hydrationRequest++
    preparation++
    if (taskSaveTimer) { clearTimeout(taskSaveTimer); persistTask() }
    intakeController?.abort()
    preflightController?.abort()
  })

  $effect(() => {
    if (hydrationPending && !$activeRunId) {
      untrack(() => { void hydrateLatestRun() })
    }
  })

  async function hydrateLatestRun() {
    const request = ++hydrationRequest
    const taskId = task.id
    const initialState = get(optimizationState)
    const current = () => alive && request === hydrationRequest && task.id === taskId
    hydrationPending = false
    if (taskState.run && $activeRunId === taskState.run.id) { getState(); return }
    // Keep the worker's active state intact and retry when it releases ownership.
    if ($activeRunId) { hydrationPending = true; return }
    const runs = await listRuns(taskId)
    if (!current()) return
    if (!runs.length) return
    let last = await getRun(runs[0].id)
    if (!last || !current()) return
    if (shouldStopReloadedRun(last) && $activeRunId !== last.id) {
      const recovered = stopReloadedRun(last, Date.now(), $_('improve.status.stoppedAfterReload'))
      await patchRun(last.id, {
        status: recovered.status,
        finishedAt: recovered.finishedAt,
        errorMessage: recovered.errorMessage,
      })
      last = recovered
    }
    const [candidates, history] = await Promise.all([
      getCandidates(last.id),
      getIterations(last.id),
    ])
    if (!current()) return
    if ($activeRunId) { hydrationPending = true; return }
    optimizationState.update((state) => {
      // A newly started/completed run of this task is newer than this DB read.
      if (state !== initialState && state.run?.taskId === taskId) return state
      return { run: last, candidates, history, log: [], stage: null }
    })
  }

  async function loadItems() {
    if (!task.datasetId) {
      items = []
      return
    }
    const ds = await getDataset(task.datasetId)
    items = ds ? await getAllItems(ds.id) : []
  }

  async function ensureDataset(): Promise<Dataset> {
    if (task.datasetId) {
      const existing = await getDataset(task.datasetId)
      if (existing) return existing
    }
    const ds = await createDataset(task.id, 'Generated examples')
    task = { ...task, datasetId: ds.id }
    await saveTask(taskSnapshot())
    return ds
  }

  function persistTask() {
    taskSaveTimer = undefined
    const snapshot = taskSnapshot()
    const version = editVersion
    saveState = 'saving'
    saveQueue = saveQueue.catch(() => {}).then(() => saveTask(snapshot))
    void saveQueue.then(() => { if (alive && version === editVersion && !taskSaveTimer) saveState = 'saved' }, () => { if (alive && version === editVersion) saveState = 'error' })
  }

  function scheduleTaskSave() {
    if (appliedRevision && task.initialPrompt !== appliedRevision.after) {
      appliedRevision = null
      storeAppliedRevision(task.id, null)
    }
    editVersion++
    try { stagePromptDraft(task.id, task.initialPrompt) } catch { saveState = 'error' }
    if (primaryBusy) cancelPreparation()
    preflight = null
    flowError = ''
    saveState = 'saving'
    if (taskSaveTimer) clearTimeout(taskSaveTimer)
    taskSaveTimer = window.setTimeout(persistTask, 250)
  }

  function cancelPreparation() {
    preparation++
    intakeController?.abort()
    preflightController?.abort()
    flowState = 'idle'
    flowMessage = ''
    flowError = ''
  }

  function resolveCurrentStageKey(): RunStageKey | null {
    if (flowState === 'intake') return 'intake'
    if (flowState === 'preflight') return 'preflight'
    if (flowState === 'starting') return 'starting'
    if (flowState === 'error') return 'failed'
    if (run?.status === 'paused') return 'paused'
    if (run?.status === 'stopped') return 'stopped'
    if (run?.status === 'failed') return 'failed'
    if (run?.status === 'completed') return 'completed'
    return taskState.stage?.key ?? null
  }

  function stageForView(): RunStage | null {
    if (flowState === 'intake' || flowState === 'preflight' || flowState === 'starting' || flowState === 'error') {
      return {
        key: resolveCurrentStageKey() ?? 'starting',
        iteration: run?.iterationCount ?? 0,
        totalIterations: config.iterationsCap,
        updatedAt: Date.now(),
        changeSummary: flowError || nextAction || flowMessage,
      }
    }
    if (taskState.stage) return taskState.stage
    if (
      run
      && (
        run.status === 'paused'
        || run.status === 'stopped'
        || run.status === 'completed'
        || run.status === 'failed'
      )
    ) {
      return {
        key: run.status,
        iteration: run.iterationCount,
        totalIterations: run.config.iterationsCap,
        changeSummary: run.errorMessage ?? undefined,
        updatedAt: run.finishedAt ?? Date.now(),
      }
    }
    return null
  }

  function phaseForStage(key: RunStageKey | null): PhaseKey | null {
    switch (key) {
      case 'intake':
      case 'preflight':
      case 'starting':
      case 'selecting':
      case 'sampling':
        return 'prepare'
      case 'mutating':
        return 'mutate'
      case 'answering':
        return 'answer'
      case 'judging':
        return 'judge'
      case 'scoring':
      case 'persisting':
        return 'decide'
      case 'completed':
        return 'done'
      case 'paused':
      case 'stopped':
      case 'failed':
        if (flowState === 'error') return 'prepare'
        if (taskState.stage?.key && taskState.stage.key !== key) {
          return phaseForStage(taskState.stage.key)
        }
        return run?.iterationCount ? 'decide' : 'prepare'
      default:
        return null
    }
  }

  function phaseRank(phase: PhaseKey | null): number {
    return phase ? phaseSteps.indexOf(phase) : -1
  }

  function phaseStatus(step: PhaseKey): StageStatus {
    const currentPhase = phaseForStage(currentStageKey)
    if (currentStageKey === 'failed' && step === (currentPhase ?? 'prepare')) return 'error'
    if (currentStageKey === 'stopped' || currentStageKey === 'paused') {
      const lastPhase = phaseForStage(taskState.stage?.key ?? 'starting')
      return phaseRank(step) === phaseRank(lastPhase) ? 'active' : phaseRank(step) < phaseRank(lastPhase) ? 'done' : 'pending'
    }
    const current = phaseRank(currentPhase)
    const rank = phaseRank(step)
    if (rank < current || currentStageKey === 'completed') return 'done'
    if (rank === current) return 'active'
    return 'pending'
  }

  function stageProgressPercent(): number {
    const rank = phaseRank(phaseForStage(currentStageKey))
    if (rank < 0) return 0
    const last = phaseSteps.length - 1
    if (currentStageKey === 'completed') return 100
    const sampleFraction = liveStage?.sampleCount ? Math.min(0.85, Math.max(0, (liveStage.sampleIndex ?? 0) / liveStage.sampleCount)) : 0
    return Math.max(4, Math.min(100, ((Math.min(rank, last) + sampleFraction) / last) * 100))
  }

  function stageLabelKey(key: RunStageKey | null): string {
    if (!key) return 'idle'
    return key
  }

  function shortCandidate(id?: string | null): string {
    return id ? id.slice(0, 6) : 'seed'
  }

  function scoreText(score?: number | null): string {
    return score == null ? '-' : score.toFixed(2)
  }

  function compactDetail(text: string, max = 180): string {
    const cleaned = text.replace(/\s+/g, ' ').trim()
    return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned
  }

  function currentStageDetail(): string {
    const stage = liveStage
    if (!currentStageKey || !stage) return $_('improve.stage.detail.idle')
    if (stage.changeSummary && ['intake', 'preflight', 'starting', 'failed'].includes(currentStageKey)) return stage.changeSummary
    switch (currentStageKey) {
      case 'selecting':
        return $_('improve.stage.detail.selecting', { values: { parent: shortCandidate(stage.parentCandidateId), score: scoreText(stage.parentScore) } })
      case 'mutating':
        if (!stage.changeSummary || stage.changeSummary.startsWith('No prior feedback')) return $_('improve.stage.detail.mutating')
        return compactDetail(stage.changeSummary)
      case 'sampling':
        return $_('improve.stage.detail.sampling', { values: { count: stage.sampleCount ?? config.sampleSizePerIter } })
      case 'answering':
        return $_('improve.stage.detail.answering', { values: { current: stage.sampleIndex ?? 0, total: stage.sampleCount ?? config.sampleSizePerIter } })
      case 'judging':
        return $_('improve.stage.detail.judging', { values: { current: stage.sampleIndex ?? 0, total: stage.sampleCount ?? config.sampleSizePerIter } })
      case 'scoring':
        return $_('improve.stage.detail.scoring', { values: { parent: scoreText(stage.parentScore), child: scoreText(stage.challengerScore) } })
      case 'persisting':
        return $_('improve.stage.detail.persisting')
      case 'paused':
        return $_('improve.stage.detail.paused')
      case 'stopped':
        return $_('improve.stage.detail.stopped')
      case 'completed':
        return $_('improve.stage.detail.completed', { values: { score: scoreText(bestCandidate?.score ?? stage.challengerScore) } })
      case 'failed':
        return stage.changeSummary || flowError || $_('improve.stage.detail.failed')
      case 'intake':
      case 'preflight':
      case 'starting':
        return stage.changeSummary || $_(`improve.stage.detail.${currentStageKey}`)
      default:
        return $_('improve.stage.detail.idle')
    }
  }

  function stageIterationText(): string {
    if (currentStageKey === 'intake' || currentStageKey === 'preflight' || currentStageKey === 'starting') return ''
    const current = Math.max(0, liveStage?.iteration ?? run?.iterationCount ?? 0)
    const total = liveStage?.totalIterations ?? run?.config.iterationsCap ?? config.iterationsCap
    if (!total) return ''
    return $_('improve.stage.iteration', { values: { current, total } })
  }

  function stageSampleText(): string {
    if (!liveStage?.sampleCount) return ''
    return $_('improve.stage.samples', { values: { current: liveStage.sampleIndex ?? liveStage.sampleCount, total: liveStage.sampleCount } })
  }

  async function runIntake(): Promise<boolean> {
    const operation = preparation
    if (!task.initialPrompt.trim() || !$settings.provider.targetModel.trim()) return false
    const fp = promptFingerprint(task.initialPrompt)
    if (examplesAreManual(items)) {
      flowMessage = $_('improve.status.manualExamplesPreserved')
      return true
    }
    if (!isRunnableProvider($settings.provider)) {
      flowError = $_('improve.status.providerNeeded')
      return false
    }

    intakeController?.abort()
    intakeController = new AbortController()
    flowState = 'intake'
    flowError = ''
    flowMessage = $_('improve.status.generating')

    try {
      const snapshot = get(settings)
      const route = judgeRoute(snapshot.provider, snapshot.arbitrator)
      const analysis = await analyzePrompt({
        provider: {
          baseUrl: route.baseUrl,
          apiKey: route.apiKey,
          requestTimeoutMs: snapshot.provider.requestTimeoutMs,
          modelRateLimits: snapshot.provider.modelRateLimits,
        },
        model: route.model || snapshot.provider.judgeModel,
        prompt: task.initialPrompt,
        targetModel: snapshot.provider.targetModel,
        count: 8,
        signal: intakeController.signal,
      })
      if (!alive || operation !== preparation || intakeController.signal.aborted) return false
      const ds = await ensureDataset()
      if (!alive || operation !== preparation || intakeController.signal.aborted) return false
      const replaced = await replaceGeneratedItems(ds.id, generatedItemsFromAnalysis(analysis, fp), intakeController.signal)
      if (!alive || operation !== preparation || intakeController.signal.aborted) return false
      if (!replaced) {
        await loadItems()
        flowState = 'idle'
        flowMessage = $_('improve.status.manualExamplesPreserved')
        return true
      }
      task = {
        ...task,
        name: task.name.trim() ? task.name : analysis.name,
        description: task.description.trim() ? task.description : analysis.description,
        rubric: { text: task.rubric.text.trim() ? task.rubric.text : analysis.rubric },
        datasetId: ds.id,
      }
      await saveTask(taskSnapshot())
      await loadItems()
      flowState = 'idle'
      flowMessage = $_('improve.status.examplesReady')
      return true
    } catch (e) {
      if (!alive || operation !== preparation || intakeController?.signal.aborted || (e as Error).name === 'AbortError') return false
      flowState = 'error'
      flowError = e instanceof Error ? e.message : String(e)
      return false
    }
  }

  async function runChecks(): Promise<boolean> {
    const operation = preparation
    preflightController?.abort()
    preflightController = new AbortController()
    flowState = 'preflight'
    flowError = ''
    flowMessage = $_('improve.status.preflight')
    try {
      const snapshot = get(settings)
      const result = await runPreflight({
        provider: snapshot.provider,
        arbitrator: snapshot.arbitrator,
        task: taskSnapshot(),
        items,
        signal: preflightController.signal,
      })
      if (!alive || operation !== preparation || preflightController.signal.aborted) return false
      preflight = result
      if (!result.ready) {
        flowState = 'error'
        flowError = nextPreflightAction(result.steps) || $_('improve.status.preflightFailed')
        return false
      }
      flowState = 'idle'
      flowMessage = $_('improve.status.ready')
      return true
    } catch (e) {
      if (!alive || operation !== preparation) return false
      flowState = 'error'
      flowError = e instanceof Error ? e.message : String(e)
      return false
    }
  }

  async function improve() {
    if (primaryBusy || $activeRunId || !task.initialPrompt.trim()) return
    if (!configured) { modelsOpen = true; return }
    const operation = ++preparation
    flowState = 'starting'
    flowError = ''
    try {
      if (taskSaveTimer) clearTimeout(taskSaveTimer)
      persistTask()
      await saveQueue
      if (!alive || operation !== preparation) return
      if (items.length < 2 || canAutoReplaceExamples(items, promptFingerprintNow)) {
        if (!await runIntake()) return
      }
      await loadItems()
      if (!alive || operation !== preparation) return
      if (items.length < 2) { flowError = $_('errors.noDataset'); flowState = 'error'; return }
      flowState = 'starting'
      const nextRun = await createRun(task.id, $state.snapshot(config))
      if (!alive || operation !== preparation) { await patchRun(nextRun.id, { status: 'stopped', finishedAt: Date.now() }); return }
      view = 'auto'
      originalOpen = false
      optimizationState.set({ run: nextRun, candidates: [], history: [], log: [], stage: null })
      start(nextRun.id)
      flowState = 'idle'
      flowMessage = ''
    } catch (e) {
      if (!alive || operation !== preparation) return
      flowState = 'error'
      flowError = e instanceof Error ? e.message : String(e)
    }
  }

  async function copyBest() {
    if (!bestCandidate) return
    await navigator.clipboard.writeText(bestCandidate.text)
    t.success($_('common.copied'))
  }

  async function applyBest() {
    if (!bestCandidate || bestIsCurrent || isRunning || isPaused || primaryBusy) return
    appliedRevision = { before: task.initialPrompt, after: bestCandidate.text }
    storeAppliedRevision(task.id, appliedRevision)
    task = { ...task, initialPrompt: bestCandidate.text }
    scheduleTaskSave()
    if (taskSaveTimer) clearTimeout(taskSaveTimer)
    persistTask()
    try { await saveQueue; t.success($_('actions.saved')) }
    catch { t.error($_('workspace.saveFailed')) }
  }

  async function undoApply() {
    if (!canUndo || !appliedRevision || isRunning || isPaused || primaryBusy) return
    const previous = appliedRevision.before
    appliedRevision = null
    storeAppliedRevision(task.id, null)
    task = { ...task, initialPrompt: previous }
    scheduleTaskSave()
    if (taskSaveTimer) clearTimeout(taskSaveTimer)
    persistTask()
    try { await saveQueue; t.success($_('revision.restored')) }
    catch { t.error($_('workspace.saveFailed')) }
  }

  function exportBest() {
    if (!bestCandidate) return
    const blob = new Blob(
      [JSON.stringify({
        task: { id: task.id, name: task.name, description: task.description },
        bestPrompt: bestCandidate.text,
        score: bestCandidate.score,
        candidates: taskState.candidates,
        iterations: taskState.history,
      }, null, 2)],
      { type: 'application/json' }
    )
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `super-prompt-${(task.name || 'prompt').replace(/\s+/g, '-').toLowerCase()}.json`
    a.click()
    URL.revokeObjectURL(url)
    t.success($_('toast.exported'))
  }

  function beforeUnload(e: BeforeUnloadEvent) {
    if (saveState === 'saved') return
    if (taskSaveTimer) { clearTimeout(taskSaveTimer); persistTask() }
    e.preventDefault()
    e.returnValue = ''
  }

</script>
<svelte:window onbeforeunload={beforeUnload} />
<div class="workspace" data-testid="workspace-ready">
  <div class="workspace-header">
    <nav class="flow-nav" aria-label={$_('revision.workflow')}>
      <button class:current={!reviewing} onclick={() => view = 'edit'} aria-current={!reviewing ? 'step' : undefined}><span>01</span> {$_('revision.prompt')}</button>
      <button aria-label={$_('workspace.configure')} title={`${$settings.provider.targetModel || $_('revision.notSet')} / ${effectiveJudge.model || $_('revision.notSet')}`} onclick={() => modelsOpen = true} disabled={isRunning || isPaused || primaryBusy}><span>02</span> {$_('revision.models')}</button>
      <button class:current={reviewing} onclick={() => view = 'review'} disabled={!bestCandidate} aria-current={reviewing ? 'step' : undefined}><span>03</span> {$_('revision.review')}</button>
    </nav>
    <span class="save-status" role="status">{isDemo ? `${$_('workspace.demo')} · ` : ''}{saveState === 'saved' ? $_('workspace.saved') : saveState === 'saving' ? $_('workspace.saving') : $_('workspace.saveFailed')}</span>
  </div>
  {#if activeElsewhere}
    <div class="notice" role="status">{$_('workspace.activeElsewhere')} <a href={`#/task/${$optimizationState.run?.taskId}/improve`}>{$_('workspace.openActive')}</a></div>
  {/if}
  {#if isRunning || isPaused || primaryBusy || flowError || run?.status === 'failed' || run?.status === 'stopped'}
    <section class="run-strip" data-testid="run-status" data-status={primaryBusy || flowState === 'error' ? flowState : run?.status ?? flowState}>
      <div class="section-head"><div><h3>{$_(`improve.stage.steps.${stageLabelKey(currentStageKey)}`)}</h3><span class="supporting">{stageIterationText()}{stageSampleText() ? ` · ${stageSampleText()}` : ''}</span></div>
        <div class="actions-row">
          {#if primaryBusy}<Button variant="secondary" onclick={cancelPreparation}>{$_('workspace.cancel')}</Button>
          {:else if isRunning}<Button variant="secondary" onclick={() => pause(run?.id)}>{$_('run.pause')}</Button><Button variant="ghost" onclick={() => stop(run?.id)}>{$_('run.stop')}</Button>
          {:else if isPaused}<Button onclick={() => resume(run?.id)}>{$_('run.resume')}</Button><Button variant="ghost" onclick={() => stop(run?.id)}>{$_('run.stop')}</Button>{/if}
        </div>
      </div>
      {#if flowError || run?.errorMessage}<p class="error" role="alert">{flowError || run?.errorMessage}</p>{:else}<p class="supporting" role="status">{currentStageDetail()}</p>{/if}
      {#if isRunning || isPaused || primaryBusy}
        <div class="stage-meter" aria-hidden="true"><span style={`transform:scaleX(${stageProgress / 100})`}></span></div>
        <ol class="stage-steps" aria-label={$_('improve.stage.title')}>{#each phaseSteps as step}{@const status = phaseStatus(step)}<li class:done={status === 'done'} class:active={status === 'active'} class:error={status === 'error'} aria-current={status === 'active' ? 'step' : undefined}>{$_(`improve.stage.phases.${step}`)}</li>{/each}</ol>
        <p class="supporting">{$_('workspace.stopHelp')}</p>
      {/if}
    </section>
  {/if}
  <section class="workbench" data-testid="run-result">
    <div class="workbench-heading">
      <div><span class="eyebrow">{reviewing ? $_('revision.readyReview') : $_('revision.startHere')}</span><h2>{reviewing ? $_('revision.reviewTitle') : $_('revision.promptTitle')}</h2><p class="supporting">{reviewing ? isRunning || isPaused ? $_('workspace.provisional') : bestIsCurrent ? $_('revision.currentBest') : '' : $_('workspace.currentHelp')}</p></div>
      {#if bestCandidate}<Button variant="ghost" size="sm" onclick={() => view = reviewing ? 'edit' : 'review'}>{reviewing ? $_('revision.edit') : $_('revision.review')}</Button>{/if}
    </div>
    {#if reviewing && bestCandidate}
      <div class="proposed-prompt" data-testid="result-prompt">{#each revisionSegments as segment}<span class:added={segment.added}>{segment.text}</span>{/each}</div>
      <details data-testid="original-wording" class="original" bind:open={originalOpen}><summary>{$_('revision.original')}</summary>
        {#if originalOpen}<PromptDiff before={diffBefore} after={bestCandidate.text} labels={{ ariaLabel: $_('diff.ariaLabel'), unchanged: $_('diff.unchanged'), removed: $_('diff.removed'), added: $_('diff.added'), empty: $_('diff.empty'), limited: $_('diff.limited'), page: $_('diff.page', { values: { from: '{from}', to: '{to}', total: '{total}' } }), previous: $_('diff.previous'), next: $_('diff.next'), continued: $_('diff.continued'), lineEnding: $_('diff.lineEnding'), noLineEnding: $_('diff.noLineEnding'), currentLine: $_('diff.currentLine'), proposedLine: $_('diff.proposedLine') }} />{/if}
      </details>
      <section class="arbiter-note" aria-label={$_('revision.arbiterEvaluation')}>
        <span>{bestCandidate.rationale ? $_('workspace.change') : $_('revision.arbiterEvaluation')}</span>
        <p>{compactDetail(bestCandidate.rationale || $_('workspace.scoreHelp'), 260)}</p>
        <div class="evidence-meta"><span>{bestCandidate.score == null ? $_('workspace.noResult') : $_(bestCandidate.iterations === 1 ? 'revision.scoreOne' : 'revision.score', { values: { score: bestCandidate.score.toFixed(2), count: bestCandidate.iterations } })}</span>{#if isDemo}<span>{$_('workspace.demo')}</span>{/if}</div>
      </section>
      <div class="decision-row">

        <div class="actions-row decision-actions">
          {#if canUndo}<Button variant="ghost" onclick={undoApply} disabled={isRunning || isPaused || primaryBusy}>{$_('revision.undo')}</Button>{/if}
          {#if hasPendingRevision}<Button size="lg" onclick={applyBest}>{$_('revision.apply')}</Button><Button variant="ghost" onclick={() => view = 'edit'}>{$_('revision.keep')}</Button>
          {:else if canStartRun && !primaryBusy}<Button size="lg" onclick={improve} disabled={!task.initialPrompt.trim() || activeElsewhere}>{$_('improve.primary')}</Button>{/if}
        </div>
      </div>
      <details class="evidence"><summary>{$_('workspace.why')}</summary>
        <p>{$_('workspace.scoreHelp')}</p>
        <p>{$_(bestCandidate.iterations === 1 ? 'revision.trialsOne' : 'workspace.trials', { values: { count: bestCandidate.iterations, wins: bestCandidate.wins, losses: bestCandidate.losses, ties: bestCandidate.ties } })}</p>
        {#if bestCandidate.rationale}<h4>{$_('workspace.change')}</h4><p>{bestCandidate.rationale}</p>{/if}
        {#if bestFeedback}<h4>{$_('workspace.feedback')}</h4><p>{$_('revision.feedbackContext')}</p><pre>{bestFeedback}</pre>{/if}
        <Button variant="secondary" onclick={() => compareOpen = true} disabled={isRunning || isPaused || primaryBusy}>{$_('run.compare')}</Button>
      </details>
      {#if run?.status === 'completed' && !primaryBusy && flowState !== 'error'}<p class="completion" data-testid="run-status" data-status="completed">{$_('revision.complete')} · {stageIterationText()}</p>{/if}
      <div class="output-tools"><Button variant="ghost" size="sm" onclick={copyBest}>{$_('common.copy')}</Button><Button variant="ghost" size="sm" onclick={exportBest}>{$_('common.export')}</Button></div>
    {:else}
      <div class="prompt-editor"><PromptEditor bind:value={task.initialPrompt} label={$_('workspace.current')} rows={13} oninput={scheduleTaskSave} /></div>
      <div class="editor-footer"><p class="supporting">{$_('workspace.autoExamples')}</p><div class="actions-row">
        {#if canUndo}<Button variant="ghost" onclick={undoApply} disabled={isRunning || isPaused || primaryBusy}>{$_('revision.undo')}</Button>{/if}
        {#if canStartRun}<Button size="lg" onclick={improve} loading={primaryBusy} disabled={!task.initialPrompt.trim() || activeElsewhere}>{configured ? $_('improve.primary') : $_('revision.chooseModels')}</Button>{/if}
      </div></div>
    {/if}
  </section>
  <details class="options" bind:open={detailsOpen}><summary>{$_('workspace.details')}<span>{$_('improve.examples.count', { values:{count:items.length} })}</span></summary>
    <div class="options-grid"><section><h3>{$_('improve.examples.title')}</h3><p class="supporting">{items.length >= 2 ? $_('improve.examples.readyBody') : $_('workspace.autoExamples')}</p><div class="actions-row"><Button variant="secondary" href={`#/task/${task.id}/dataset`}>{$_('improve.examples.open')}</Button><Button variant="ghost" onclick={() => void runIntake()} disabled={isRunning || isPaused || primaryBusy || !canGenerateExamples}>{$_('improve.regenerateExamples')}</Button><Button variant="ghost" onclick={runChecks} disabled={isRunning || isPaused || primaryBusy || items.length < 2}>{$_('improve.check')}</Button></div>
      {#if preflight}<div class="checks">{#each preflight.steps as step}<p class:error={step.status === 'fail'}>{step.status === 'ok' ? '✓' : '!'} {step.message}</p>{/each}</div>{/if}
    </section><section>      <details>
        <summary>
          <span>{$_('run.advanced')}</span>
          {#if configEdited}
            <Tag tone="warn">{$_('run.plan.custom')}</Tag>
          {/if}
        </summary>
        {#if configEdited}
          <div class="settings-reset">
            <p>{$_('run.plan.customBody')}</p>
            <Button size="sm" variant="ghost" onclick={applySmartPlan}>{$_('run.plan.apply')}</Button>
          </div>
        {/if}
        <div class="fields">
          <NumberField bind:value={config.iterationsCap} label={$_('run.iterationsCap')} tooltip={$_('run.hints.iterationsCap')} min={1} max={500} oninput={markConfigEdited} />
          <NumberField bind:value={config.concurrency} label={$_('run.concurrency')} tooltip={$_('run.hints.concurrency')} min={1} max={16} oninput={markConfigEdited} />
          <NumberField bind:value={config.sampleSizePerIter} label={$_('run.sampleSize')} tooltip={$_('run.hints.sampleSize')} min={1} max={items.length || 50} oninput={markConfigEdited} />
          <NumberField bind:value={config.earlyStopPlateau} label={$_('run.earlyStop')} tooltip={$_('run.hints.earlyStop')} min={0} max={50} oninput={markConfigEdited} />
          <NumberField bind:value={config.tokenBudget} label={$_('run.tokenBudget')} tooltip={$_('run.hints.tokenBudget')} min={0} step={1000} oninput={markConfigEdited} />
        </div>
      </details>
      <details>
        <summary>{$_('run.temperatures')}</summary>
        <div class="fields">
          <NumberField bind:value={config.judgeTemperature} label={$_('run.judgeTemp')} tooltip={$_('run.hints.judgeTemp')} min={0} max={2} step={0.1} onchange={() => (tempsEdited = true)} />
          <NumberField bind:value={config.targetTemperature} label={$_('run.targetTemp')} tooltip={$_('run.hints.targetTemp')} min={0} max={2} step={0.1} onchange={() => (tempsEdited = true)} />
          <NumberField bind:value={config.mutatorTemperature} label={$_('run.mutatorTemp')} tooltip={$_('run.hints.mutatorTemp')} min={0} max={2} step={0.1} onchange={() => (tempsEdited = true)} />
        </div>
      </details>

</section></div>
  </details>
  {#if hasRunSummary}
    <details class="options" bind:open={candidateOpen}><summary>{$_('workspace.runDetails')}<span>{taskState.candidates.length} {$_('candidate.title')}</span></summary>
      {#if candidateOpen}<div class="run-details"><Button variant="ghost" href={`#/task/${task.id}/history`}>{$_('revision.allHistory')}</Button><RunStats /><ProgressChart points={chartPoints} /><CandidateTimeline />{#if config.tokenBudget > 0}<TokenMeter used={(run?.totalTokensIn ?? 0) + (run?.totalTokensOut ?? 0)} budget={config.tokenBudget} />{/if}</div>{/if}
    </details>
  {/if}
</div>
<ModelSetupDialog bind:open={modelsOpen} />
{#if compareOpen}<CompareModal bind:open={compareOpen} taskId={task.id} {config} initialPromptA={task.initialPrompt} initialPromptB={bestCandidate?.text ?? task.initialPrompt} {items} />{/if}
<style>
  .workspace { display:flex; flex-direction:column; gap:18px; max-width:840px; margin:0 auto; }
  .workspace-header,.workbench-heading,.section-head,.decision-row,.editor-footer { display:flex; align-items:center; justify-content:space-between; gap:20px; }
  .flow-nav { display:flex; gap:24px; align-items:center; }
  .flow-nav button { min-height:44px; color:var(--ink-3); font-size:13px; }
  .flow-nav button span { font:11px var(--font-mono); margin-right:6px; opacity:.7; }
  .flow-nav button.current { color:var(--ink-1); }
  .flow-nav button:disabled { cursor:default; opacity:.5; }
  .save-status { font-size:11px; color:var(--ink-3); }
  .workbench { min-width:0; animation:surface-enter 180ms var(--ease-out); }
  .workbench-heading { position:relative; margin-top:28px; margin-bottom:32px; align-items:flex-start; }.workbench-heading > div { width:100%; }.workbench-heading > :global(.btn) { position:absolute; right:0; top:-8px; }
  h2 { font-size:34px; font-weight:600; margin:16px 0 12px; letter-spacing:-.035em; line-height:1.2; }
  .eyebrow { color:var(--secondary); font-size:11px; font-weight:600; letter-spacing:.09em; text-transform:uppercase; }
  h3 { font-size:15px; font-weight:500; }
  .supporting { color:var(--ink-3); font-size:12px; line-height:1.7; margin:0; }
  .proposed-prompt { white-space:pre-wrap; overflow-wrap:anywhere; font-size:26px; line-height:1.6; letter-spacing:-.015em; max-height:560px; overflow:auto; padding:6px 4px; }
  .proposed-prompt .added { text-decoration:underline; text-decoration-color:var(--secondary); text-decoration-thickness:1px; text-underline-offset:7px; }
  .original { margin:22px 0 0; padding-bottom:24px; }
  .arbiter-note { border-top:1px solid var(--border-2); padding-top:24px; }.arbiter-note>span { font-size:13px; color:var(--ink-2); }.arbiter-note>p { font-size:18px; line-height:1.6; margin:8px 0 16px; }
  .evidence-meta { display:flex; gap:14px; flex-wrap:wrap; color:var(--ink-3); font-size:12px; }
  .decision-row { margin:28px 0 18px; flex-wrap:wrap; }.completion { color:var(--ink-3); font-size:11px; margin:16px 0 0; }
  .actions-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }.decision-actions { margin-right:auto; }.decision-actions :global(.btn.lg) { min-width:240px; height:56px; justify-content:flex-start; padding:0 24px; font-size:16px; }
  .output-tools { display:flex; justify-content:flex-start; gap:8px; padding-top:12px; }
  .editor-footer { align-items:flex-start; margin-top:20px; }.editor-footer>.supporting { max-width:50ch; }
  .prompt-editor :global(.lbl) { display:none; }.prompt-editor :global(.cm-editor) { background:transparent !important; border-radius:3px !important; font-size:14px !important; }.prompt-editor :global(.cm-content) { padding:24px 16px !important; }.prompt-editor :global(.cm-gutters) { padding-top:10px; }
  .run-strip { padding:16px 0; border-bottom:1px solid var(--border-1); display:grid; gap:12px; animation:surface-enter 180ms var(--ease-out); }
  .stage-meter { height:2px; background:var(--bg-3); overflow:hidden; }.stage-meter span { display:block; width:100%; height:100%; background:var(--secondary); transform-origin:left; transition:transform 180ms var(--ease-out); }
  .stage-steps { list-style:none; padding:0; margin:0; display:flex; gap:20px; flex-wrap:wrap; color:var(--ink-3); font-size:11px; }.stage-steps li.active { color:var(--ink-1); }.stage-steps li.done { color:var(--ok); }.error { color:var(--err); font-size:13px; }
  details summary { cursor:pointer; font-size:13px; min-height:48px; padding:12px 0; color:var(--ink-2); } summary span { float:right; color:var(--ink-3); font-size:12px; }
  .options { border-top:1px solid var(--border-1); }.options-grid { display:grid; grid-template-columns:1fr 1fr; gap:40px; padding:16px 0 24px; }.options-grid section { min-width:0; display:grid; gap:12px; align-content:start; }.fields { display:grid; gap:12px; }.evidence { border-bottom:1px solid var(--border-1); }.evidence p,.evidence h4,.evidence pre { margin:8px 0 12px; }.evidence h4 { font-size:13px; }.evidence p { font-size:13px; color:var(--ink-2); }.evidence pre { white-space:pre-wrap; font-size:12px; max-height:240px; overflow:auto; }.evidence :global(.btn) { margin:8px 0 20px; }
  .run-details { padding:12px 0 20px; display:grid; gap:20px; }.notice { border-left:2px solid var(--warn); padding:12px 16px; color:var(--warn); font-size:13px; }.notice a { margin-left:12px; }.checks { font-size:13px; }.settings-reset p { font-size:13px; color:var(--ink-2); }
  @media(max-width:780px) { .workspace { gap:18px; }.workspace-header { align-items:flex-start; flex-wrap:wrap; gap:0; }.flow-nav { gap:16px; }.save-status { flex-basis:100%; }.workbench-heading { gap:12px; margin-bottom:16px; }h2 { font-size:28px; }.proposed-prompt { font-size:19px; }.arbiter-note>p { font-size:16px; }.workbench-heading { margin-top:12px; }.decision-actions :global(.btn.lg) { min-width:0; width:100%; justify-content:center; }.decision-row { gap:16px; }.decision-actions { width:100%; justify-content:flex-start; }.editor-footer { flex-direction:column; gap:12px; }.editor-footer>.actions-row { align-self:flex-end; }.options-grid { grid-template-columns:1fr; gap:20px; }.section-head { align-items:flex-start; flex-wrap:wrap; }.stage-steps { gap:10px; }summary span { float:none; display:block; font-size:11px; margin-top:3px; }.prompt-editor :global(.cm-content) { padding:16px 8px !important; } }
</style>
