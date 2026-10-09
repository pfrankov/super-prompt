import 'fake-indexeddb/auto'
import { openDB } from 'idb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import TaskEditHost from './fixtures/TaskEditHost.svelte'
import { createTask } from '../../src/lib/db/tasks'
import * as tasks from '../../src/lib/db/tasks'
import { addCandidate, createRun, patchRun } from '../../src/lib/db/runs'
import { db, wipeAll, type SPDB } from '../../src/lib/db/db'
import { readPromptDraft } from '../../src/lib/db/prompt-drafts'
import { readAppliedRevision } from '../../src/lib/improve/applied-revision'
import { locale } from '../../src/lib/i18n'
import { activeRunId, optimizationState } from '../../src/stores/worker'
import { t, toasts } from '../../src/stores/toast'
import type { PromptCandidate, RunConfig, Task } from '../../src/lib/types'

const ORIGINAL = 'P0: original prompt'
const PROPOSED = 'P1: evaluated revision'
const LATER_EDIT = 'P2: later work saved in another tab'
const mounted: ReturnType<typeof mount>[] = []
const config: RunConfig = {
  iterationsCap: 1, tokenBudget: 0, concurrency: 1, sampleSizePerIter: 2,
  earlyStopPlateau: 0, judgeTemperature: 0, targetTemperature: 0, mutatorTemperature: 0,
}

function button(target: HTMLElement, name: string) {
  return [...target.querySelectorAll<HTMLButtonElement>('button')]
    .find((element) => element.textContent?.trim() === name)
}

async function showRevision(task: Task) {
  const target = document.createElement('div')
  document.body.appendChild(target)
  mounted.push(mount(TaskEditHost, { target, props: { initialTask: task, mode: 'workspace' } }))
  flushSync()
  await vi.waitFor(() => expect(button(target, 'Use this revision')).toBeDefined())
  return target
}

async function revisionTask() {
  const task = await createTask({ initialPrompt: ORIGINAL })
  const run = await createRun(task.id, config)
  const candidate: PromptCandidate = {
    id: `${run.id}-revision`, runId: run.id, parentId: null,
    text: PROPOSED, source: 'mutated', score: 8, wins: 1, losses: 0, ties: 0,
    iterations: 1, tokensIn: 10, tokensOut: 20, createdAt: Date.now(),
  }
  await addCandidate(candidate)
  await patchRun(run.id, { status: 'completed', bestCandidateId: candidate.id })
  return task
}

// A separate connection changes durable state without touching the first tab's
// in-memory task, per-tab journal, or write queue.
async function saveFromOtherTab(taskId: string, initialPrompt: string) {
  const other = await openDB<SPDB>('super-prompt', 1)
  try {
    const tx = other.transaction('tasks', 'readwrite')
    const task = (await tx.store.get(taskId))!
    await tx.store.put({ ...task, initialPrompt, updatedAt: Date.now() })
    await tx.done
  } finally { other.close() }
}

async function storedPrompt(taskId: string) {
  return (await (await db()).get('tasks', taskId))?.initialPrompt
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function showEditor(target: HTMLElement) {
  button(target, 'Edit prompt')?.click()
  flushSync()
  const editor = target.querySelector<HTMLTextAreaElement>('.prompt-editor .fallback textarea')!
  // Keep the native editor for this interaction, as a user who starts typing
  // before the optional CodeMirror chunk finishes loading would do.
  editor?.focus()
  return editor
}

function editPrompt(target: HTMLElement, prompt: string) {
  const editor = showEditor(target)
  expect(editor).not.toBeNull()
  editor.value = prompt
  editor.dispatchEvent(new Event('input', { bubbles: true }))
  flushSync()
  button(target, 'Review changes')!.click()
  flushSync()
}

async function applyRevision(target: HTMLElement, taskId: string) {
  button(target, 'Use this revision')!.click()
  await vi.waitFor(async () => expect(await storedPrompt(taskId)).toBe(PROPOSED))
  await vi.waitFor(() => expect(button(target, 'Undo last apply')).toBeDefined())
}

beforeEach(async () => {
  await wipeAll()
  sessionStorage.clear()
  locale.set('en')
  activeRunId.set(null)
  optimizationState.set({ run: null, candidates: [], history: [], log: [], stage: null })
  toasts.set([])
})

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component)
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

