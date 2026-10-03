import type { Browser, Locator, TestInfo } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { test, expect, attachScreenshot, confineNetwork, ORIGINAL_PROMPT } from './fixtures'

async function measureFreshWorkflow(browser: Browser, origin: string, variant: 'baseline' | 'candidate', round: number, info: TestInfo) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block', reducedMotion: 'reduce' })
  const blocked: string[] = []
  await confineNetwork(context, blocked)
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    const evidence = window as unknown as { __workflowScroll: { viewport: number; element: number } }
    evidence.__workflowScroll = { viewport: 0, element: 0 }
    document.addEventListener('scroll', (event) => {
      if (event.target === document) evidence.__workflowScroll.viewport += 1
      else evidence.__workflowScroll.element += 1
    }, true)
  })
  let clicks = 0
  async function click(locator: Locator) { await locator.click(); clicks += 1 }
  try {
    await page.goto(origin)
    if (variant === 'baseline') {
      await click(page.getByRole('button', { name: 'Settings', exact: true }))
      await click(page.getByRole('button', { name: 'Use demo', exact: true }))
      await expect(page.getByText('Demo provider is active', { exact: true })).toBeVisible()
      await click(page.getByRole('button', { name: 'Prompts', exact: true }))
    }
    await click(page.getByRole('button', { name: 'Improve prompt', exact: true }).first())
    const editor = page.locator('.cm-content').first()
    await expect(editor).toBeVisible()
    await editor.focus()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.insertText(ORIGINAL_PROMPT)
    await expect(editor).toHaveText(ORIGINAL_PROMPT)
    if (variant === 'candidate') {
      await click(page.getByRole('button', { name: 'Configure models', exact: true }))
      const dialog = page.getByRole('dialog', { name: 'Configure models', exact: true })
      await click(dialog.getByRole('button', { name: 'Use demo', exact: true }))
      await click(dialog.getByRole('button', { name: 'Save models', exact: true }))
    }
    const panelsBeforeRun = await page.evaluate((variant) => {
      const withinViewport = (selector: string) => {
        const element = document.querySelector(selector)
        if (!element) return false
        const rect = element.getBoundingClientRect()
        return rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth
      }
      return {
        inputHeading: withinViewport(variant === 'candidate' ? '.workbench-heading h2' : '.primary-head h2'),
        resultHeading: variant === 'candidate' ? null : withinViewport('.result h3'),
        workflowNavigation: variant === 'candidate' ? withinViewport('.flow-nav') : null,
      }
    }, variant)
    const started = await page.evaluate(() => performance.now())
    await click(page.getByRole('button', { name: 'Improve prompt', exact: true }))
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    const clickToRunningFeedbackMs = await page.evaluate((started) => performance.now() - started, started)
    if (variant === 'candidate') {
      await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'completed', { timeout: 40_000 })
    } else {
      await expect(page.locator('.run-state').getByText('Completed', { exact: true })).toBeVisible({ timeout: 40_000 })
    }
    const clickToTerminalMs = await page.evaluate((started) => performance.now() - started, started)
    const clicksToCompletedResult = clicks
    if (variant === 'candidate') {
      await expect(page.getByTestId('result-prompt')).toBeVisible()
      if (round === 0) await attachScreenshot(page, info, 'candidate-fresh-demo-revision', false)
    }
    const best = variant === 'candidate' ? page.getByTestId('result-prompt') : page.locator('.result pre')
    await expect(best).toContainText('Before answering')
    await best.scrollIntoViewIfNeeded()
    const measurements = await page.evaluate(() => ({
      firstContentfulPaintMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
      scrollEvents: (window as unknown as { __workflowScroll: { viewport: number; element: number } }).__workflowScroll,
      domNodes: document.querySelectorAll('*').length,
    }))
    if (round === 0) await attachScreenshot(page, info, `${variant}-fresh-demo-result`)
    expect(blocked).toEqual([])
    expect(errors).toEqual([])
    return { variant, round, clicksToCompletedResult, clicksToInspectFullPrompt: clicks, scriptedKeyboardActions: 2, clickToRunningFeedbackMs, clickToTerminalMs, panelsBeforeRun, ...measurements }
  } finally { await context.close() }
}

test('@benchmark fresh demo workflow baseline versus candidate', async ({ browser }, info) => {
  test.setTimeout(360_000)
  const baselineURL = process.env.E2E_BASELINE_URL
  const samples: Awaited<ReturnType<typeof measureFreshWorkflow>>[] = []
  for (let round = 0; round < 3; round += 1) {
    const order: ('baseline' | 'candidate')[] = baselineURL ? (round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) : ['candidate']
    for (const variant of order) samples.push(await measureFreshWorkflow(browser, variant === 'baseline' ? baselineURL! : 'http://127.0.0.1:4173', variant, round, info))
  }
  const report = {
    schemaVersion: 1,
    revisions: { baseline: process.env.E2E_BASELINE_SHA ?? null, candidate: process.env.E2E_CANDIDATE_SHA ?? null },
    environment: { browser: browser.version(), viewport: { width: 1440, height: 1000 }, reducedMotion: true },
    method: 'Three interleaved samples per build, fresh browser context and empty storage, same prompt and built-in demo provider. Baseline configures in Settings; candidate configures in workspace. Candidate defaults to a full proposed-prompt reading view and exposes the diff through a disclosure; there is no candidate result panel before a revision exists. Clicks count explicit scripted click operations; browser auto-scroll events are observed separately, not described as human scroll actions. Keyboard typing uses focus, select-all, and insertText. Time-to-feedback includes app preparation and automation overhead. This is a deterministic-model synthetic workflow, not a human study or paid-provider speed/quality test.',
    samples,
  }
  const path = info.outputPath('workflow-comparison.json')
  await writeFile(path, JSON.stringify(report, null, 2))
  await info.attach('workflow-comparison', { path, contentType: 'application/json' })
})
