import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushSync, tick } from 'svelte'
import { createClassComponent } from 'svelte/legacy'
import { EditorView } from '@codemirror/view'
import TaskEditHost from './fixtures/TaskEditHost.svelte'
import { createTask, getTask } from '../../src/lib/db/tasks'
import { createRun, addCandidate, patchRun } from '../../src/lib/db/runs'
import * as databaseModule from '../../src/lib/db/db'
import { readPromptDraft } from '../../src/lib/db/prompt-drafts'
import { readAppliedRevision } from '../../src/lib/improve/applied-revision'
import { optimizationState, activeRunId } from '../../src/stores/worker'
import { settings } from '../../src/stores/settings'
import { defaultSettings } from '../../src/lib/db/settings'
import { locale } from '../../src/lib/i18n'
import type { RunConfig } from '../../src/lib/types'

const components: { $destroy(): void }[] = []
const ORIGINAL = 'Original'
const APPLIED = 'Applied revision'
const config: RunConfig = {
  iterationsCap: 1, tokenBudget: 0, concurrency: 1, sampleSizePerIter: 2,
  earlyStopPlateau: 0, judgeTemperature: 0, targetTemperature: 0, mutatorTemperature: 0,
}
beforeEach(async () => {
  await databaseModule.wipeAll()
  sessionStorage.clear()
  locale.set('en')
  activeRunId.set(null)
  optimizationState.set({ run: null, candidates: [], history: [], log: [], stage: null })
  const defaults = defaultSettings()
  settings.set({
    ...defaults,
    provider: { ...defaults.provider, baseUrl: 'mock://super-prompt', targetModel: 'mock-target', judgeModel: 'mock-judge' },
  })
})
afterEach(() => {
  components.splice(0).forEach((component) => component.$destroy())
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function button(target: HTMLElement, name: string) {
  return [...target.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent?.trim().endsWith(name))!
}

function editorText(target: HTMLElement) {
  return target.querySelector('.cm-content')?.textContent ?? target.querySelector<HTMLTextAreaElement>('.fallback textarea')?.value
}

function editPrompt(target: HTMLElement, value: string) {
  const editor = target.querySelector<HTMLElement>('.cm-editor')
  if (editor) {
    const view = EditorView.findFromDOM(editor)!
    flushSync(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, userEvent: 'input.type' }))
  } else {
    const textarea = target.querySelector<HTMLTextAreaElement>('.fallback textarea')!
    textarea.focus()
    textarea.value = value
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    flushSync()
  }
}

async function scenario(action: 'Apply' | 'Undo' = 'Apply') {
  const task = await createTask({ initialPrompt: ORIGINAL })
  const run = await createRun(task.id, config)
  await addCandidate({ id: 'winner', runId: run.id, parentId: null, text: APPLIED, source: 'mutated', score: 8, wins: 1, losses: 0, ties: 0, iterations: 1, tokensIn: 0, tokensOut: 0, createdAt: 1 })
  await patchRun(run.id, { status: 'completed', bestCandidateId: 'winner' })
  const target = document.createElement('div')
  document.body.append(target)
  const component = createClassComponent({ component: TaskEditHost, target, props: { initialTask: task, mode: 'workspace' } })
  components.push(component)
  flushSync()
  await vi.waitFor(() => expect(button(target, 'Use this revision')).toBeDefined())
  const database = await databaseModule.db()
  if (action === 'Undo') {
    button(target, 'Use this revision').click()
    await vi.waitFor(() => expect(button(target, 'Undo last apply')).toBeDefined())
  }
  return { task, target, component, database }
}

async function holdNextWrite() {
  const database = await databaseModule.db()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let started = false
  const access = vi.spyOn(databaseModule, 'db').mockImplementationOnce(async () => { started = true; await gate; return database })
  return { release, access, waitStarted: () => vi.waitFor(() => expect(started).toBe(true)) }
}