it('Undo cannot overwrite a later prompt saved by another tab or report a false restore', async () => {
  const task = await revisionTask()
  const target = await showRevision(task)
  button(target, 'Use this revision')!.click()
  await vi.waitFor(async () => expect(await storedPrompt(task.id)).toBe(PROPOSED))
  await vi.waitFor(() => expect(button(target, 'Undo last apply')).toBeDefined())

  await saveFromOtherTab(task.id, LATER_EDIT)
  const success = vi.spyOn(t, 'success')
  const failure = vi.spyOn(t, 'error')
  button(target, 'Undo last apply')!.click()
  await vi.waitFor(() => expect(success.mock.calls.length + failure.mock.calls.length).toBeGreaterThan(0))

  expect(await storedPrompt(task.id)).toBe(LATER_EDIT)
  expect(success).not.toHaveBeenCalledWith('Previous prompt restored')
  // A rejected write must not stage the stale original for recovery on reload.
  expect(readPromptDraft(task.id)).toBeNull()
})

it('Apply rejects a stale current prompt without discarding another tab edit or recording an incorrect Undo', async () => {
  const task = await revisionTask()
  const target = await showRevision(task)
  await saveFromOtherTab(task.id, LATER_EDIT)
  const success = vi.spyOn(t, 'success')
  const failure = vi.spyOn(t, 'error')
  button(target, 'Use this revision')!.click()
  await vi.waitFor(() => expect(success.mock.calls.length + failure.mock.calls.length).toBeGreaterThan(0))

  expect(await storedPrompt(task.id)).toBe(LATER_EDIT)
  expect(success).not.toHaveBeenCalled()
  expect(readAppliedRevision(task.id, PROPOSED)).toBeNull()
  expect(readPromptDraft(task.id)).toBeNull()
})

it.each(['Apply', 'Undo'] as const)('%s publishes the new prompt and Undo only after durable replacement resolves', async (action) => {
  const task = await revisionTask()
  const target = await showRevision(task)
  if (action === 'Undo') await applyRevision(target, task.id)
  const before = action === 'Apply' ? ORIGINAL : PROPOSED
  const after = action === 'Apply' ? PROPOSED : ORIGINAL
  const previousUndo = sessionStorage.getItem(`sp.applied-revision.${task.id}`)
  const pending = deferred()
  const actualReplace = tasks.replaceTaskPrompt
  let heldSave: Promise<Task> | undefined
  const replace = vi.spyOn(tasks, 'replaceTaskPrompt').mockImplementationOnce((...args) => {
    heldSave = pending.promise.then(() => actualReplace(...args))
    return heldSave
  })
  const success = vi.spyOn(t, 'success')
  const command = button(target, action === 'Apply' ? 'Use this revision' : 'Undo last apply')!
  try {
    command.click()
    command.click()
    flushSync()
    await vi.waitFor(() => expect(replace).toHaveBeenCalledTimes(1))
    expect(await storedPrompt(task.id)).toBe(before)
    expect(sessionStorage.getItem(`sp.applied-revision.${task.id}`)).toBe(previousUndo)
    expect(readPromptDraft(task.id)).toBeNull()
    expect(success).not.toHaveBeenCalled()
    const editor = showEditor(target)
    expect(editor?.value).toBe(before)
    expect(editor?.readOnly).toBe(true)
  } finally {
    pending.resolve()
    await heldSave
  }

  await vi.waitFor(async () => expect(await storedPrompt(task.id)).toBe(after))
  await vi.waitFor(() => expect(success).toHaveBeenCalledTimes(1))
  expect(readPromptDraft(task.id)).toBeNull()
  expect(readAppliedRevision(task.id, PROPOSED)).toEqual(action === 'Apply' ? { before: ORIGINAL, after: PROPOSED } : null)
})

it.each(['Apply', 'Undo'] as const)('a failed %s keeps the previous prompt and Undo available for a successful retry', async (action) => {
  const task = await revisionTask()
  const target = await showRevision(task)
  if (action === 'Undo') await applyRevision(target, task.id)
  const before = action === 'Apply' ? ORIGINAL : PROPOSED
  const after = action === 'Apply' ? PROPOSED : ORIGINAL
  const previousUndo = sessionStorage.getItem(`sp.applied-revision.${task.id}`)
  vi.spyOn(tasks, 'replaceTaskPrompt').mockRejectedValueOnce(new Error('Synthetic storage failure'))
  const success = vi.spyOn(t, 'success')
  const failure = vi.spyOn(t, 'error')
  const name = action === 'Apply' ? 'Use this revision' : 'Undo last apply'
  button(target, name)!.click()
  await vi.waitFor(() => expect(failure).toHaveBeenCalled())

  expect(await storedPrompt(task.id)).toBe(before)
  expect(sessionStorage.getItem(`sp.applied-revision.${task.id}`)).toBe(previousUndo)
  expect(readPromptDraft(task.id)).toBeNull()
  expect(success).not.toHaveBeenCalled()
  expect(showEditor(target)?.value).toBe(before)
  button(target, 'Review changes')!.click()
  flushSync()
  const retry = button(target, name)!
  expect(retry.disabled).toBe(false)
  retry.click()

  await vi.waitFor(async () => expect(await storedPrompt(task.id)).toBe(after))
  await vi.waitFor(() => expect(success).toHaveBeenCalledTimes(1))
  expect(readAppliedRevision(task.id, PROPOSED)).toEqual(action === 'Apply' ? { before: ORIGINAL, after: PROPOSED } : null)
  expect(readPromptDraft(task.id)).toBeNull()
})

