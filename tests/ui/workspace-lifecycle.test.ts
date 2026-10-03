import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import { get } from 'svelte/store'
import ImproveWorkspace from '../../src/components/improve/ImproveWorkspace.svelte'
import { createTask, deleteTask } from '../../src/lib/db/tasks'
import { createDataset, addItems } from '../../src/lib/db/datasets'
import * as runsDb from '../../src/lib/db/runs'
import { db, wipeAll } from '../../src/lib/db/db'
import { settings } from '../../src/stores/settings'
import { defaultSettings } from '../../src/lib/db/settings'
import { activeRunId, optimizationState, start } from '../../src/stores/worker'
import type { PromptCandidate, Run, RunConfig, Task } from '../../src/lib/types'

vi.mock('../../src/stores/worker', async () => {
  const { writable } = await import('svelte/store')
  return {
    activeRunId: writable(null),
    preparingTaskId: writable(null),
    optimizationState: writable({ run: null, candidates: [], history: [], log: [], stage: null }),
    comparisonState: writable({ running: false, results: null, error: '' }),
    start: vi.fn(), prepareAndStartRun: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), getState: vi.fn(),
    resetComparison: vi.fn(), compareAB: vi.fn(),
  }
})

const config: RunConfig = { iterationsCap: 3, tokenBudget: 0, concurrency: 1, sampleSizePerIter: 2, earlyStopPlateau: 2, judgeTemperature: 0, targetTemperature: 0, mutatorTemperature: 0 }
const empty = { run: null, candidates: [], history: [], log: [], stage: null }
const mounted: ReturnType<typeof mount>[] = []
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function show(task: Task) {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const component = mount(ImproveWorkspace, { target, props: { task } })
  mounted.push(component)
  flushSync()
  return { target, component }
}
async function savedRevision(task: Task, text: string) {
  const run = await runsDb.createRun(task.id, config)
  const candidate: PromptCandidate = { id: `${run.id}-best`, runId: run.id, parentId: null, text, source: 'mutated', score: 8, wins: 2, losses: 0, ties: 0, iterations: 2, tokensIn: 10, tokensOut: 20, createdAt: 1 }
  await runsDb.addCandidate(candidate)
  await runsDb.patchRun(run.id, { status: 'completed', bestCandidateId: candidate.id })
  return { run: (await runsDb.getRun(run.id))!, candidate }
}
function activate(run: Run) {
  optimizationState.set({ ...empty, run: { ...run, status: 'running' } })
  activeRunId.set(run.id)
  flushSync()
}

