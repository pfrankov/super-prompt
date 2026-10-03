import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync } from 'svelte'
import { createClassComponent } from 'svelte/legacy'
import TaskDetail from '../../src/routes/TaskDetail.svelte'
import { createTask, deleteTask } from '../../src/lib/db/tasks'

const mounted: { $destroy(): void }[] = []
const taskIds: string[] = []

afterEach(async () => {
  for (const component of mounted.splice(0)) component.$destroy()
  document.body.replaceChildren()
  for (const id of taskIds.splice(0)) await deleteTask(id)
})

async function taskMenu() {
  const task = await createTask({ name: 'Synthetic disclosure fixture', initialPrompt: 'Original' })
  taskIds.push(task.id)
  const target = document.createElement('div')
  document.body.appendChild(target)
  mounted.push(createClassComponent({
    component: TaskDetail,
    target,
    props: { taskId: task.id, initialTab: 'history' },
  }))
  await vi.waitFor(() => {
    flushSync()
    expect(target.querySelector('details.context-menu')).not.toBeNull()
  })
  const details = target.querySelector<HTMLDetailsElement>('details.context-menu')!
  const summary = details.querySelector<HTMLElement>('summary')!
  summary.focus()
  return { target, details, summary }
}

describe('prompt disclosure dismissal before the native toggle notification', () => {
  it.each(['Escape', 'outside click', 'section navigation', 'focus leaving'] as const)
    ('closes immediately for %s and stays closed after toggle', async (action) => {
      const { target, details, summary } = await taskMenu()
      let notifications = 0
      const toggled = new Promise<void>((resolve) => {
        details.addEventListener('toggle', () => { notifications += 1; resolve() }, { once: true })
      })

      // Native open changes synchronously; its toggle notification is queued.
      // Dismiss without yielding, while a bind:open mirror would still be false.
      details.open = true
      if (action === 'Escape') {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      } else if (action === 'outside click') {
        target.querySelector<HTMLElement>('#task-panel')!.click()
      } else if (action === 'section navigation') {
        target.querySelector<HTMLAnchorElement>('a[href$="/overview"]')!.click()
      } else {
        target.querySelector<HTMLElement>('#task-panel')!.focus()
      }

      expect(notifications).toBe(0)
      flushSync()
      expect(details.open).toBe(false)
      if (action === 'Escape') expect(document.activeElement).toBe(summary)

      await toggled
      flushSync()
      expect(details.open).toBe(false)
    })
})