it('Apply waits for a pending local autosave and retains that exact edit as its Undo text', async () => {
  const task = await revisionTask()
  const target = await showRevision(task)
  const localEdit = 'Unsaved local edit that Undo must preserve'
  const pending = deferred()
  const actualPatch = tasks.patchTask
  let heldSave: Promise<Task> | undefined
  const patch = vi.spyOn(tasks, 'patchTask').mockImplementationOnce((...args) => {
    heldSave = pending.promise.then(() => actualPatch(...args))
    return heldSave
  })
  const replace = vi.spyOn(tasks, 'replaceTaskPrompt')
  const success = vi.spyOn(t, 'success')
  try {
    editPrompt(target, localEdit)
    button(target, 'Use this revision')!.click()
    await vi.waitFor(() => expect(patch).toHaveBeenCalled())
    expect(replace).not.toHaveBeenCalled()
    expect(await storedPrompt(task.id)).toBe(ORIGINAL)
    expect(readPromptDraft(task.id)).toBe(localEdit)
    expect(readAppliedRevision(task.id, PROPOSED)).toBeNull()
    expect(success).not.toHaveBeenCalled()
  } finally {
    pending.resolve()
    await heldSave
  }

  await vi.waitFor(async () => expect(await storedPrompt(task.id)).toBe(PROPOSED))
  expect(replace).toHaveBeenCalledWith(task.id, localEdit, PROPOSED)
  expect(readAppliedRevision(task.id, PROPOSED)).toEqual({ before: localEdit, after: PROPOSED })
  expect(readPromptDraft(task.id)).toBeNull()
})

it('Apply cannot bypass a previous autosave failure and discard the unsaved local draft', async () => {
  const task = await revisionTask()
  const target = await showRevision(task)
  const localEdit = 'Local edit that must survive the failed save'
  vi.spyOn(tasks, 'patchTask').mockRejectedValue(new Error('Synthetic autosave failure'))
  const replace = vi.spyOn(tasks, 'replaceTaskPrompt')
  const success = vi.spyOn(t, 'success')
  const failure = vi.spyOn(t, 'error')
  editPrompt(target, localEdit)
  await vi.waitFor(() => expect(target.querySelector('.save-status')?.textContent).toContain('Could not save'))
  button(target, 'Use this revision')!.click()
  await vi.waitFor(() => expect(failure).toHaveBeenCalled())

  expect(replace).not.toHaveBeenCalled()
  expect(await storedPrompt(task.id)).toBe(ORIGINAL)
  expect(readPromptDraft(task.id)).toBe(localEdit)
  expect(readAppliedRevision(task.id, PROPOSED)).toBeNull()
  expect(success).not.toHaveBeenCalled()
  expect(showEditor(target)?.value).toBe(localEdit)
})

it('Apply does not retry a failed autosave over a newer prompt from another tab', async () => {
  const task = await revisionTask()
  const target = await showRevision(task)
  const localEdit = 'Failed local draft that must remain available without replacing P2'
  // Only the earlier autosave fails. Any automatic retry runs the real write,
  // so this test detects it overwriting another tab before the conditional Apply.
  const patch = vi.spyOn(tasks, 'patchTask').mockRejectedValueOnce(new Error('Synthetic autosave failure'))
  const replace = vi.spyOn(tasks, 'replaceTaskPrompt')
  editPrompt(target, localEdit)
  await vi.waitFor(() => expect(target.querySelector('.save-status')?.textContent).toContain('Could not save'))
  await saveFromOtherTab(task.id, LATER_EDIT)
  const success = vi.spyOn(t, 'success')
  const failure = vi.spyOn(t, 'error')
  button(target, 'Use this revision')!.click()
  await vi.waitFor(() => expect(success.mock.calls.length + failure.mock.calls.length).toBeGreaterThan(0))

  expect(await storedPrompt(task.id)).toBe(LATER_EDIT)
  expect(patch).toHaveBeenCalledTimes(1)
  expect(replace).not.toHaveBeenCalled()
  expect(readPromptDraft(task.id)).toBe(localEdit)
  expect(readAppliedRevision(task.id, PROPOSED)).toBeNull()
  expect(success).not.toHaveBeenCalled()
  expect(showEditor(target)?.value).toBe(localEdit)
})
