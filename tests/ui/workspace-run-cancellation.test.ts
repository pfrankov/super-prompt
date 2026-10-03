import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import { get } from 'svelte/store'
import TaskEditHost from './fixtures/TaskEditHost.svelte'
import { createTask, deleteTask } from '../../src/lib/db/tasks'
import { ensureTaskDataset, addItems } from '../../src/lib/db/datasets'
import * as runs from '../../src/lib/db/runs'
import { wipeAll } from '../../src/lib/db/db'
import { settings } from '../../src/stores/settings'
import { defaultSettings } from '../../src/lib/db/settings'
import { locale } from '../../src/lib/i18n'
import { activeRunId, optimizationState, stop, getState, start } from '../../src/stores/worker'
import { toasts } from '../../src/stores/toast'
import type { Run, Task } from '../../src/lib/types'

const posted: { type: string }[] = []
class FakeWorker {
  static instances: FakeWorker[] = []
  constructor() { FakeWorker.instances.push(this) }
  onmessage: unknown
  onerror: unknown
  postMessage(message: { type: string }) { posted.push(message) }
  terminate() {}
}
const mounted: ReturnType<typeof mount>[] = []
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
function button(target: HTMLElement, name: string) {
  const found = [...target.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === name)
  expect(found).toBeDefined()
  return found!
}
async function taskFixture() {
  const task = await createTask({ initialPrompt: 'Original' })
  const dataset = await ensureTaskDataset(task.id)
  await addItems(dataset.id, [{ input: 'One' }, { input: 'Two' }])
  return { ...task, datasetId: dataset.id }
}
async function show(task: Task) {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const component = mount(TaskEditHost, { target, props: { initialTask: task, mode: 'workspace' } })
  mounted.push(component)
  await vi.waitFor(() => { flushSync(); expect(target.textContent).toContain('2 examples') })
  return { target, component }
}
async function cancel(view: Awaited<ReturnType<typeof show>>, action: 'cancel' | 'navigate') {
  if (action === 'cancel') { button(view.target, 'Cancel preparation').click(); flushSync() }
  else { await unmount(view.component); mounted.splice(mounted.indexOf(view.component), 1) }
}
beforeEach(async () => {
  await wipeAll(); sessionStorage.clear(); locale.set('en'); posted.length = 0
  activeRunId.set(null)
  optimizationState.set({ run: null, candidates: [], history: [], log: [], stage: null })
  toasts.set([])
  vi.stubGlobal('Worker', FakeWorker)
  const defaults = defaultSettings('en')
  settings.set({ ...defaults, provider: { ...defaults.provider, baseUrl: 'mock://super-prompt', targetModel: 'mock-target', judgeModel: 'mock-judge' } })
})
afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component)
  vi.restoreAllMocks()
  const owned = get(activeRunId)
  if (owned) { stop(owned); await tick() }
  document.body.replaceChildren(); vi.unstubAllGlobals()
})

it.each(['cancel', 'navigate'] as const)('keeps post-commit cleanup failure visible and owned after %s, then recovers', async (action) => {
  const task = await taskFixture()
  const gate = deferred()
  const original = runs.createRun
  let created: Run | undefined
  const creation = vi.spyOn(runs, 'createRun').mockImplementationOnce(async (...args) => {
    created = await original(...args)
    await gate.promise
    return created
  })
  const view = await show(task)
  getState()
  const idleWorker = FakeWorker.instances.at(-1)!
  button(view.target, 'Improve prompt').click(); flushSync()
  await vi.waitFor(() => expect(created).toBeDefined())
  const cleanup = vi.spyOn(runs, 'patchRun').mockRejectedValueOnce(new Error('Cleanup storage unavailable'))
  await cancel(view, action)
  gate.resolve()
  await creation.mock.results[0].value
  await vi.waitFor(() => expect(cleanup).toHaveBeenCalled())
  await tick(); flushSync()
  expect((await runs.getRun(created!.id))?.status).toBe('idle')
  expect(get(activeRunId)).toBe(created!.id)
  expect(get(optimizationState).run?.errorMessage).toContain('Cleanup storage unavailable')
  expect(get(toasts).some((toast) => toast.msg.includes('Reload'))).toBe(true)
  expect(posted.some((message) => message.type === 'START')).toBe(false)
  if (action === 'navigate') {
    ;(idleWorker.onmessage as (event: unknown) => void)({ data: { type: 'DONE', finalCandidateId: null } })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    await (idleWorker.onerror as (event: unknown) => Promise<void>)({ message: 'Idle worker crashed' })
    consoleError.mockRestore()
    expect(get(activeRunId)).toBe(created!.id)
    expect(get(optimizationState).run?.errorMessage).toContain('Cleanup storage unavailable')
  }
  const current = action === 'navigate' ? await show(task) : view
  expect(button(current.target, 'Improve prompt').disabled).toBe(true)
  expect(current.target.querySelector('[role="alert"]')?.textContent).toContain('Reload')
  stop(created!.id)
  await vi.waitFor(() => expect(get(activeRunId)).toBeNull())
  expect(await runs.getRun(created!.id)).toMatchObject({ status: 'stopped', errorMessage: null })
  expect(get(optimizationState).run?.errorMessage).toBeNull()
})

