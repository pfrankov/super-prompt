import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import TaskEditHost from './fixtures/TaskEditHost.svelte'
import TaskDetail from '../../src/routes/TaskDetail.svelte'
import { createTask } from '../../src/lib/db/tasks'
import * as datasets from '../../src/lib/db/datasets'
import { db, wipeAll } from '../../src/lib/db/db'
import { settings } from '../../src/stores/settings'
import { defaultSettings } from '../../src/lib/db/settings'
import { locale } from '../../src/lib/i18n'
import { start } from '../../src/stores/worker'
import type { Task } from '../../src/lib/types'

vi.mock('../../src/stores/worker', async () => {
  const { writable } = await import('svelte/store')
  const start = vi.fn()
  return {
    activeRunId: writable(null),
    preparingTaskId: writable(null),
    optimizationState: writable({ run: null, candidates: [], history: [], log: [], stage: null }),
    comparisonState: writable({ running: false, results: null, error: '' }),
    start, pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), getState: vi.fn(),
    prepareAndStartRun: vi.fn(async (taskId, config, signal) => {
      const { createRun } = await import('../../src/lib/db/runs')
      const run = await createRun(taskId, config, signal)
      start(run.id)
      return run
    }),
    resetComparison: vi.fn(), compareAB: vi.fn(),
  }
})
vi.mock('../../src/lib/improve/intake', async (original) => ({
  ...await original<typeof import('../../src/lib/improve/intake')>(),
  analyzePrompt: vi.fn(async () => ({ name: 'Generated', description: 'Description', rubric: 'Rubric', examples: [{ input: 'one' }, { input: 'two' }] })),
}))
const mounted: ReturnType<typeof mount>[] = []
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
function show(task: Task) {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const component = mount(TaskEditHost, { target, props: { initialTask: task, mode: 'workspace' } })
  mounted.push(component)
  flushSync()
  return { target, component }
}
function button(target: HTMLElement, name: string) {
  const found = [...target.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === name)
  expect(found).toBeDefined()
  return found!
}
beforeEach(async () => {
  await wipeAll(); sessionStorage.clear(); locale.set('en'); vi.clearAllMocks()
  const defaults = defaultSettings('en')
  settings.set({ ...defaults, provider: { ...defaults.provider, baseUrl: 'mock://super-prompt', targetModel: 'mock-target', judgeModel: 'mock-judge' } })
})
afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component)
  document.body.replaceChildren(); vi.restoreAllMocks()
})

it.each(['cancel', 'navigate'] as const)('never hides a dataset committed just before preparation %s', async (action) => {
  const task = await createTask({ initialPrompt: 'Prompt' })
  const gate = deferred()
  const original = datasets.ensureTaskDataset
  let createdId: string | undefined
  const creation = vi.spyOn(datasets, 'ensureTaskDataset').mockImplementationOnce(async (...args) => {
    const created = await original(...args)
    createdId = created.id
    await gate.promise
    return created
  })
  const { target, component } = show(task)
  await tick()
  button(target, 'Improve prompt').click()
  await vi.waitFor(() => expect(createdId).toBeDefined())
  flushSync()
  if (action === 'cancel') { button(target.querySelector('.run-strip')!, 'Cancel preparation').click(); flushSync(); expect(creation.mock.calls[0][2]?.aborted).toBe(true) }
  else { await unmount(component); mounted.splice(mounted.indexOf(component), 1) }
  gate.resolve()
  await creation.mock.results[0].value
  await tick(); flushSync()
  const database = await db()
  const stored = await database.get('tasks', task.id)
  expect(stored?.datasetId).toBe(createdId)
  expect(await database.countFromIndex('datasets', 'by-taskId', task.id)).toBe(1)
  expect(await database.count('datasets_items')).toBe(0)
  expect(start).not.toHaveBeenCalled()
})


async function showDetail(task: Task) {
  const target = document.createElement('div')
  document.body.appendChild(target)
  mounted.push(mount(TaskDetail, { target, props: { taskId: task.id } }))
  await vi.waitFor(() => { flushSync(); expect(target.querySelector('[data-testid="workspace-ready"]')).not.toBeNull() })
  return target
}

it('repeated cancellation during insertion rolls back and a real TaskDetail retry creates one linked dataset', async () => {
  const task = await createTask({ initialPrompt: 'Prompt' })
  const target = await showDetail(task)
  const database = await db()
  let cancelled = 0
  let cancelNext = true
  const add = IDBObjectStore.prototype.add
  vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (...args) {
    const request = add.apply(this, args)
    if (this.name === 'datasets' && args[0].taskId === task.id && cancelNext) request.addEventListener('success', () => {
      cancelNext = false
      cancelled++
      button(target, 'Cancel preparation').click()
      flushSync()
    }, { once: true })
    return request
  })
  for (let attempt = 1; attempt <= 3; attempt++) {
    cancelNext = true
    button(target, 'Improve prompt').click(); flushSync()
    await vi.waitFor(() => expect(cancelled).toBe(attempt))
    expect(await database.getAllFromIndex('datasets', 'by-taskId', task.id)).toEqual([])
    expect((await database.get('tasks', task.id))?.datasetId).toBeNull()
    expect(start).not.toHaveBeenCalled()
  }
  button(target, 'Improve prompt').click(); flushSync()
  await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1))
  const all = await database.getAllFromIndex('datasets', 'by-taskId', task.id)
  expect(all).toHaveLength(1)
  expect((await database.get('tasks', task.id))?.datasetId).toBe(all[0].id)
  expect(await datasets.getAllItems(all[0].id)).toHaveLength(2)
})

it('post-commit cancellation then same-task Dataset navigation and manual Add reuse the committed link', async () => {
  const task = await createTask({ initialPrompt: 'Prompt' })
  const target = await showDetail(task)
  const database = await db()
  const gate = deferred()
  const original = datasets.ensureTaskDataset
  let createdId: string | undefined
  const creation = vi.spyOn(datasets, 'ensureTaskDataset').mockImplementationOnce(async (...args) => {
    const created = await original(...args)
    createdId = created.id
    await gate.promise
    return created
  })
  button(target, 'Improve prompt').click(); flushSync()
  await vi.waitFor(() => expect(createdId).toBeDefined())
  button(target, 'Cancel preparation').click(); flushSync()
  expect(creation.mock.calls[0][2]?.aborted).toBe(true)
  target.querySelector<HTMLAnchorElement>('a[href$="/dataset"]')!.click(); flushSync()
  gate.resolve()
  await creation.mock.results[0].value
  await vi.waitFor(() => expect(target.querySelector('.add-action button')).not.toBeNull())
  const input = target.querySelector<HTMLTextAreaElement>('.add textarea')!
  input.value = 'New manual example'
  input.dispatchEvent(new Event('input', { bubbles: true })); flushSync()
  target.querySelector<HTMLButtonElement>('.add-action button')!.click()
  await vi.waitFor(async () => expect(await database.count('datasets_items')).toBe(1))
  expect(await database.getAllFromIndex('datasets', 'by-taskId', task.id)).toHaveLength(1)
  expect((await database.get('tasks', task.id))?.datasetId).toBe(createdId)
  expect((await datasets.getAllItems(createdId!)).map((item) => item.input)).toEqual(['New manual example'])
})
