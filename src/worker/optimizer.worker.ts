import type {
  MainToWorker,
  WorkerToMain,
} from '../lib/optimizer/protocol'
import { getRun, getCandidates, getIterations, patchRun, addCandidate } from '../lib/db/runs'
import { getTask } from '../lib/db/tasks'
import { getDataset, getAllItems } from '../lib/db/datasets'
import { getSettings } from '../lib/db/settings'
import { comparePrompts, createRunner, type Ctx } from './loop'
import type { PromptCandidate, Run, Task, DatasetItem, ProviderConfig, ArbitratorConfig, RunConfig } from '../lib/types'
import { newId } from '../lib/util/id'

let runner: ReturnType<typeof createRunner> | null = null
let comparisonController: AbortController | null = null
let starting = false
let executing = false
let stopDuringStart = false

function send(msg: WorkerToMain) {
  ;(self as unknown as Worker).postMessage(msg)
}

async function stopPersistedRun(runId?: string) {
  if (!runId) return
  const existing = await getRun(runId)
  if (!existing) { send({ type: 'DONE', finalCandidateId: null }); return }

  const finishedAt = Date.now()
  if (!['stopped', 'completed', 'failed'].includes(existing.status)) {
    await patchRun(runId, { status: 'stopped', finishedAt, errorMessage: null })
  }
  const [run, candidates, history] = await Promise.all([
    getRun(runId),
    getCandidates(runId),
    getIterations(runId),
  ])
  if (!run) { send({ type: 'DONE', finalCandidateId: null }); return }

  send({
    type: 'STATE',
    state: {
      run,
      candidates,
      history,
      log: [{ ts: finishedAt, level: 'info', msg: 'stopped by user' }],
      stage: {
        key: run.status === 'failed' || run.status === 'completed' ? run.status : 'stopped',
        iteration: run.iterationCount,
        totalIterations: run.config.iterationsCap,
        updatedAt: finishedAt,
      },
    },
  })
  send({ type: 'DONE', finalCandidateId: run.bestCandidateId })
}

async function failStartupRun(runId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? error.stack : undefined
  try {
    await patchRun(runId, { status: 'failed', finishedAt: Date.now(), errorMessage: message })
  } catch (persistenceError) {
    const detail = persistenceError instanceof Error ? persistenceError.message : String(persistenceError)
    send({ type: 'CONTROL_ERROR', runId, message: `${message}; could not save failed startup: ${detail}. Reload to retry recovery.`, stack })
    return
  }
  send({ type: 'ERROR', message, stack })
}

async function loadCompareCtx(taskId: string, config: RunConfig): Promise<Ctx> {
  const task = await getTask(taskId)
  if (!task) throw new Error('task not found')
  const dataset = task.datasetId ? await getDataset(task.datasetId) : null
  const items: DatasetItem[] = dataset ? await getAllItems(dataset.id) : []
  if (items.length === 0) throw new Error('dataset has no items')
  const settings = await getSettings()
  return {
    task,
    items,
    provider: settings.provider,
    arbitrator: settings.arbitrator,
    config,
  }
}

self.onmessage = async (e: MessageEvent<MainToWorker>) => {
  const msg = e.data
  const controlRunner = runner
  try {
    switch (msg.type) {
      case 'START': {
        if (starting || executing) return
        starting = true
        stopDuringStart = false
        runner = null
        const runId = msg.payload.runId
        try {
        const run = await getRun(runId)
        if (!run) throw new Error('run not found')
        const task = await getTask(run.taskId)
        if (!task) throw new Error('task not found')
        const dataset = task.datasetId ? await getDataset(task.datasetId) : null
        const items: DatasetItem[] = dataset ? await getAllItems(dataset.id) : []
        if (items.length < 2) throw new Error('dataset has fewer than 2 items')
        const settings = await getSettings()
        const provider: ProviderConfig = settings.provider
        const arbitrator: ArbitratorConfig | undefined = settings.arbitrator
        // Hydrate initial candidates: parent (task.initialPrompt) + seeds
        const initialCandidates = await getCandidates(runId)
        if (initialCandidates.length === 0) {
          const seedPrompts = [task.initialPrompt, ...task.seedPrompts].filter(Boolean)
          for (let i = 0; i < seedPrompts.length; i++) {
            const c: PromptCandidate = {
              id: newId(),
              runId,
              parentId: null,
              text: seedPrompts[i],
              source: 'seed',
              score: null,
              wins: 0,
              losses: 0,
              ties: 0,
              iterations: 0,
              tokensIn: 0,
              tokensOut: 0,
              createdAt: Date.now(),
            }
            await addCandidate(c)
            initialCandidates.push(c)
          }
        }
        if (stopDuringStart) { await stopPersistedRun(runId); return }
        runner = createRunner({
          runId,
          initialRun: run,
          initialCandidates,
          ctx: { task, items, provider, arbitrator, config: run.config },
          send,
        })
        starting = false
        executing = true
        await runner.start()
        } catch (error) {
          await failStartupRun(runId, error)
        } finally { starting = false; executing = false }
        break
      }
      case 'PAUSE':
        await controlRunner?.pause()
        break
      case 'RESUME':
        await controlRunner?.resume()
        break
      case 'STOP':
        if (starting) { stopDuringStart = true; break }
        if (controlRunner) {
          const wasExecuting = executing
          await controlRunner.stop()
          if (!wasExecuting) send({ type: 'DONE', finalCandidateId: controlRunner.snapshot().run?.bestCandidateId ?? null })
        } else await stopPersistedRun(msg.payload?.runId)
        break
      case 'CANCEL_COMPARE':
        comparisonController?.abort()
        break
      case 'COMPARE_AB': {
        comparisonController?.abort()
        const controller = new AbortController()
        comparisonController = controller
        try {
          const ctx = await loadCompareCtx(msg.payload.taskId, msg.payload.config)
          controller.signal.throwIfAborted()
          ctx.signal = controller.signal
          const results = await comparePrompts(ctx, msg.payload.promptA, msg.payload.promptB, msg.payload.itemIds)
          send({ type: 'LOG', entry: { ts: Date.now(), level: 'info', msg: `compareAB: ${results.length} pairs done` } })
          send({ type: 'COMPARE_RESULT', requestId: msg.payload.requestId, results })
        } catch (e) {
          const err = e as Error
          send({ type: 'COMPARE_ERROR', requestId: msg.payload.requestId, message: err.message, stack: err.stack })
        }
        break
      }
      case 'GET_STATE':
        if (runner) send({ type: 'STATE', state: runner.snapshot() })
        break
      case 'UPDATE_SETTINGS': {
        if (runner) {
          runner.updateCtx({
            provider: msg.payload.provider,
            arbitrator: msg.payload.arbitrator,
            config: msg.payload.config,
          })
        }
        break
      }
    }
  } catch (e) {
    const err = e as Error
    if (msg.type === 'PAUSE' || msg.type === 'RESUME' || msg.type === 'STOP') {
      const state = controlRunner?.snapshot()
      const runId = msg.payload?.runId ?? state?.run?.id
      if (state && controlRunner === runner) send({ type: 'STATE', state })
      if (runId) send({ type: 'CONTROL_ERROR', runId, message: state?.run?.errorMessage || `${err.message}. Reload to retry recovery.`, stack: err.stack })
    } else {
      const runId = controlRunner?.snapshot().run?.id
      if (runId) send({ type: 'CONTROL_ERROR', runId, message: err.message, stack: err.stack })
      else send({ type: 'LOG', entry: { ts: Date.now(), level: 'error', msg: err.message } })
    }
  }
}

// (no-op)