it('rolls back a run cancelled during the real insert transaction', async () => {
  const task = await taskFixture()
  const view = await show(task)
  const put = IDBObjectStore.prototype.put
  let cancelled = false
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (...args) {
    const request = put.apply(this, args)
    if (this.name === 'runs' && !cancelled) request.addEventListener('success', () => {
      cancelled = true
      button(view.target, 'Cancel preparation').click(); flushSync()
    }, { once: true })
    return request
  })
  button(view.target, 'Improve prompt').click(); flushSync()
  await vi.waitFor(() => expect(cancelled).toBe(true))
  await vi.waitFor(() => expect(get(activeRunId)).toBeNull())
  expect(await runs.listRuns(task.id)).toEqual([])
  expect(posted.some((message) => message.type === 'START')).toBe(false)
})

it('reserves creation across workspaces and releases an already-deleted cancelled row', async () => {
  const firstTask = await taskFixture()
  const secondTask = await taskFixture()
  const first = await show(firstTask)
  const second = await show(secondTask)
  const gate = deferred()
  const original = runs.createRun
  let created: Run | undefined
  const creation = vi.spyOn(runs, 'createRun').mockImplementationOnce(async (...args) => {
    created = await original(...args)
    await gate.promise
    return created
  })
  button(first.target, 'Improve prompt').click(); flushSync()
  await vi.waitFor(() => expect(created).toBeDefined())
  expect(button(second.target, 'Improve prompt').disabled).toBe(true)
  expect(first.target.querySelector('.notice')).toBeNull()
  expect(second.target.querySelector('.notice a')?.getAttribute('href')).toBe(`#/task/${firstTask.id}/improve`)
  button(second.target, 'Improve prompt').click(); flushSync()
  expect(creation).toHaveBeenCalledTimes(1)
  await cancel(first, 'navigate')
  await deleteTask(firstTask.id)
  gate.resolve()
  await creation.mock.results[0].value
  await vi.waitFor(() => expect(get(activeRunId)).toBeNull())
  expect(await runs.getRun(created!.id)).toBeUndefined()
  button(second.target, 'Improve prompt').click(); flushSync()
  await vi.waitFor(() => expect(posted.filter((message) => message.type === 'START')).toHaveLength(1))
  expect(await runs.listRuns(secondTask.id)).toHaveLength(1)
})

it('admits only one of two preparations already in progress before reservation', async () => {
  const firstTask = await taskFixture()
  const secondTask = await taskFixture()
  const first = await show(firstTask)
  const second = await show(secondTask)
  const gate = deferred()
  const original = runs.createRun
  let created: Run | undefined
  const creation = vi.spyOn(runs, 'createRun').mockImplementation(async (...args) => {
    created = await original(...args)
    await gate.promise
    return created
  })
  button(first.target, 'Improve prompt').click()
  button(second.target, 'Improve prompt').click()
  flushSync()
  await vi.waitFor(() => expect(created).toBeDefined())
  await tick(); flushSync()
  expect(creation).toHaveBeenCalledTimes(1)
  await cancel(first, 'navigate')
  await cancel(second, 'navigate')
  gate.resolve()
  await vi.waitFor(() => expect(get(activeRunId)).toBeNull())
  const all = [...await runs.listRuns(firstTask.id), ...await runs.listRuns(secondTask.id)]
  expect(all).toHaveLength(1)
  expect(all[0].status).toBe('stopped')
  expect(posted.some((message) => message.type === 'START')).toBe(false)
})

it('does not let an idle worker or a conflicting start release a pending creation reservation', async () => {
  const task = await taskFixture()
  const view = await show(task)
  getState()
  const oldWorker = FakeWorker.instances.at(-1)!
  const gate = deferred()
  const original = runs.createRun
  let created: Run | undefined
  vi.spyOn(runs, 'createRun').mockImplementationOnce(async (...args) => {
    created = await original(...args)
    await gate.promise
    return created
  })
  button(view.target, 'Improve prompt').click(); flushSync()
  await vi.waitFor(() => expect(created).toBeDefined())
  const reservation = get(activeRunId)
  const stateBefore = get(optimizationState)
  await start('conflicting-existing-run')
  ;(oldWorker.onmessage as (event: unknown) => void)({ data: { type: 'DONE', finalCandidateId: null } })
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  await (oldWorker.onerror as (event: unknown) => Promise<void>)({ message: 'Idle worker crashed' })
  consoleError.mockRestore()
  expect(get(activeRunId)).toBe(reservation)
  expect(get(optimizationState)).toEqual(stateBefore)
  expect(posted.some((message) => message.type === 'START')).toBe(false)
  await cancel(view, 'cancel')
  gate.resolve()
  await vi.waitFor(() => expect(get(activeRunId)).toBeNull())
  expect(await runs.getRun(created!.id)).toMatchObject({ status: 'stopped' })
})
