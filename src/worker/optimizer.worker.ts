import type {
  MainToWorker,
  WorkerToMain,
} from '../lib/optimizer/protocol'
import { getRun, getCandidates } from '../lib/db/runs'
import { getTask } from '../lib/db/tasks'
import { getDataset, getAllItems } from '../lib/db/datasets'
import { getSettings } from '../lib/db/settings'
import { comparePrompts, createRunner, type Ctx } from './loop'
import type { PromptCandidate, Run, Task, DatasetItem, ProviderConfig, ArbitratorConfig, RunConfig } from '../lib/types'
import { newId } from '../lib/util/id'

let runner: ReturnType<typeof createRunner> | null = null
let initialCandidates: PromptCandidate[] = []

function send(msg: WorkerToMain) {
  ;(self as unknown as Worker).postMessage(msg)
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
  try {
    switch (msg.type) {
      case 'START': {
        const runId = msg.payload.runId
        const run = await getRun(runId)
        if (!run) throw new Error('run not found')
        const task = await getTask(run.taskId)
        if (!task) throw new Error('task not found')
        const dataset = task.datasetId ? await getDataset(task.datasetId) : null
        const items: DatasetItem[] = dataset ? await getAllItems(dataset.id) : []
        if (items.length < 2) {
          send({ type: 'ERROR', message: 'dataset has fewer than 2 items' })
          return
        }
        const settings = await getSettings()
        const provider: ProviderConfig = settings.provider
        const arbitrator: ArbitratorConfig | undefined = settings.arbitrator
        // Hydrate initial candidates: parent (task.initialPrompt) + seeds
        initialCandidates = await getCandidates(runId)
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
            initialCandidates.push(c)
          }
        }
        runner = createRunner({
          runId,
          initialRun: run,
          initialCandidates,
          ctx: { task, items, provider, arbitrator, config: run.config },
          send,
        })
        await runner.start()
        break
      }
      case 'PAUSE':
        await runner?.pause()
        break
      case 'RESUME':
        await runner?.resume()
        break
      case 'STOP':
        await runner?.stop()
        break
      case 'COMPARE_AB': {
        try {
          const ctx = runner?.getCtx() ?? await loadCompareCtx(msg.payload.taskId, msg.payload.config)
          const results = await comparePrompts(ctx, msg.payload.promptA, msg.payload.promptB, msg.payload.itemIds)
          send({ type: 'LOG', entry: { ts: Date.now(), level: 'info', msg: `compareAB: ${results.length} pairs done` } })
          send({ type: 'COMPARE_RESULT', results })
        } catch (e) {
          const err = e as Error
          send({ type: 'COMPARE_ERROR', message: err.message, stack: err.stack })
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
    send({ type: 'ERROR', message: err.message, stack: err.stack })
  }
}

// (no-op)