it.each(['Apply', 'Undo'] as const)('keeps the shared task current when %s commits after navigation to Overview', async (action) => {
  const { task, target, component, database } = await scenario(action)
  const pending = await holdNextWrite()
  try {
    button(target, action === 'Apply' ? 'Use this revision' : 'Undo last apply').click()
    await pending.waitStarted()
    flushSync(() => component.$set({ mode: 'overview' }))
  } finally { pending.release() }
  const expected = action === 'Apply' ? APPLIED : ORIGINAL
  await vi.waitFor(async () => expect((await database.get('tasks', task.id))?.initialPrompt).toBe(expected))
  await vi.waitFor(() => expect(editorText(target)).toBe(expected))
  expect(readAppliedRevision(task.id, APPLIED)).toEqual(action === 'Apply' ? { before: ORIGINAL, after: APPLIED } : null)
})

it('shows Undo when Apply commits after returning to Improve', async () => {
  const { task, target, component, database } = await scenario()
  const pending = await holdNextWrite()
  try {
    button(target, 'Use this revision').click()
    await pending.waitStarted()
    flushSync(() => component.$set({ mode: 'overview' }))
    flushSync(() => component.$set({ mode: 'workspace' }))
    await vi.waitFor(() => expect(button(target, 'Use this revision')).toBeDefined())
    expect(button(target, 'Undo last apply')).toBeUndefined()
  } finally { pending.release() }

  await vi.waitFor(async () => expect((await database.get('tasks', task.id))?.initialPrompt).toBe(APPLIED))
  expect(readAppliedRevision(task.id, APPLIED)).toEqual({ before: ORIGINAL, after: APPLIED })
  await vi.waitFor(() => expect(button(target, 'Undo last apply')).toBeDefined())
})

it('keeps a pending Apply locked after returning to Improve', async () => {
  const { task, target, component, database } = await scenario()
  const pending = await holdNextWrite()
  try {
    button(target, 'Use this revision').click()
    await pending.waitStarted()
    flushSync(() => component.$set({ mode: 'overview' }))
    flushSync(() => component.$set({ mode: 'workspace' }))
    await vi.waitFor(() => expect(button(target, 'Keep current')).toBeDefined())
    button(target, 'Keep current').click()
    flushSync()
    const improve = button(target, 'Improve prompt')
    expect(improve.disabled).toBe(true)
    improve.click()
  } finally { pending.release() }

  await vi.waitFor(async () => expect((await database.get('tasks', task.id))?.initialPrompt).toBe(APPLIED))
  await vi.waitFor(() => expect(button(target, 'Undo last apply')).toBeDefined())
})

it('refreshes a separately reopened task after a pending Apply commits', async () => {
  const { task, target, database } = await scenario()
  const pending = await holdNextWrite()
  const reopenedTarget = document.createElement('div')
  document.body.append(reopenedTarget)
  try {
    button(target, 'Use this revision').click()
    await pending.waitStarted()
    const staleTask = (await getTask(task.id))!
    const reopened = createClassComponent({ component: TaskEditHost, target: reopenedTarget, props: { initialTask: staleTask, mode: 'workspace' } })
    components.push(reopened)
    flushSync()
  } finally { pending.release() }

  await vi.waitFor(async () => expect((await database.get('tasks', task.id))?.initialPrompt).toBe(APPLIED))
  await vi.waitFor(() => expect(button(reopenedTarget, 'Undo last apply')).toBeDefined())
})

it('keeps a reopened task locked until its committed prompt finishes loading', async () => {
  const { task, target, database } = await scenario()
  const pending = await holdNextWrite()
  const reopenedTarget = document.createElement('div')
  document.body.append(reopenedTarget)
  let releaseRefresh!: () => void
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve })
  let refreshStarted = false
  try {
    button(target, 'Use this revision').click()
    await pending.waitStarted()
    const staleTask = (await getTask(task.id))!
    const reopened = createClassComponent({ component: TaskEditHost, target: reopenedTarget, props: { initialTask: staleTask, mode: 'workspace' } })
    components.push(reopened)
    flushSync()
    pending.access.mockImplementationOnce(async () => {
      refreshStarted = true
      await refreshGate
      return database
    })
    pending.release()
    await vi.waitFor(() => expect(refreshStarted).toBe(true))
    button(reopenedTarget, 'Keep current').click()
    flushSync()
    expect(button(reopenedTarget, 'Improve prompt').disabled).toBe(true)
  } finally {
    pending.release()
    releaseRefresh()
  }

  await vi.waitFor(() => expect(button(reopenedTarget, 'Undo last apply')).toBeDefined())
  expect(editorText(reopenedTarget)).toBe(APPLIED)
})

