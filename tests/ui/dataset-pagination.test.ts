import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import DatasetTable from '../../src/components/dataset/DatasetTable.svelte'
import { db, wipeAll } from '../../src/lib/db/db'


let component: ReturnType<typeof mount> | undefined
beforeEach(async () => {
  await wipeAll()
  const d = await db()
  const tx = d.transaction(['datasets', 'datasets_items'], 'readwrite')
  await tx.objectStore('datasets').put({ id: 'ds', taskId: 'task', name: 'Dataset', itemCount: 30, createdAt: 0 })
  for (let i = 0; i < 30; i++) {
    await tx.objectStore('datasets_items').put({
      id: `item-${i.toString().padStart(5, '0')}`, datasetId: 'ds', input: `Synthetic example ${i}: Return ${i}.`,
    })
  }
  await tx.done
})
afterEach(async () => {
  if (component) await unmount(component)
  component = undefined
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('dataset edit then pagination', () => {
  it.each([false, true])('commits an edit then handles a delivered Next click (benchmark instrumentation: %s)', async (instrumented) => {
    let transactionCompleted = false
    if (instrumented) {
      const put = IDBObjectStore.prototype.put
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (...args) {
        const request = put.apply(this, args)
        if (this.name === 'datasets_items' && args[0]?.id === 'item-00000') {
          this.transaction.addEventListener('complete', () => { transactionCompleted = true }, { once: true })
        }
        return request
      })
      // These transparent wrappers mirror benchmark read instrumentation.
      vi.spyOn(IDBIndex.prototype, 'getAll')
      vi.spyOn(IDBObjectStore.prototype, 'getAll')
    }
    const target = document.createElement('div')
    document.body.appendChild(target)
    component = mount(DatasetTable, { target, props: { taskId: 'task', dataset: {
      id: 'ds', taskId: 'task', name: 'Dataset', itemCount: 30, createdAt: 0,
    } } })
    flushSync()
    await vi.waitFor(() => expect(target.querySelectorAll('tbody tr')).toHaveLength(10))
    const input = target.querySelector<HTMLTextAreaElement>('tbody textarea')!
    const edited = `${input.value} [benchmark edit]`
    input.focus()
    input.value = edited
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    flushSync()
    await vi.waitFor(async () => expect((await (await db()).get('datasets_items', 'item-00000'))?.input).toBe(edited))
    if (instrumented) await vi.waitFor(() => expect(transactionCompleted).toBe(true))
    expect(input.value).toBe(edited)
    const buttons = target.querySelectorAll<HTMLButtonElement>('.pager button')
    expect(buttons[1].disabled).toBe(false)
    buttons[1].focus()
    buttons[1].click()
    flushSync()
    await vi.waitFor(() => expect(target.querySelector<HTMLTextAreaElement>('tbody textarea')?.value).toMatch(/^Synthetic example 10:/))
    expect(target.querySelector('.pager')?.textContent).toContain('11-20 / 30')
  })
})