beforeEach(async () => {
  await wipeAll()
  sessionStorage.clear()
  activeRunId.set(null)
  optimizationState.set(empty)
  const defaults = defaultSettings('en')
  settings.set({ ...defaults, provider: { ...defaults.provider, baseUrl: 'mock://super-prompt', targetModel: 'mock-target', judgeModel: 'mock-judge' } })
  vi.clearAllMocks()
})
afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component)
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('workspace task lifecycle', () => {
  it('stops Improve after another tab deletes the task without starting a worker or creating children', async () => {
    const task = await createTask({ initialPrompt: 'Original prompt' })
    const ds = await createDataset(task.id)
    await addItems(ds.id, [{ input: 'one' }, { input: 'two' }])
    task.datasetId = ds.id
    const { target } = show(task)
    await vi.waitFor(() => expect(target.textContent).toContain('2 examples'))
    await deleteTask(task.id)
    const improve = [...target.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Improve prompt')!
    expect(improve).toBeDefined()
    improve.click()
    await vi.waitFor(() => expect(target.querySelector('[role="alert"]')?.textContent).toContain('This prompt no longer exists'))
    expect(start).not.toHaveBeenCalled()
    const d = await db()
    expect(await d.count('runs')).toBe(0)
    expect(await d.count('datasets')).toBe(0)
  })

  it('restores the viewed task revision when a different active task finishes without remounting', async () => {
    const taskA = await createTask({ initialPrompt: 'A' })
    const taskB = await createTask({ initialPrompt: 'B' })
    const revision = await savedRevision(taskB, 'Saved B revision')
    const active = await runsDb.createRun(taskA.id, config)
    const gate = deferred<PromptCandidate[]>()
    const original = runsDb.getCandidates
    const read = vi.spyOn(runsDb, 'getCandidates').mockImplementationOnce(() => gate.promise).mockImplementation(original)
    // Begin hydration, then make A active before B's query finishes.
    const { target } = show(taskB)
    await vi.waitFor(() => expect(read).toHaveBeenCalledWith(revision.run.id))
    activate(active)
    gate.resolve([revision.candidate])
    await gate.promise
    await tick()
    flushSync()
    expect(get(optimizationState).run?.id).toBe(active.id)
    activeRunId.set(null)
    flushSync()
    await vi.waitFor(() => expect(target.querySelector('[data-testid="result-prompt"]')?.textContent).toBe('Saved B revision'))
    expect(get(optimizationState).run?.id).toBe(revision.run.id)
  })
})


it('defers opening B history while A is already active and restores it when A finishes', async () => {
  const taskA = await createTask({ initialPrompt: 'A' })
  const taskB = await createTask({ initialPrompt: 'B' })
  const revision = await savedRevision(taskB, 'B revision after A')
  const active = await runsDb.createRun(taskA.id, config)
  activate(active)
  const read = vi.spyOn(runsDb, 'listRuns')
  const { target } = show(taskB)
  await tick()
  flushSync()
  expect(read).not.toHaveBeenCalled()
  expect(get(optimizationState).run?.id).toBe(active.id)
  expect(target.querySelector('[data-testid="result-prompt"]')).toBeNull()
  optimizationState.update((state) => ({ ...state, run: { ...active, status: 'completed' } }))
  activeRunId.set(null)
  flushSync()
  await vi.waitFor(() => expect(target.querySelector('[data-testid="result-prompt"]')?.textContent).toBe('B revision after A'))
  expect(get(optimizationState).run?.id).toBe(revision.run.id)
})

it('does not let stale B hydration overwrite a newly active C run', async () => {
  const taskB = await createTask({ initialPrompt: 'B' })
  const taskC = await createTask({ initialPrompt: 'C' })
  const revision = await savedRevision(taskB, 'Stale B revision')
  const active = await runsDb.createRun(taskC.id, config)
  const gate = deferred<PromptCandidate[]>()
  const read = vi.spyOn(runsDb, 'getCandidates').mockReturnValueOnce(gate.promise)
  const { target } = show(taskB)
  await vi.waitFor(() => expect(read).toHaveBeenCalledWith(revision.run.id))
  activate(active)
  gate.resolve([revision.candidate])
  await gate.promise
  await tick()
  flushSync()
  expect(get(optimizationState).run?.id).toBe(active.id)
  expect(get(activeRunId)).toBe(active.id)
  expect(target.querySelector('[data-testid="result-prompt"]')).toBeNull()
})

it('does not replace a newer current-task result with the previous database snapshot', async () => {
  const task = await createTask({ initialPrompt: 'B' })
  const old = await savedRevision(task, 'Old B revision')
  const gate = deferred<PromptCandidate[]>()
  const read = vi.spyOn(runsDb, 'getCandidates').mockReturnValueOnce(gate.promise)
  const { target } = show(task)
  await vi.waitFor(() => expect(read).toHaveBeenCalledWith(old.run.id))
  const newer = await savedRevision(task, 'Newest B revision')
  optimizationState.set({ ...empty, run: newer.run, candidates: [newer.candidate] })
  gate.resolve([old.candidate])
  await gate.promise
  await tick()
  flushSync()
  expect(get(optimizationState).run?.id).toBe(newer.run.id)
  expect(target.querySelector('[data-testid="result-prompt"]')?.textContent).toBe('Newest B revision')
})

it('ignores an unmounted B query after navigating to C', async () => {
  const taskB = await createTask({ initialPrompt: 'B' })
  const taskC = await createTask({ initialPrompt: 'C' })
  const old = await savedRevision(taskB, 'Old B revision')
  const current = await savedRevision(taskC, 'Current C revision')
  const gate = deferred<PromptCandidate[]>()
  const read = vi.spyOn(runsDb, 'getCandidates').mockReturnValueOnce(gate.promise)
  const previous = show(taskB)
  await vi.waitFor(() => expect(read).toHaveBeenCalledWith(old.run.id))
  await unmount(previous.component)
  mounted.splice(mounted.indexOf(previous.component), 1)
  const next = show(taskC)
  await vi.waitFor(() => expect(next.target.querySelector('[data-testid="result-prompt"]')?.textContent).toBe('Current C revision'))
  gate.resolve([old.candidate])
  await gate.promise
  await tick()
  flushSync()
  expect(get(optimizationState).run?.id).toBe(current.run.id)
  expect(next.target.querySelector('[data-testid="result-prompt"]')?.textContent).toBe('Current C revision')
})