it('keeps a stale reopened task locked when its committed prompt cannot be loaded', async () => {
  const { task, target, database } = await scenario()
  const pending = await holdNextWrite()
  const reopenedTarget = document.createElement('div')
  document.body.append(reopenedTarget)
  try {
    button(target, 'Use this revision').click()
    await pending.waitStarted()
    const staleTask = (await getTask(task.id))!
    const reopened = createClassComponent({ component: TaskEditHost, target: reopenedTarget, props: { initialTask: staleTask, mode: 'workspace' } })
    components.push(reopened)
    flushSync()
    pending.access.mockRejectedValueOnce(new Error('read failed'))
  } finally { pending.release() }

  await vi.waitFor(async () => expect((await database.get('tasks', task.id))?.initialPrompt).toBe(APPLIED))
  await vi.waitFor(() => expect(reopenedTarget.querySelector('[role="alert"]')?.textContent).toContain('Could not save'))
  button(reopenedTarget, 'Keep current').click()
  flushSync()
  expect(button(reopenedTarget, 'Improve prompt').disabled).toBe(true)
  expect(editorText(reopenedTarget)).toBe(ORIGINAL)
})

it.each(['Apply', 'Undo'] as const)('a delayed %s cannot overwrite a newer prompt edit in Overview', async (action) => {
  const { task, target, component, database } = await scenario(action)
  const pending = await holdNextWrite()
  const latest = 'Newer edit made after navigation'
  try {
    button(target, action === 'Apply' ? 'Use this revision' : 'Undo last apply').click()
    await pending.waitStarted()
    flushSync(() => component.$set({ mode: 'overview' }))
    editPrompt(target, latest)
  } finally { pending.release() }
  await vi.waitFor(async () => expect((await database.get('tasks', task.id))?.initialPrompt).toBe(action === 'Apply' ? APPLIED : ORIGINAL))
  await tick()
  flushSync()
  expect(editorText(target)).toBe(latest)
  expect(readPromptDraft(task.id)).toBe(latest)
  button(target, 'Save').click()
  await vi.waitFor(async () => expect((await database.get('tasks', task.id))?.initialPrompt).toBe(latest))
  expect(readPromptDraft(task.id)).toBeNull()
  expect(readAppliedRevision(task.id, latest)).toBeNull()
})

it.each(['success', 'conflict'] as const)('does not retain a superseded autosave draft after navigation and Apply %s', async (outcome) => {
  const { task, target, component, database } = await scenario()
  const pending = await holdNextWrite()
  const localEdit = 'Local edit before Apply'
  const expected = outcome === 'success' ? APPLIED : 'Newer saved prompt before conditional Apply'
  if (outcome === 'conflict') {
    // Overview queues recovery of the same local draft behind its autosave.
    // A separate write then lands before the conditional replacement reads.
    pending.access.mockResolvedValueOnce(database).mockImplementationOnce(async () => {
      const current = (await database.get('tasks', task.id))!
      await database.put('tasks', { ...current, initialPrompt: expected })
      return database
    })
  }
  try {
    button(target, 'Keep current').click()
    flushSync()
    editPrompt(target, localEdit)
    button(target, 'Review changes').click()
    flushSync()
    button(target, 'Use this revision').click()
    await pending.waitStarted()
    flushSync(() => component.$set({ mode: 'overview' }))
  } finally { pending.release() }
  await vi.waitFor(async () => expect((await database.get('tasks', task.id))?.initialPrompt).toBe(expected))
  await vi.waitFor(() => expect(editorText(target)).toBe(expected))
  expect(readAppliedRevision(task.id, APPLIED)).toEqual(outcome === 'success' ? { before: localEdit, after: APPLIED } : null)
  expect(readPromptDraft(task.id)).toBeNull()
  expect((await getTask(task.id))?.initialPrompt).toBe(expected)
})
