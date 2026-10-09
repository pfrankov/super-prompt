import type { Page } from '@playwright/test'
import { test, expect, openWorkspace, readRecords, seedWorkspace, showFullPrompt, showPromptEditor, TASK_ID } from './fixtures'

const CURRENT = 'Summarize the customer request.'
const PROPOSED = 'Summarize the customer request and preserve the explicit deadline.'
const OTHER_TAB_PROMPT = 'Из другой вкладки: preserve {order_id} and the complete request 🙂.'
const CONFLICT_MESSAGE = 'This prompt changed in another tab. Review the latest saved version before trying again.'

async function expectStoredPrompt(page: Page, expected: string) {
  await expect.poll(async () => (await readRecords(page, 'tasks')).find((task) => task.id === TASK_ID)?.initialPrompt).toBe(expected)
}

async function replacePrompt(page: Page, text: string) {
  const editor = await showPromptEditor(page)
  await editor.focus()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.insertText(text)
  await expect(editor).toHaveText(text)
  await expectStoredPrompt(page, text)
}

async function expectReloadedPrompt(page: Page, expected: string) {
  await page.reload()
  await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'completed')
  await expect(await showPromptEditor(page)).toHaveText(expected)
  await expectStoredPrompt(page, expected)
}

test('stale Apply preserves another tab edit and uses it as the next undo baseline', async ({ page, context }) => {
  await seedWorkspace(page, { runCount: 1, candidatesPerRun: 2, initialPrompt: CURRENT, bestPrompt: PROPOSED })
  await openWorkspace(page)
  await expect(await showFullPrompt(page)).toHaveText(PROPOSED)

  // A second page shares IndexedDB, while its prompt journal and Undo stay tab-local.
  const other = await context.newPage()
  const otherErrors: string[] = []
  other.on('pageerror', (error) => otherErrors.push(error.message))
  await openWorkspace(other)
  await expect(await showFullPrompt(other)).toHaveText(PROPOSED)
  await replacePrompt(other, OTHER_TAB_PROMPT)
  await expectStoredPrompt(page, OTHER_TAB_PROMPT)

  await page.getByRole('button', { name: 'Use this revision', exact: true }).click()
  await expect(page.getByTestId('workspace-ready').getByRole('alert')).toHaveText(CONFLICT_MESSAGE)
  await expectStoredPrompt(page, OTHER_TAB_PROMPT)
  await expect(page.getByRole('button', { name: 'Undo last apply', exact: true })).toHaveCount(0)
  await expect(await showPromptEditor(page)).toHaveText(OTHER_TAB_PROMPT)

  // Reload must not recover or autosave a draft from the rejected Apply.
  await expectReloadedPrompt(page, OTHER_TAB_PROMPT)
  await page.getByRole('navigation', { name: 'Prompt improvement steps', exact: true })
    .getByRole('button', { name: /Review changes/ }).click()
  await expect(await showFullPrompt(page)).toHaveText(PROPOSED)
  await page.getByRole('button', { name: 'Use this revision', exact: true }).click()
  await expectStoredPrompt(page, PROPOSED)
  await expect(page.getByRole('button', { name: 'Undo last apply', exact: true })).toBeEnabled()
  await expect(page.getByTestId('workspace-ready').getByRole('alert').filter({ hasText: CONFLICT_MESSAGE })).toHaveCount(0)

  await page.getByRole('button', { name: 'Undo last apply', exact: true }).click()
  await expectStoredPrompt(page, OTHER_TAB_PROMPT)
  await expect(page.getByRole('button', { name: 'Undo last apply', exact: true })).toHaveCount(0)
  await expectReloadedPrompt(page, OTHER_TAB_PROMPT)
  expect(otherErrors, 'The second tab must not have uncaught application errors').toEqual([])
})

test('stale Undo preserves another tab edit across reload and removes the obsolete undo', async ({ page, context }) => {
  await seedWorkspace(page, { runCount: 1, candidatesPerRun: 2, initialPrompt: CURRENT, bestPrompt: PROPOSED })
  await openWorkspace(page)
  await expect(await showFullPrompt(page)).toHaveText(PROPOSED)
  await page.getByRole('button', { name: 'Use this revision', exact: true }).click()
  await expectStoredPrompt(page, PROPOSED)
  const undo = page.getByRole('button', { name: 'Undo last apply', exact: true })
  await expect(undo).toBeEnabled()

  const other = await context.newPage()
  const otherErrors: string[] = []
  other.on('pageerror', (error) => otherErrors.push(error.message))
  await openWorkspace(other)
  await expect(await showFullPrompt(other)).toHaveText(PROPOSED)
  await expect(other.getByRole('button', { name: 'Undo last apply', exact: true })).toHaveCount(0)
  await replacePrompt(other, OTHER_TAB_PROMPT)
  await expectStoredPrompt(page, OTHER_TAB_PROMPT)

  await expect(undo).toBeEnabled()
  await undo.click()
  await expect(page.getByTestId('workspace-ready').getByRole('alert')).toHaveText(CONFLICT_MESSAGE)
  await expectStoredPrompt(page, OTHER_TAB_PROMPT)
  await expect(undo).toHaveCount(0)
  await expect(await showPromptEditor(page)).toHaveText(OTHER_TAB_PROMPT)

  // A stale Undo must not leave a recovery copy of the old CURRENT prompt.
  await expectReloadedPrompt(page, OTHER_TAB_PROMPT)
  await expect(undo).toHaveCount(0)
  expect(otherErrors, 'The second tab must not have uncaught application errors').toEqual([])
})
