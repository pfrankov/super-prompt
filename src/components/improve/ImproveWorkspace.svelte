<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { get } from 'svelte/store'
  import { onDestroy, onMount } from 'svelte'
  import type { Dataset, DatasetItem, ProviderConfig, RunConfig, RunStage, RunStageKey, Task } from '../../lib/types'
  import { addItems, clearDataset, createDataset, getAllItems, getDataset } from '../../lib/db/datasets'
  import { createRun, getCandidates, getIterations, getRun, listRuns } from '../../lib/db/runs'
  import { saveTask } from '../../lib/db/tasks'
  import { saveSettings, settings } from '../../stores/settings'
  import { optimizationState, pause, reset, resume, start, stop } from '../../stores/worker'
  import { t } from '../../stores/toast'
  import { analyzePrompt, canAutoReplaceExamples, examplesAreManual, generatedItemsFromAnalysis, promptFingerprint } from '../../lib/improve/intake'
  import { isRunnableProvider, providerKindFromBaseUrl } from '../../lib/improve/model-routing'
  import { nextPreflightAction, runPreflight, type PreflightResult } from '../../lib/improve/preflight'
  import { judgeRoute } from '../../lib/optimizer/judge'

  import Button from '../ui/Button.svelte'
  import PromptEditor from '../ui/PromptEditor.svelte'
  import TextField from '../ui/TextField.svelte'
  import NumberField from '../ui/NumberField.svelte'
  import Tag from '../ui/Tag.svelte'
  import ProgressChart from '../chart/ProgressChart.svelte'
  import RunStats from '../run/RunStats.svelte'
  import CandidateTimeline from '../run/CandidateTimeline.svelte'
  import TokenMeter from '../run/TokenMeter.svelte'
  import CompareModal from '../compare/CompareModal.svelte'

  let { task = $bindable() as Task }: { task: Task } = $props()

  type FlowState = 'idle' | 'intake' | 'preflight' | 'starting' | 'error'
  type PhaseKey = 'prepare' | 'mutate' | 'answer' | 'judge' | 'decide' | 'done'
  type StageStatus = 'pending' | 'active' | 'done' | 'error'
  type WorkCell = { label: string; status: StageStatus }
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
  let configEdited = $state(false)
  let tempsEdited = $state(false)
  let taskSaveTimer: number | undefined
  let providerSaveTimer: number | undefined
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

  const plan = $derived(smartPlan($settings.provider.baseUrl, items.length))
  const promptFingerprintNow = $derived(promptFingerprint(task.initialPrompt))
  const canGenerateExamples = $derived(
    !!task.initialPrompt.trim()
    && !!$settings.provider.targetModel.trim()
    && isRunnableProvider($settings.provider)
    && canAutoReplaceExamples(items, promptFingerprintNow)
  )
  const run = $derived($optimizationState.run)
  const isRunning = $derived(run?.status === 'running')
  const isPaused = $derived(run?.status === 'paused')
  const isStopped = $derived(run?.status === 'stopped' || run?.status === 'completed' || run?.status === 'failed')
  const bestCandidate = $derived(
    run?.bestCandidateId
      ? $optimizationState.candidates.find((c) => c.id === run.bestCandidateId) ?? null
      : $optimizationState.candidates.reduce<typeof $optimizationState.candidates[number] | null>(
          (b, c) => (c.score != null && (!b || c.score > (b.score ?? 0)) ? c : b),
          null
        )
  )
  const bestIsCurrent = $derived(!!bestCandidate && task.initialPrompt.trim() === bestCandidate.text.trim())
  const chartPoints = $derived(
    $optimizationState.history.map((h) => ({
      iter: h.index + 1,
      bestScore: $optimizationState.candidates.find((c) => c.id === h.childCandidateId)?.score ?? 0,
    }))
  )
  const primaryBusy = $derived(flowState === 'intake' || flowState === 'preflight' || flowState === 'starting')
  const nextAction = $derived(preflight ? nextPreflightAction(preflight.steps) : '')
  const currentStageKey = $derived(resolveCurrentStageKey())
  const liveStage = $derived(stageForView())
  const showStageFlow = $derived(primaryBusy || isRunning || isPaused || run?.status === 'failed' || run?.status === 'stopped')
  const hasRunSummary = $derived(!!run && (isRunning || isPaused || run.status === 'failed' || run.status === 'stopped' || $optimizationState.history.length > 0))
  const stageProgress = $derived(stageProgressPercent())

  $effect(() => {
    if (configEdited) return
    $settings.provider.baseUrl
    items.length
    applySmartPlan()
  })

  onMount(async () => {
    reset()
    await loadItems()
    await hydrateLatestRun()
  })

  onDestroy(() => {
    if (taskSaveTimer) clearTimeout(taskSaveTimer)
    if (providerSaveTimer) clearTimeout(providerSaveTimer)
    intakeController?.abort()
    preflightController?.abort()
  })

  async function hydrateLatestRun() {
    const runs = await listRuns(task.id)
    if (!runs.length) return
    const last = await getRun(runs[0].id)
    if (!last) return
    const [candidates, history] = await Promise.all([
      getCandidates(last.id),
      getIterations(last.id),
    ])
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

  function scheduleTaskSave() {
    preflight = null
    flowError = ''
    if (taskSaveTimer) clearTimeout(taskSaveTimer)
    taskSaveTimer = window.setTimeout(() => {
      void saveTask(taskSnapshot())
    }, 500)
  }

  function scheduleProviderSave() {
    preflight = null
    flowError = ''
    if (providerSaveTimer) clearTimeout(providerSaveTimer)
    providerSaveTimer = window.setTimeout(() => {
      void saveSettings({ provider: get(settings).provider })
    }, 500)
  }

  function updateProvider(patch: Partial<ProviderConfig>) {
    const snapshot = get(settings)
    settings.set({
      ...snapshot,
      provider: {
        ...snapshot.provider,
        ...patch,
      },
    })
    scheduleProviderSave()
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
    return $optimizationState.stage?.key ?? null
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
    if ($optimizationState.stage) return $optimizationState.stage
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
        if ($optimizationState.stage?.key && $optimizationState.stage.key !== key) {
          return phaseForStage($optimizationState.stage.key)
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
      const lastPhase = phaseForStage($optimizationState.stage?.key ?? 'starting')
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

  function stageScoreText(): string {
    if (liveStage?.parentScore == null && liveStage?.challengerScore == null) return ''
    return $_('improve.stage.scores', { values: { parent: scoreText(liveStage?.parentScore), child: scoreText(liveStage?.challengerScore) } })
  }

  function hasPairContext(): boolean {
    return !!(
      liveStage?.parentCandidateId
      || liveStage?.challengerCandidateId
      || liveStage?.parentScore != null
      || liveStage?.challengerScore != null
    )
  }

  function pairWorkCells(): WorkCell[] {
    const count = liveStage?.sampleCount ?? 0
    if (!count || !currentStageKey) return []
    const afterAnswer = ['judging', 'scoring', 'persisting', 'completed'].includes(currentStageKey)
    const afterJudge = ['scoring', 'persisting', 'completed'].includes(currentStageKey)
    const activeAnswer = currentStageKey === 'answering'
    const activeJudge = currentStageKey === 'judging'
    const sampleIndex = Math.max(0, liveStage?.sampleIndex ?? 0)
    const cells: WorkCell[] = []
    for (let i = 1; i <= count; i += 1) {
      cells.push({
        label: $_('improve.stage.work.answer', { values: { n: i } }),
        status: afterAnswer || (activeAnswer && i < sampleIndex) ? 'done' : activeAnswer && i === sampleIndex ? 'active' : 'pending',
      })
    }
    for (let i = 1; i <= count; i += 1) {
      cells.push({
        label: $_('improve.stage.work.judge', { values: { n: i } }),
        status: afterJudge || (activeJudge && i < sampleIndex) ? 'done' : activeJudge && i === sampleIndex ? 'active' : 'pending',
      })
    }
    return cells
  }

  function decisionText(): string {
    if (currentStageKey === 'failed') return $_('improve.stage.decision.failed')
    if (currentStageKey === 'stopped') return $_('improve.stage.decision.stopped')
    if (currentStageKey === 'paused') return $_('improve.stage.decision.paused')
    if (currentStageKey === 'completed') return $_('improve.stage.decision.complete')
    if (currentStageKey === 'intake' || currentStageKey === 'preflight' || currentStageKey === 'starting') return $_('improve.stage.decision.setup')
    if (currentStageKey !== 'scoring' && currentStageKey !== 'persisting') return $_('improve.stage.decision.waiting')
    const parentScore = liveStage?.parentScore
    const childScore = liveStage?.challengerScore
    if (parentScore == null || childScore == null) return $_('improve.stage.decision.scoring')
    if (Math.abs(parentScore - childScore) < 0.05) return $_('improve.stage.decision.tie')
    return childScore > parentScore ? $_('improve.stage.decision.challenger') : $_('improve.stage.decision.parent')
  }

  function verdictStatsText(): string {
    if (liveStage?.wins == null && liveStage?.losses == null && liveStage?.ties == null) return ''
    return $_('improve.stage.verdicts', {
      values: {
        parent: liveStage?.wins ?? 0,
        challenger: liveStage?.losses ?? 0,
        ties: liveStage?.ties ?? 0,
        failed: liveStage?.failedPairs ?? 0,
      },
    })
  }

  async function runIntake(): Promise<boolean> {
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
      if ((e as Error).name === 'AbortError') return false
      flowState = 'error'
      flowError = e instanceof Error ? e.message : String(e)
      return false
    }
  }

  async function runChecks(): Promise<boolean> {
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
      flowState = 'error'
      flowError = e instanceof Error ? e.message : String(e)
      return false
    }
  }

  async function improve() {
    if (!task.initialPrompt.trim()) {
      t.error($_('errors.noPrompt'))
      return
    }
    if (!$settings.provider.targetModel.trim()) {
      flowError = $_('improve.status.modelNeeded')
      return
    }
    await saveTask(taskSnapshot())
    if (items.length < 2 || canAutoReplaceExamples(items, promptFingerprintNow)) {
      const ok = await runIntake()
      if (!ok) return
    }
    await loadItems()
    if (items.length < 2) {
      flowError = $_('errors.noDataset')
      return
    }
    flowState = 'starting'
    flowMessage = $_('improve.status.starting')
    const run = await createRun(task.id, config)
    start(run.id)
    flowState = 'idle'
    flowMessage = ''
  }

  async function copyBest() {
    if (!bestCandidate) return
    await navigator.clipboard.writeText(bestCandidate.text)
    t.success($_('common.copied'))
  }

  async function applyBest() {
    if (!bestCandidate || bestIsCurrent) return
    task = { ...task, initialPrompt: bestCandidate.text }
    await saveTask(taskSnapshot())
    t.success($_('actions.saved'))
  }

  function exportBest() {
    if (!bestCandidate) return
    const blob = new Blob(
      [JSON.stringify({
        task: { id: task.id, name: task.name, description: task.description },
        bestPrompt: bestCandidate.text,
        score: bestCandidate.score,
        candidates: $optimizationState.candidates,
        iterations: $optimizationState.history,
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
</script>

<div class="workspace">
  <div class="main-flow">
  <section class="primary surface">
    <div class="primary-head">
      <div>
        <h2>{$_('improve.title')}</h2>
        <p>{$_('improve.subtitle')}</p>
      </div>
    </div>

    <PromptEditor
      bind:value={task.initialPrompt}
      label={$_('improve.promptLabel')}
      placeholder={$_('improve.promptPlaceholder')}
      rows={12}
      oninput={scheduleTaskSave}
    />

    <div class="model-row">
      <TextField
        value={$settings.provider.targetModel}
        label={$_('settings.targetModel')}
        placeholder="gemma4:e2b"
        oninput={(value) => updateProvider({ targetModel: value })}
      />
      <div class="judge-chip">
        <span class="chip-label">{$_('improve.judgeLabel')}</span>
        <strong>{$settings.arbitrator.enabled ? $settings.arbitrator.model : $settings.provider.judgeModel}</strong>
      </div>
    </div>

    <div class="actions-row">
      {#if !run || isStopped}
        <div class="primary-action">
          <Button full size="lg" onclick={improve} loading={primaryBusy} disabled={!task.initialPrompt.trim()}>
            {$_('improve.primary')}
          </Button>
        </div>
      {:else if isRunning}
        <Button variant="secondary" onclick={pause}>{$_('run.pause')}</Button>
        <Button variant="danger" onclick={stop}>{$_('run.stop')}</Button>
      {:else if isPaused}
        <Button variant="primary" onclick={resume}>{$_('run.resume')}</Button>
        <Button variant="danger" onclick={stop}>{$_('run.stop')}</Button>
      {/if}
      <Button variant="ghost" onclick={() => void runIntake()} disabled={!task.initialPrompt.trim() || primaryBusy}>
        {$_('improve.regenerateExamples')}
      </Button>
      <Button variant="ghost" onclick={runChecks} disabled={!task.initialPrompt.trim() || items.length < 2 || primaryBusy}>
        {$_('improve.check')}
      </Button>
    </div>

    {#if flowMessage || flowError || nextAction}
      <div class:error-state={!!flowError} class="status-line">
        <span>{flowError || nextAction || flowMessage}</span>
      </div>
    {/if}

    {#if showStageFlow}
      <div class="stage-flow" aria-live="polite">
        <div class="stage-current">
          <div class="stage-copy">
            <span>{$_('improve.stage.now')}</span>
            <strong>{$_(`improve.stage.steps.${stageLabelKey(currentStageKey)}`)}</strong>
            <p>{currentStageDetail()}</p>
          </div>
          <div class="stage-metrics">
            {#if stageIterationText()}<span>{stageIterationText()}</span>{/if}
            {#if stageSampleText()}<span>{stageSampleText()}</span>{/if}
            {#if stageScoreText()}<span>{stageScoreText()}</span>{/if}
          </div>
        </div>
        <div class="stage-meter" aria-hidden="true">
          <span style={`transform: scaleX(${stageProgress / 100})`}></span>
        </div>
        {#if hasPairContext()}
          <div class="versus-board" aria-label={$_('improve.stage.matchup')}>
            <div>
              <span>{$_('improve.stage.parent')}</span>
              <strong>{shortCandidate(liveStage?.parentCandidateId)}</strong>
              <small>{scoreText(liveStage?.parentScore)}</small>
            </div>
            <span class="versus">vs</span>
            <div>
              <span>{$_('improve.stage.challenger')}</span>
              <strong>{shortCandidate(liveStage?.challengerCandidateId)}</strong>
              <small>{scoreText(liveStage?.challengerScore)}</small>
            </div>
          </div>
        {/if}
        {#if pairWorkCells().length}
          <div class="work-cells" aria-label={$_('improve.stage.work.title')}>
            {#each pairWorkCells() as cell, i (`${cell.label}-${i}`)}
              <span class:done={cell.status === 'done'} class:active={cell.status === 'active'} class:error={cell.status === 'error'}>
                <i aria-hidden="true"></i>{cell.label}
              </span>
            {/each}
          </div>
        {/if}
        <div class="decision-row">
          <strong>{decisionText()}</strong>
          {#if verdictStatsText()}<span>{verdictStatsText()}</span>{/if}
        </div>
        <ol class="stage-steps" aria-label={$_('improve.stage.title')}>
          {#each phaseSteps as step}
            {@const status = phaseStatus(step)}
            <li
              class:done={status === 'done'}
              class:active={status === 'active'}
              class:error={status === 'error'}
              aria-current={status === 'active' ? 'step' : undefined}
            >
              <span class="step-dot" aria-hidden="true"></span>
              <span>{$_(`improve.stage.phases.${step}`)}</span>
            </li>
          {/each}
        </ol>
      </div>
    {/if}
  </section>

  <section class="result surface">
    {#if bestCandidate}
      <div class="result-head">
        <div>
          <h3>{$_('improve.result.title')}</h3>
          <p>{$_('improve.result.body')}</p>
        </div>
        <Tag tone="ok">{bestCandidate.score?.toFixed(2) ?? '-'}</Tag>
      </div>
      <pre>{bestCandidate.text}</pre>
      <div class="result-actions">
        <Button size="sm" onclick={copyBest}>{$_('common.copy')}</Button>
        <Button size="sm" variant="secondary" onclick={applyBest} disabled={bestIsCurrent}>
          {bestIsCurrent ? $_('improve.result.current') : $_('improve.result.apply')}
        </Button>
        <Button size="sm" variant="ghost" onclick={() => (compareOpen = true)}>{$_('run.compare')}</Button>
        <Button size="sm" variant="ghost" onclick={exportBest}>{$_('common.export')}</Button>
      </div>
    {:else}
      <div class="empty-result">
        <h3>{$_('improve.result.emptyTitle')}</h3>
        <p>{$_('improve.result.emptyBody')}</p>
      </div>
    {/if}
  </section>

  {#if hasRunSummary}
    <section class="run-details">
      <div class="run-state surface">
        <div class="run-state-head">
          <div>
            <h3>{$_('run.summaryTitle')}</h3>
            <p>{$_('run.summaryBody')}</p>
          </div>
          <Tag tone={run?.status === 'running' ? 'info' : run?.status === 'paused' ? 'warn' : run?.status === 'failed' ? 'err' : run?.status === 'completed' ? 'ok' : 'neutral'}>
            {run ? $_('run.status.' + run.status) : $_('run.noRun')}
          </Tag>
        </div>
        {#if config.tokenBudget > 0}
          <div class="budget">
            <span class="dim">{$_('run.tokensLeft')}</span>
            <TokenMeter used={(run?.totalTokensIn ?? 0) + (run?.totalTokensOut ?? 0)} budget={config.tokenBudget} />
          </div>
        {/if}
        <RunStats />
        <div class="chart">
          <ProgressChart points={chartPoints} />
        </div>
      </div>
      {#if $optimizationState.candidates.length}
        <details class="candidate-details">
          <summary>{$_('candidate.title')}</summary>
          <CandidateTimeline />
        </details>
      {/if}
    </section>
  {/if}
  </div>

  <aside class="side">
    <section class="panel setup-panel surface">
      <div class="panel-head">
        <h3>{$_('improve.setup.title')}</h3>
      </div>

      <div class="setup-section">
        <div class="section-head">
          <span>{$_('improve.examples.title')}</span>
          <Tag tone={items.length >= 2 ? 'ok' : canGenerateExamples ? 'info' : 'warn'}>
            {items.length >= 2
              ? $_('improve.setup.ready')
              : $_('improve.setup.needsExamples', { values: { count: Math.max(0, 2 - items.length) } })}
          </Tag>
        </div>
        <p class="panel-copy">{$_('improve.examples.body')}</p>
        {#if items.length}
          <ol class="examples">
            {#each items.slice(0, 4) as item (item.id)}
              <li>
                <span>{item.input}</span>
                {#if item.meta?.difficulty}<Tag tone="neutral">{item.meta.difficulty}</Tag>{/if}
              </li>
            {/each}
          </ol>
        {:else}
          <p class="empty">{$_('improve.examples.empty')}</p>
        {/if}
      </div>

      <div class="setup-section">
        <div class="section-head">
          <span>{$_('run.plan.title')}</span>
          <Tag tone={configEdited ? 'warn' : plan.kind === 'local' ? 'info' : 'accent'}>
            {configEdited ? $_('run.plan.custom') : $_(plan.kind === 'local' ? 'run.plan.local' : 'run.plan.cloud')}
          </Tag>
        </div>
        <p class="panel-copy">
          {configEdited
            ? $_('run.plan.customBody')
            : $_(plan.kind === 'local' ? 'run.plan.localBody' : 'run.plan.cloudBody')}
        </p>
        {#if configEdited}
          <div class="setup-actions">
            <Button size="sm" variant="ghost" onclick={applySmartPlan}>{$_('run.plan.apply')}</Button>
          </div>
        {/if}
      </div>

      <details>
        <summary>{$_('run.advanced')}</summary>
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

      {#if preflight}
        <div class="setup-section">
          <div class="section-head">
            <span>{$_('improve.preflight.title')}</span>
            <Tag tone={preflight.ready ? 'ok' : 'err'}>{preflight.ready ? $_('improve.preflight.ready') : $_('improve.preflight.needsWork')}</Tag>
          </div>
          <div class="checks">
            {#each preflight.steps as step, i (`${step.key}-${i}`)}
              <div class:bad={step.status === 'fail'} class:warn={step.status === 'warn'} class="check-row">
                <span>{step.status === 'ok' ? '✓' : step.status === 'warn' ? '!' : '×'}</span>
                <p>{step.message}</p>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </section>
  </aside>
</div>

<CompareModal
  bind:open={compareOpen}
  taskId={task.id}
  {config}
  initialPromptA={task.initialPrompt}
  initialPromptB={bestCandidate?.text ?? task.seedPrompts[0] ?? task.initialPrompt}
  {items}
/>

<style>
  .workspace {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 340px;
    gap: var(--s-5);
    align-items: start;
  }
  .main-flow {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-5);
  }
  .primary,
  .result,
  .run-state,
  .panel {
    padding: var(--s-5);
  }
  .primary {
    display: flex;
    flex-direction: column;
    gap: var(--s-5);
    background: var(--bg-1);
    border-color: var(--border-2);
  }
  .stage-flow,
  .status-line,
  .result,
  .run-state,
  .candidate-details {
    animation: surface-enter 220ms var(--ease-out);
  }
  .primary-head,
  .result-head,
  .panel-head,
  .run-state-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-3);
  }
  .primary-head p,
  .result-head p,
  .panel-copy,
  .empty-result p {
    color: var(--ink-2);
    margin: var(--s-1) 0 0;
    max-width: 68ch;
    font-size: var(--fs-sm);
    line-height: 1.5;
  }
  .primary-head h2,
  .result-head h3 {
    font-size: var(--fs-2xl);
  }
  .model-row {
    display: grid;
    grid-template-columns: minmax(220px, 1fr) minmax(220px, 0.72fr);
    gap: var(--s-3);
    align-items: stretch;
  }
  .judge-chip {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    min-width: 0;
    min-height: 72px;
    padding: var(--s-3) var(--s-4);
    background: color-mix(in srgb, var(--bg-2) 80%, black);
    border: 1px solid var(--border-1);
    border-radius: var(--r-md);
    color: var(--ink-2);
    font-size: var(--fs-sm);
  }
  .judge-chip strong {
    color: var(--ink-1);
    font-family: var(--font-mono);
    overflow-wrap: anywhere;
  }
  .chip-label {
    color: var(--ink-3);
    font-size: var(--fs-xs);
  }
  .actions-row,
  .result-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
    align-items: center;
  }
  .primary-action {
    display: inline-flex;
  }
  .status-line {
    display: flex;
    align-items: center;
    min-height: 40px;
    padding: var(--s-3) var(--s-4);
    background: rgba(159, 191, 216, 0.08);
    border: 1px solid rgba(159, 191, 216, 0.22);
    color: var(--ink-2);
    border-radius: var(--r-md);
    font-size: var(--fs-sm);
  }
  .status-line.error-state {
    background: rgba(232, 170, 163, 0.1);
    border-color: rgba(232, 170, 163, 0.3);
    color: var(--err);
  }
  .stage-flow {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
    padding-top: var(--s-4);
    border-top: 1px solid var(--border-1);
  }
  .stage-current {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--s-4);
    align-items: start;
  }
  .stage-copy {
    min-width: 0;
  }
  .stage-copy > span {
    display: block;
    color: var(--ink-3);
    font-size: var(--fs-xs);
    margin-bottom: 2px;
  }
  .stage-copy strong {
    display: block;
    color: var(--ink-1);
    font-size: var(--fs-lg);
    line-height: var(--lh-tight);
  }
  .stage-copy p {
    margin: var(--s-1) 0 0;
    color: var(--ink-2);
    font-size: var(--fs-sm);
    line-height: 1.45;
    max-width: 72ch;
    overflow-wrap: anywhere;
  }
  .stage-metrics {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--s-2);
    max-width: 360px;
  }
  .stage-metrics span {
    min-height: 26px;
    display: inline-flex;
    align-items: center;
    padding: 0 var(--s-2);
    border-radius: var(--r-sm);
    background: color-mix(in srgb, var(--bg-2) 72%, black);
    border: 1px solid var(--border-1);
    color: var(--ink-2);
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
  }
  .stage-meter {
    position: relative;
    height: 4px;
    overflow: hidden;
    border-radius: var(--r-pill);
    background: color-mix(in srgb, var(--bg-2) 80%, black);
  }
  .stage-meter span {
    position: absolute;
    inset: 0 auto 0 0;
    width: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, var(--acc-sky), var(--primary));
    transform-origin: left center;
    transition: transform 220ms var(--ease-out);
  }
  .versus-board {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    gap: var(--s-2);
    align-items: stretch;
  }
  .versus-board > div {
    min-width: 0;
    display: grid;
    gap: 2px;
    padding: var(--s-3);
    border: 1px solid var(--border-1);
    border-radius: var(--r-md);
    background: color-mix(in srgb, var(--bg-2) 72%, black);
  }
  .versus-board span,
  .versus-board small {
    color: var(--ink-3);
    font-size: var(--fs-xs);
  }
  .versus-board strong {
    min-width: 0;
    color: var(--ink-1);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .versus {
    align-self: center;
    color: var(--ink-4);
    font-size: var(--fs-xs);
  }
  .work-cells {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(74px, 1fr));
    gap: var(--s-2);
  }
  .work-cells span {
    min-width: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 28px;
    padding: 0 var(--s-2);
    border: 1px solid var(--border-1);
    border-radius: var(--r-sm);
    background: color-mix(in srgb, var(--bg-2) 70%, black);
    color: var(--ink-3);
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
    transition: background-color 180ms var(--ease), border-color 180ms var(--ease), color 180ms var(--ease), transform 180ms var(--ease-out);
  }
  .work-cells i {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    border: 1px solid currentColor;
  }
  .work-cells span.done {
    color: var(--ok);
    border-color: rgba(159, 202, 173, 0.28);
    background: rgba(159, 202, 173, 0.07);
  }
  .work-cells span.done i {
    background: var(--ok);
    border-color: var(--ok);
  }
  .work-cells span.active {
    color: var(--ink-1);
    border-color: rgba(238, 183, 124, 0.42);
    background: rgba(238, 183, 124, 0.1);
    transform: translateY(-1px);
  }
  .work-cells span.active i {
    background: var(--primary);
    border-color: var(--primary);
    animation: stage-pulse 1.15s var(--ease-out) infinite;
  }
  .decision-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-2);
    min-height: 34px;
    padding: var(--s-2) var(--s-3);
    border: 1px solid var(--border-1);
    border-radius: var(--r-md);
    color: var(--ink-2);
    background: rgba(159, 191, 216, 0.05);
    font-size: var(--fs-sm);
  }
  .decision-row strong {
    color: var(--ink-1);
    font-weight: 600;
  }
  .decision-row span {
    color: var(--ink-3);
    font-size: var(--fs-xs);
  }
  .stage-steps {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: var(--s-2);
    padding: 0;
    margin: 0;
    list-style: none;
  }
  .stage-steps li {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--ink-4);
    font-size: var(--fs-xs);
    line-height: 1.25;
    transition: color var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease);
  }
  .stage-steps li > span:last-child {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .step-dot {
    flex: 0 0 auto;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    border: 1px solid currentColor;
    background: transparent;
    transition: background-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
  }
  .stage-steps li.done {
    color: var(--ink-2);
  }
  .stage-steps li.done .step-dot {
    background: var(--ok);
    border-color: var(--ok);
  }
  .stage-steps li.active {
    color: var(--ink-1);
    transform: translateY(-1px);
  }
  .stage-steps li.active .step-dot {
    background: var(--primary);
    border-color: var(--primary);
    box-shadow: 0 0 0 5px rgba(238, 183, 124, 0.12);
    animation: stage-pulse 1.15s var(--ease-out) infinite;
  }
  .stage-steps li.error {
    color: var(--err);
  }
  .stage-steps li.error .step-dot {
    background: var(--err);
    border-color: var(--err);
    box-shadow: 0 0 0 5px rgba(232, 170, 163, 0.12);
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }
  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    background: color-mix(in srgb, var(--bg-1) 92%, black);
  }
  .panel-head h3 { font-size: var(--fs-lg); }
  .setup-panel {
    position: sticky;
    top: var(--s-4);
    max-height: calc(100vh - var(--s-8));
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }
  .setup-section {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    padding-top: var(--s-4);
    border-top: 1px solid var(--border-1);
  }
  .setup-section:first-of-type {
    padding-top: 0;
    border-top: 0;
  }
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-2);
    color: var(--ink-1);
    font-size: var(--fs-sm);
    font-weight: 600;
  }
  .examples {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    padding: 0;
    margin: 0;
    list-style: none;
  }
  .examples li {
    display: flex;
    justify-content: space-between;
    gap: var(--s-2);
    padding: 10px var(--s-3);
    background: color-mix(in srgb, var(--bg-2) 72%, black);
    border: 1px solid var(--border-1);
    border-radius: var(--r-sm);
    color: var(--ink-2);
    font-size: var(--fs-sm);
  }
  .examples li span:first-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .empty {
    margin: 0;
    color: var(--ink-3);
    font-size: var(--fs-sm);
  }
  .setup-actions {
    display: flex;
    justify-content: flex-start;
  }
  details {
    border-top: 1px solid var(--border-1);
    padding-top: var(--s-3);
  }
  summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-2);
    color: var(--ink-2);
    cursor: pointer;
    font-size: var(--fs-sm);
    list-style: none;
    transition: color var(--dur-fast) var(--ease);
  }
  summary::-webkit-details-marker { display: none; }
  summary:hover { color: var(--ink-1); }
  summary::after {
    content: "+";
    color: var(--ink-3);
    font-size: var(--fs-lg);
    line-height: 1;
    transition: transform var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
  }
  details[open] summary::after {
    content: "-";
    color: var(--primary);
  }
  .fields {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--s-3);
    margin-top: var(--s-3);
  }
  details[open] .fields {
    animation: panel-reveal 180ms var(--ease-out);
  }
  .checks {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }
  .check-row {
    display: grid;
    grid-template-columns: 20px 1fr;
    gap: var(--s-2);
    color: var(--ok);
    font-size: var(--fs-sm);
  }
  .check-row p {
    margin: 0;
    color: var(--ink-2);
  }
  .check-row.warn {
    color: var(--warn);
  }
  .check-row.bad {
    color: var(--err);
  }
  .result {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }
  .result pre {
    max-height: 340px;
    background: color-mix(in srgb, var(--bg-0) 86%, black);
    border-color: var(--border-2);
    white-space: pre-wrap;
    overflow: auto;
  }
  .empty-result {
    min-height: 140px;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .run-details {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }
  .run-state {
    background: color-mix(in srgb, var(--bg-1) 94%, black);
  }
  .run-state-head h3 {
    font-size: var(--fs-lg);
  }
  .run-state-head p {
    margin: var(--s-1) 0 0;
    color: var(--ink-3);
    font-size: var(--fs-sm);
    line-height: 1.45;
  }
  .chart {
    height: 220px;
    margin-top: var(--s-4);
    min-width: 0;
  }
  .budget {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
  }
  .candidate-details {
    padding: var(--s-3) var(--s-4);
    background: color-mix(in srgb, var(--bg-1) 94%, black);
    border: 1px solid var(--border-1);
    border-radius: var(--r-lg);
  }
  .candidate-details summary {
    min-height: 30px;
  }
  .candidate-details[open] summary {
    margin-bottom: var(--s-3);
  }
  @media (max-width: 980px) {
    .workspace {
      grid-template-columns: 1fr;
    }
    .setup-panel {
      position: static;
      max-height: none;
      overflow: visible;
      scrollbar-gutter: auto;
    }
    .stage-steps {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }
  @media (max-width: 680px) {
    .workspace { gap: var(--s-4); }
    .primary,
    .result,
    .run-state,
    .panel {
      padding: var(--s-4);
    }
    .primary {
      gap: var(--s-4);
    }
    .judge-chip {
      min-height: 58px;
    }
    .model-row {
      grid-template-columns: 1fr;
    }
    .stage-current {
      grid-template-columns: 1fr;
    }
    .stage-metrics {
      justify-content: flex-start;
      max-width: none;
    }
    .stage-steps {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .versus-board {
      grid-template-columns: 1fr;
    }
    .versus {
      justify-self: center;
    }
    .primary-head,
    .result-head,
    .panel-head,
    .run-state-head {
      flex-direction: column;
    }
    .primary-head {
      flex-direction: row;
      align-items: flex-start;
    }
    .primary-head > div {
      min-width: 0;
    }
    .primary-head h2,
    .result-head h3 {
      font-size: var(--fs-xl);
    }
    .actions-row :global(button) {
      min-width: 0;
    }
    .actions-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      align-items: stretch;
    }
    .primary-action {
      grid-column: 1 / -1;
    }
    .actions-row :global(.btn) {
      width: 100%;
      min-height: 44px;
      height: auto;
      padding-block: var(--s-2);
      white-space: normal;
    }
    .actions-row :global(.label) {
      text-align: center;
      line-height: 1.25;
    }
  }
  @keyframes surface-enter {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes panel-reveal {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes stage-pulse {
    0%, 100% { box-shadow: 0 0 0 4px rgba(238, 183, 124, 0.1); }
    50% { box-shadow: 0 0 0 8px rgba(238, 183, 124, 0.18); }
  }
</style>
