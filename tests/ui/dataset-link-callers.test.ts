import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import GenerateDatasetPanel from '../../src/components/dataset/GenerateDatasetPanel.svelte'
import DatasetImportExportDialog from '../../src/components/dataset/DatasetImportExportDialog.svelte'
import { createTask, patchTask } from '../../src/lib/db/tasks'
import { addItems, getAllItems } from '../../src/lib/db/datasets'
import { db, wipeAll } from '../../src/lib/db/db'
import * as api from '../../src/lib/api/openaiLike'
import * as files from '../../src/lib/io/csv'
import { settings } from '../../src/stores/settings'
import { defaultSettings } from '../../src/lib/db/settings'
import { locale } from '../../src/lib/i18n'

const mounted: ReturnType<typeof mount>[] = []
const dialogMethods = ['showModal', 'close'] as const
const originalDialogs = dialogMethods.map((method) => Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, method))
afterAll(() => {
  dialogMethods.forEach((method, index) => {
    const descriptor = originalDialogs[index]
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, method, descriptor)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, method)
  })
})
beforeEach(async () => {
  await wipeAll(); sessionStorage.clear(); locale.set('en')
  const defaults = defaultSettings('en')
  settings.set({ ...defaults, provider: { ...defaults.provider, baseUrl: 'mock://super-prompt', targetModel: 'mock-target', judgeModel: 'mock-judge' } })
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function () { this.open = true } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function () { this.open = false } })
})
afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component)
  document.body.replaceChildren(); vi.restoreAllMocks()
})

it.each(['import', 'generate'] as const)('%s appends to the authoritative linked dataset and preserves a different manual dataset', async (mode) => {
  const task = await createTask({ initialPrompt: 'Prompt' })
  const database = await db()
  for (const id of ['a-unrelated', 'z-current']) await database.put('datasets', { id, taskId: task.id, name: id, itemCount: 0, createdAt: 0 })
  const unrelated = await addItems('a-unrelated', [{ input: 'Unrelated manual row' }])
  await addItems('z-current', [{ input: 'Current manual row' }])
  await patchTask(task.id, { datasetId: 'z-current' })
  const target = document.createElement('div')
  document.body.appendChild(target)
  if (mode === 'import') {
    vi.spyOn(files, 'readDatasetFile').mockResolvedValue([{ input: 'New imported row' }])
    mounted.push(mount(DatasetImportExportDialog, { target, props: { taskId: task.id, open: true } }))
    flushSync()
    const input = target.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [new File(['synthetic'], 'data.jsonl')] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  } else {
    vi.spyOn(api, 'chatCompletion').mockResolvedValue({ text: '[{"input":"New generated row"}]', model: 'mock', raw: {}, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
    mounted.push(mount(GenerateDatasetPanel, { target, props: { taskId: task.id } }))
    flushSync()
    const generate = [...target.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Regenerate')!
    generate.click()
  }
  const label = mode === 'import' ? 'Import' : 'Add to dataset (1)'
  let commit: HTMLButtonElement | undefined
  await vi.waitFor(() => {
    flushSync()
    commit = [...target.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === label)
    expect(commit).toBeDefined()
    expect(commit!.disabled).toBe(false)
  })
  commit!.click(); flushSync()
  await vi.waitFor(async () => expect(await database.count('datasets_items')).toBe(3))
  expect((await database.get('tasks', task.id))?.datasetId).toBe('z-current')
  expect(await getAllItems('a-unrelated')).toEqual(unrelated)
  expect((await getAllItems('z-current')).map((item) => item.input).sort()).toEqual(['Current manual row', mode === 'import' ? 'New imported row' : 'New generated row'].sort())
  expect(await database.countFromIndex('datasets', 'by-taskId', task.id)).toBe(2)
})
