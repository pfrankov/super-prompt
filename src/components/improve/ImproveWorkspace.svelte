<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { get } from 'svelte/store'
  import { onDestroy, onMount } from 'svelte'
  import type { Dataset, DatasetItem, RunConfig, RunStage, RunStageKey, Task } from '../../lib/types'
  import { addItems, clearDataset, createDataset, getAllItems, getDataset } from '../../lib/db/datasets'
  import { createRun, getCandidates, getIterations, getRun, listRuns, patchRun } from '../../lib/db/runs'
  import { saveTask } from '../../lib/db/tasks'
  import { stagePromptDraft } from '../../lib/db/prompt-drafts'
  import { settings } from '../../stores/settings'
  import { optimizationState, activeRunId, pause, resume, start, stop, getState } from '../../stores/worker'
  import { t } from '../../stores/toast'
  import { analyzePrompt, canAutoReplaceExamples, examplesAreManual, generatedItemsFromAnalysis, promptFingerprint } from '../../lib/improve/intake'
  import { shouldStopReloadedRun, stopReloadedRun } from '../../lib/improve/run-recovery'
  import { isRunnableProvider, providerKindFromBaseUrl } from '../../lib/improve/model-routing'
  import { nextPreflightAction, runPreflight, type PreflightResult } from '../../lib/improve/preflight'
  import { judgeRoute } from '../../lib/optimizer/judge'

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
  let detailsOpen = $state(false)
  let candidateOpen = $state(false)
  let alive = true
  let preparation = 0
  let saveState = $state<'saved' | 'saving' | 'error'>('saved')
  let saveQueue = Promise.resolve()
  const emptyState = { run: null, candidates: [], history: [], log: [], stage: null }
  const taskState = $derived($optimizationState.run?.taskId === task.id ? $optimizationState : emptyState)
  const activeElsewhere = $derived(!!$activeRunId && $optimizationState.run?.taskId !== task.id)
  const effectiveJudge = $derived(judgeRoute($settings.provider, $settings.arbitrator))
  const isDemo = $derived($settings.provider.baseUrl.startsWith('mock://'))
  const configured = $derived(isRunnableProvider($settings.provider) && !!$settings.provider.targetModel.trim() && !!effectiveJudge.model.trim())
  const bestFeedback = $derived(taskState.history.findLast((h) => h.childCandidateId === bestCandidate?.id)?.aggregatedFeedback ?? '')
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
  const bestIsCurrent = $derived(!!bestCandidate && task.initialPrompt.trim() === bestCandidate.text.trim())
  const chartPoints = $derived.by(() => {
    const scores = new Map(taskState.candidates.map((c) => [c.id, c.score]))
    return taskState.history.slice(-500).map((h) => ({ iter: h.index + 1, bestScore: scores.get(h.childCandidateId) ?? 0 }))
  })
  const primaryBusy = $derived(flowState === 'intake' || flowState === 'preflight' || flowState === 'starting')
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
    await loadItems()
    if (alive) await hydrateLatestRun()
  })

  onDestroy(() => {
    alive = false
    preparation++
    if (taskSaveTimer) { clearTimeout(taskSaveTimer); persistTask() }
    intakeController?.abort()
    preflightController?.abort()
  })

  async function hydrateLatestRun() {
    if (taskState.run && $activeRunId === taskState.run.id) { getState(); return }
    const runs = await listRuns(task.id)
    if (!runs.length) return
    let last = await getRun(runs[0].id)
    if (!last || !alive) return
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
    if (!alive || $activeRunId) return
    optimizationState.update((state) => ({
      ...state,
      run: last,
      candidates,
      history,
      stage: null,
    }))
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
    saveState = 'saving'
    saveQueue = saveQueue.catch(() => {}).then(() => saveTask(snapshot))
    void saveQueue.then(() => { if (alive) saveState = 'saved' }, () => { if (alive) saveState = 'error' })
  }

  function scheduleTaskSave() {
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
      if (items.length > 0) await clearDataset(ds.id)
      await addItems(ds.id, generatedItemsFromAnalysis(analysis, fp))
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
    if (!bestCandidate || bestIsCurrent) return
    task = { ...task, initialPrompt: bestCandidate.text }
    if (taskSaveTimer) clearTimeout(taskSaveTimer)
    persistTask()
    await saveQueue
    t.success($_('actions.saved'))
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
  <section class="readiness surface" aria-label={$_('workspace.modelsTitle')}>
    <div class="role"><span>{$_('workspace.targetRole')}</span><strong>{$settings.provider.targetModel || '—'}</strong></div>
    <div class="route-arrow" aria-hidden="true">→</div>
    <div class="role"><span>{$_('workspace.arbiterRole')}</span><strong>{effectiveJudge.model || '—'}</strong></div>
    <span class="readiness-label" class:ready={configured}>{isDemo ? $_('workspace.demo') : configured ? $_('workspace.ready') : $_('workspace.needsSetup')}</span>
    <Button variant="secondary" size="sm" onclick={() => modelsOpen = true} disabled={isRunning || isPaused}>{$_('workspace.configure')}</Button>
  </section>
  {#if activeElsewhere}
    <div class="notice" role="status">{$_('workspace.activeElsewhere')} <a href={`#/task/${$optimizationState.run?.taskId}/improve`}>{$_('workspace.openActive')}</a></div>
  {/if}
  <div class="prompt-pair">
    <section class="editor-panel surface">
      <div class="section-head"><div><span class="eyebrow">01 / INPUT</span><h2>{$_('workspace.current')}</h2></div><span class="save-status" role="status">{saveState === 'saved' ? $_('workspace.saved') : saveState === 'saving' ? $_('workspace.saving') : $_('workspace.saveFailed')}</span></div>
      <p class="supporting">{$_('workspace.currentHelp')}</p>
      <PromptEditor bind:value={task.initialPrompt} label={$_('workspace.current')} rows={10} oninput={scheduleTaskSave} />
      <div class="actions-row">
        {#if canStartRun}
          <Button size="lg" onclick={improve} loading={primaryBusy} disabled={!task.initialPrompt.trim() || activeElsewhere}>{$_('improve.primary')}</Button>
        {:else if isRunning}
          <Button variant="secondary" onclick={() => pause(run?.id)}>{$_('run.pause')}</Button>
          <Button variant="danger" onclick={() => stop(run?.id)}>{$_('run.stop')}</Button>
        {:else if isPaused}
          <Button onclick={() => resume(run?.id)}>{$_('run.resume')}</Button>
          <Button variant="danger" onclick={() => stop(run?.id)}>{$_('run.stop')}</Button>
        {/if}
        {#if primaryBusy}<Button variant="ghost" onclick={cancelPreparation}>{$_('workspace.cancel')}</Button>{/if}
      </div>
      <p class="supporting">{isRunning || isPaused ? $_('workspace.stopHelp') : $_('workspace.autoExamples')}</p>
      {#if flowError}<p class="error" role="alert">{flowError}</p>{:else if flowMessage}<p class="supporting" role="status">{flowMessage}</p>{/if}
    </section>
    <section class="result-panel surface" data-testid="run-result">
      <div class="section-head"><div><span class="eyebrow">02 / RESULT</span><h2>{$_('workspace.result')}</h2></div>{#if bestCandidate}<span class="score">{bestCandidate.score?.toFixed(2)}<small>/10</small></span>{/if}</div>
      {#if bestCandidate}
        <p class="supporting">{isRunning || isPaused ? $_('workspace.provisional') : $_('workspace.resultHelp')}</p>
        <pre class="result-prompt" data-testid="result-prompt">{bestCandidate.text}</pre>
        <div class="actions-row">
          <Button onclick={applyBest} disabled={bestIsCurrent || isRunning || isPaused}>{bestIsCurrent ? $_('improve.result.current') : $_('improve.result.apply')}</Button>
          <Button variant="secondary" onclick={copyBest}>{$_('common.copy')}</Button>
          <Button variant="ghost" onclick={() => compareOpen = true} disabled={isRunning || isPaused}>{$_('run.compare')}</Button>
          <Button variant="ghost" onclick={exportBest}>{$_('common.export')}</Button>
        </div>
        <details class="evidence"><summary>{$_('workspace.why')}</summary>
          <p>{$_('workspace.scoreHelp')}</p>
          <p>{$_('workspace.trials', { values: { count: bestCandidate.iterations, wins: bestCandidate.wins, losses: bestCandidate.losses, ties: bestCandidate.ties } })}</p>
          {#if bestCandidate.rationale}<h4>{$_('workspace.change')}</h4><p>{bestCandidate.rationale}</p>{/if}
          {#if bestFeedback}<h4>{$_('workspace.feedback')}</h4><pre>{bestFeedback}</pre>{/if}
        </details>
      {:else}
        <div class="empty-result"><span class="empty-glyph" aria-hidden="true">↗</span><h3>{$_('workspace.empty')}</h3><p>{$_('workspace.emptyHelp')}</p></div>
      {/if}
    </section>
  </div>
  {#if showStageFlow}
    <section class="run-strip surface" data-testid="run-status" data-status={run?.status ?? flowState}>
      <div class="section-head"><div><span class="eyebrow">{stageIterationText()}</span><h3>{$_(`improve.stage.steps.${stageLabelKey(currentStageKey)}`)}</h3></div><span class="supporting">{stageSampleText()}</span></div>
      <p class="supporting" role="status">{currentStageDetail()}</p>
      <div class="stage-meter" aria-hidden="true"><span style={`transform:scaleX(${stageProgress / 100})`}></span></div>
      <ol class="stage-steps" aria-label={$_('improve.stage.title')}>{#each phaseSteps as step}{@const status = phaseStatus(step)}<li class:done={status === 'done'} class:active={status === 'active'} class:error={status === 'error'} aria-current={status === 'active' ? 'step' : undefined}>{$_(`improve.stage.phases.${step}`)}</li>{/each}</ol>
      {#if run?.errorMessage}<p class="error" role="alert">{run.errorMessage}</p>{/if}
    </section>
  {/if}
  <details class="options surface" bind:open={detailsOpen}><summary>{$_('workspace.details')}<span>{$_('improve.examples.count', { values:{count:items.length} })}</span></summary>
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
    <details class="options surface" bind:open={candidateOpen}><summary>{$_('workspace.runDetails')}<span>{taskState.candidates.length} {$_('candidate.title')}</span></summary>
      {#if candidateOpen}<div class="run-details"><RunStats /><ProgressChart points={chartPoints} /><CandidateTimeline />{#if config.tokenBudget > 0}<TokenMeter used={(run?.totalTokensIn ?? 0) + (run?.totalTokensOut ?? 0)} budget={config.tokenBudget} />{/if}</div>{/if}
    </details>
  {/if}
</div>
<ModelSetupDialog bind:open={modelsOpen} />
{#if compareOpen}<CompareModal bind:open={compareOpen} taskId={task.id} {config} initialPromptA={task.initialPrompt} initialPromptB={bestCandidate?.text ?? task.initialPrompt} {items} />{/if}
<style>
  .workspace { display:flex; flex-direction:column; gap:20px; max-width:1600px; margin:0 auto; }
  .readiness { display:flex; align-items:center; gap:20px; padding:14px 20px; }
  .role { min-width:0; display:grid; gap:3px; }
  .role span,.eyebrow { color:var(--ink-3); font-size:11px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; }
  .role strong { font-family:var(--font-mono); font-size:13px; overflow-wrap:anywhere; }
  .route-arrow { color:var(--ink-3); }
  .readiness-label { color:var(--warn); font-size:12px; margin-left:auto; }
  .readiness-label.ready { color:var(--ink-2); }
  .prompt-pair { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:20px; }
  .editor-panel,.result-panel { min-width:0; padding:24px; display:flex; flex-direction:column; gap:14px; }
  .result-panel { border-color:color-mix(in srgb,var(--primary) 26%,var(--border-1)); }
  .section-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
  h2 { font-size:21px; margin-top:6px; } h3 { font-size:17px; }
  .supporting,.evidence p { color:var(--ink-2); font-size:13px; margin:0; line-height:1.6; }
  .save-status { color:var(--ink-3); font-size:11px; text-align:right; }
  .actions-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .result-prompt { white-space:pre-wrap; overflow-wrap:anywhere; min-height:260px; max-height:420px; overflow:auto; flex:1; line-height:1.7; padding:16px; font-size:13px; }
  .score { color:var(--primary); font-size:26px; font-variant-numeric:tabular-nums; }.score small { color:var(--ink-3); font-size:12px; margin-left:4px; }
  .empty-result { flex:1; min-height:280px; display:flex; align-items:center; justify-content:center; flex-direction:column; text-align:center; gap:12px; padding:32px; }
  .empty-result p { color:var(--ink-3); max-width:36ch; font-size:13px; }.empty-glyph { font-size:32px; color:var(--primary); }
  .run-strip { padding:20px 24px; display:grid; gap:12px; animation:surface-enter 180ms var(--ease-out); }
  .stage-meter { height:3px; background:var(--bg-3); overflow:hidden; border-radius:8px; }.stage-meter span { display:block; width:100%; height:100%; background:var(--primary); transform-origin:left; transition:transform 180ms var(--ease-out); }
  .stage-steps { list-style:none; padding:0; margin:0; display:flex; justify-content:space-between; gap:8px; color:var(--ink-3); font-size:12px; }.stage-steps li.active { color:var(--primary); font-weight:600; }.stage-steps li.done { color:var(--ok); }.error { color:var(--err); font-size:13px; }
  details summary { cursor:pointer; font-size:13px; min-height:44px; display:flex; align-items:center; gap:10px; font-weight:500; } details summary::before { content:'+'; color:var(--ink-3); } details[open]>summary::before { content:'−'; } summary span { margin-left:auto; color:var(--ink-3); font-size:12px; font-weight:400; }
  .options { padding:4px 20px; }.options-grid { display:grid; grid-template-columns:1fr 1fr; gap:32px; padding:16px 0 20px; }.options-grid section { min-width:0; display:grid; gap:12px; align-content:start; }.fields { display:grid; gap:12px; }.evidence { border-top:1px solid var(--border-1); }.evidence p,.evidence h4,.evidence pre { margin:8px 0; }.evidence h4 { font-size:13px; }.evidence pre { white-space:pre-wrap; font-size:12px; max-height:180px; overflow:auto; }
  .run-details { padding:12px 0 20px; display:grid; gap:20px; }.notice { border:1px solid var(--warn); padding:12px 16px; border-radius:8px; color:var(--warn); font-size:13px; }.notice a { margin-left:12px; }.checks { font-size:13px; }.settings-reset p { font-size:13px; color:var(--ink-2); }
  @media(max-width:1050px) { .readiness { gap:12px; flex-wrap:wrap; }.readiness-label { margin-left:0; }.editor-panel,.result-panel { padding:18px; } }
  @media(max-width:780px) { .prompt-pair,.options-grid { grid-template-columns:1fr; }.readiness { padding:14px; }.readiness .role { flex:1; }.readiness-label { flex-basis:50%; }.editor-panel,.result-panel { padding:16px; }.workspace { gap:14px; }.stage-steps { flex-wrap:wrap; }.empty-result { min-height:160px; }.result-prompt { min-height:180px; }.options { padding:4px 14px; } }
</style>
