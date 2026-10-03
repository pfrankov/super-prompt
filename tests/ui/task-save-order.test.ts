import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import TaskEditHost from './fixtures/TaskEditHost.svelte'
import * as tasks from '../../src/lib/db/tasks'
import { db, wipeAll } from '../../src/lib/db/db'
import * as databaseModule from '../../src/lib/db/db'
import { readPromptDraft, stagePromptDraft } from '../../src/lib/db/prompt-drafts'
import { locale } from '../../src/lib/i18n'
import type { Task } from '../../src/lib/types'

const mounted: ReturnType<typeof mount>[] = []
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
function show(task: Task, mode: 'workspace' | 'overview') {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const component = mount(TaskEditHost, { target, props: { initialTask: task, mode } })
  mounted.push(component)
  flushSync()
  // Keep the native editor for this mount, just as an immediately typing user does.
  target.querySelector<HTMLTextAreaElement>('.fallback textarea')?.focus()
  return { target, component }
}
function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
  flushSync()
}
function unloadPrevented() {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}
function saveButton(target: HTMLElement) {
  return [...target.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Save')!
}
beforeEach(async () => { await wipeAll(); sessionStorage.clear(); locale.set('en') })
afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component)
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

it.each([['workspace', 'recovered draft\r\n'], ['workspace', ''], ['overview', 'recovered draft\r\n'], ['overview', '']] as const)('immediately retries a recovered journal in %s (%j) and protects it until actual commit', async (mode, draft) => {
  const task = await tasks.createTask({ initialPrompt: 'durable original' })
  stagePromptDraft(task.id, draft)
  const recovered = (await tasks.getTask(task.id))!
  const pending = gate()
  const database = await db()
  let blocked = false
  vi.spyOn(databaseModule, 'db').mockImplementationOnce(async () => { blocked = true; await pending.promise; return database })
  const write = vi.spyOn(tasks, 'patchTask')
  const { target } = show(recovered, mode)
  await vi.waitFor(() => expect(write).toHaveBeenCalled())
  await vi.waitFor(() => expect(blocked).toBe(true))
  expect(readPromptDraft(task.id)).toBe(draft)
  expect((await (await db()).get('tasks', task.id))?.initialPrompt).toBe('durable original')
  expect(unloadPrevented()).toBe(true)
  if (mode === 'workspace') expect(target.querySelector('.save-status')?.textContent).toContain('Saving')
  pending.resolve()
  await vi.waitFor(async () => expect((await (await db()).get('tasks', task.id))?.initialPrompt).toBe(draft))
  await vi.waitFor(() => expect(readPromptDraft(task.id)).toBeNull())
  await vi.waitFor(() => expect(unloadPrevented()).toBe(false))
})

it('a delayed workspace teardown save preserves later Overview name and rubric edits', async () => {
  const task = await tasks.createTask({ name: 'Original name', initialPrompt: 'Original prompt', rubric: { text: 'Original rubric' } })
  const pending = gate()
  const workspace = show(task, 'workspace')
  input(workspace.target.querySelector<HTMLTextAreaElement>('.fallback textarea')!, 'Workspace draft')
  const database = await db()
  let delayed = false
  vi.spyOn(databaseModule, 'db').mockImplementationOnce(async () => { delayed = true; await pending.promise; return database })
  await unmount(workspace.component)
  mounted.splice(mounted.indexOf(workspace.component), 1)
  await vi.waitFor(() => expect(delayed).toBe(true))
  const overview = show((await tasks.getTask(task.id))!, 'overview')
  input(overview.target.querySelector<HTMLInputElement>('input')!, 'New overview name')
  input([...overview.target.querySelectorAll<HTMLTextAreaElement>('label.field textarea')].at(-1)!, 'New overview rubric')
  saveButton(overview.target).click()
  // Overview's later write is queued behind the older teardown write.
  expect((await (await db()).get('tasks', task.id))?.name).toBe('Original name')
  pending.resolve()
  await vi.waitFor(async () => expect((await (await db()).get('tasks', task.id))?.name).toBe('New overview name'))
  await vi.waitFor(() => expect(readPromptDraft(task.id)).toBeNull())
  expect(await (await db()).get('tasks', task.id)).toMatchObject({ name: 'New overview name', rubric: { text: 'New overview rubric' }, initialPrompt: 'Workspace draft' })
})

it('a stale Overview save changes only edited fields, preserving newer prompt and dataset assignment', async () => {
  const task = await tasks.createTask({ name: 'Name', initialPrompt: 'Old prompt', datasetId: 'old-dataset' })
  const overview = show(task, 'overview')
  await tasks.saveTask({ ...task, initialPrompt: 'New workspace prompt', datasetId: 'new-dataset' })
  input(overview.target.querySelector<HTMLInputElement>('input')!, 'Overview rename')
  saveButton(overview.target).click()
  await vi.waitFor(async () => expect((await (await db()).get('tasks', task.id))?.name).toBe('Overview rename'))
  expect(await (await db()).get('tasks', task.id)).toMatchObject({ initialPrompt: 'New workspace prompt', datasetId: 'new-dataset' })
})


it('a newer Overview prompt edit wins over the delayed older workspace and recovery writes', async () => {
  const task = await tasks.createTask({ initialPrompt: 'Original prompt' })
  const workspace = show(task, 'workspace')
  input(workspace.target.querySelector<HTMLTextAreaElement>('.fallback textarea')!, 'Older workspace draft')
  const database = await db()
  const pending = gate()
  let blocked = false
  vi.spyOn(databaseModule, 'db').mockImplementationOnce(async () => { blocked = true; await pending.promise; return database })
  await unmount(workspace.component)
  mounted.splice(mounted.indexOf(workspace.component), 1)
  await vi.waitFor(() => expect(blocked).toBe(true))
  const overview = show((await tasks.getTask(task.id))!, 'overview')
  input(overview.target.querySelector<HTMLTextAreaElement>('.fallback textarea')!, 'Newer Overview prompt')
  saveButton(overview.target).click()
  expect((await (await db()).get('tasks', task.id))?.initialPrompt).toBe('Original prompt')
  pending.resolve()
  await vi.waitFor(async () => expect((await (await db()).get('tasks', task.id))?.initialPrompt).toBe('Newer Overview prompt'))
  await vi.waitFor(() => expect(saveButton(overview.target).disabled).toBe(true))
  expect(readPromptDraft(task.id)).toBeNull()
})

it.each(['workspace', 'overview'] as const)('keeps a failed recovered %s draft protected and retries on remount', async (mode) => {
  const task = await tasks.createTask({ initialPrompt: 'Durable original' })
  stagePromptDraft(task.id, 'Recovered after failure')
  const recovered = (await tasks.getTask(task.id))!
  vi.spyOn(tasks, 'patchTask').mockRejectedValueOnce(new Error('Synthetic quota failure'))
  const first = show(recovered, mode)
  await vi.waitFor(() => expect(unloadPrevented()).toBe(true))
  expect(readPromptDraft(task.id)).toBe('Recovered after failure')
  expect((await (await db()).get('tasks', task.id))?.initialPrompt).toBe('Durable original')
  await unmount(first.component)
  mounted.splice(mounted.indexOf(first.component), 1)
  show((await tasks.getTask(task.id))!, mode)
  await vi.waitFor(async () => expect((await (await db()).get('tasks', task.id))?.initialPrompt).toBe('Recovered after failure'))
  await vi.waitFor(() => expect(readPromptDraft(task.id)).toBeNull())
  await vi.waitFor(() => expect(unloadPrevented()).toBe(false))
})
