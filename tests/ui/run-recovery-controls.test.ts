import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { flushSync } from 'svelte'
import { createClassComponent } from 'svelte/legacy'
import ImproveWorkspace from '../../src/components/improve/ImproveWorkspace.svelte'
import { createTask, deleteTask } from '../../src/lib/db/tasks'
import { createRun } from '../../src/lib/db/runs'
import { activeRunId, optimizationState } from '../../src/stores/worker'
import type { PromptCandidate, RunConfig } from '../../src/lib/types'

vi.mock('../../src/lib/db/runs', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/db/runs')>(), listRuns: async () => [],
}))
const mounted: { $destroy(): void }[] = []
const tasks: string[] = []
afterEach(async () => {
  for (const component of mounted.splice(0)) component.$destroy()
  activeRunId.set(null)
  optimizationState.set({ run: null, candidates: [], history: [], log: [], stage: null })
  document.body.replaceChildren()
  for (const id of tasks.splice(0)) await deleteTask(id)
})

it.each(['stopped', 'completed'] as const)('keeps %s persistence recovery visible and disables both Improve surfaces until ownership releases', async (status) => {
  const task = await createTask({ name: 'Recovery', initialPrompt: 'Original prompt' })
  tasks.push(task.id)
  const run = await createRun(task.id, { iterationsCap: 1 } as RunConfig)
  const target = document.createElement('div')
  document.body.appendChild(target)
  mounted.push(createClassComponent({ component: ImproveWorkspace, target, props: { task } }))
  await vi.waitFor(() => { flushSync(); expect(target.querySelector('.editor-footer button')).not.toBeNull() })
  const recovery = { ...run, status, errorMessage: 'Storage unavailable. Reload to retry recovery.' }
  flushSync(() => {
    activeRunId.set(run.id)
    optimizationState.set({ run: recovery, candidates: [], history: [], log: [], stage: null })
  })
  expect(target.querySelector('[role="alert"]')?.textContent).toContain('Reload to retry recovery')
  expect(target.querySelector<HTMLButtonElement>('.editor-footer button')?.disabled).toBe(true)
  const candidate: PromptCandidate = {
    id: 'best', runId: run.id, parentId: null, text: task.initialPrompt, source: 'seed', score: 8,
    wins: 1, losses: 0, ties: 0, iterations: 1, tokensIn: 0, tokensOut: 0, createdAt: 1,
  }
  flushSync(() => optimizationState.update((state) => ({ ...state, run: { ...recovery, bestCandidateId: candidate.id }, candidates: [candidate] })))
  expect(target.querySelector<HTMLButtonElement>('.decision-actions button')?.disabled).toBe(true)
  flushSync(() => {
    activeRunId.set(null)
    optimizationState.update((state) => ({ ...state, run: { ...recovery, bestCandidateId: candidate.id, errorMessage: null } }))
  })
  expect(target.querySelector<HTMLButtonElement>('.decision-actions button')?.disabled).toBe(false)
})
