import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { test, expect, attachScreenshot, confineNetwork, expectNoOverflow, seedWorkspace, TASK_ID } from './fixtures'

type ReadRequest = { store: string; index: string | null; method: string; at: number }
type Measurement = {
  firstContentfulPaintMs: number | null
  domContentLoadedMs: number
  domNodes: number
  longTasks: number
  longTaskTotalMs: number
  longestTaskMs: number
  fullReads: ReadRequest[]
}
type BrowserEvidence = Window & {
  __e2eLongTasks: { startTime: number; duration: number }[]
  __e2eReads: ReadRequest[]
}

async function collect(page: Page) {
  await page.addInitScript(() => {
    const evidence = window as unknown as BrowserEvidence
    evidence.__e2eLongTasks = []
    evidence.__e2eReads = []
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      new PerformanceObserver((list) => {
        evidence.__e2eLongTasks.push(...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration })))
      }).observe({ type: 'longtask', buffered: true })
    }
    const indexGetAll = IDBIndex.prototype.getAll
    IDBIndex.prototype.getAll = function (...args) {
      evidence.__e2eReads.push({ store: this.objectStore.name, index: this.name, method: 'getAll', at: performance.now() })
      return indexGetAll.apply(this, args)
    }
    const storeGetAll = IDBObjectStore.prototype.getAll
    IDBObjectStore.prototype.getAll = function (...args) {
      evidence.__e2eReads.push({ store: this.name, index: null, method: 'getAll', at: performance.now() })
      return storeGetAll.apply(this, args)
    }
  })
}

async function measure(page: Page, since = 0): Promise<Measurement> {
  return page.evaluate(async (since) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const evidence = window as unknown as BrowserEvidence
    const longTasks = evidence.__e2eLongTasks.filter((task) => task.startTime >= since)
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
    return {
      firstContentfulPaintMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
      domContentLoadedMs: navigation.domContentLoadedEventEnd,
      domNodes: document.querySelectorAll('*').length,
      longTasks: longTasks.length,
      longTaskTotalMs: longTasks.reduce((sum, task) => sum + task.duration, 0),
      longestTaskMs: Math.max(0, ...longTasks.map((task) => task.duration)),
      fullReads: evidence.__e2eReads.filter((request) => request.at >= since),
    }
  }, since)
}

async function duration(page: Page, start: number) {
  return page.evaluate((start) => performance.now() - start, start)
}

async function benchmarkVariant(browser: Browser, origin: string, variant: 'baseline' | 'candidate', round: number, info: TestInfo) {
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block', reducedMotion: 'reduce' })
  const blocked: string[] = []
  await confineNetwork(context, blocked)
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await collect(page)
  try {
    await seedWorkspace(page, { origin, itemCount: 10_000, runCount: 1_000, candidatesPerRun: 12 })
    await page.goto(`${origin}/#/task/${TASK_ID}/dataset`)
    await expect(page.locator('tbody tr')).toHaveCount(10)
    await expect(page.locator('tbody textarea')).toHaveCount(20)
    const datasetReadyMs = await page.evaluate(() => performance.now())
    const dataset = await measure(page)
    if (variant === 'candidate') {
      expect(dataset.fullReads.filter((request) => request.store === 'datasets_items')).toEqual([])
      expect(dataset.domNodes).toBeLessThan(1_000)
      await expectNoOverflow(page)
    }

    const nextStarted = await page.evaluate(() => performance.now())
    // The baseline uses symbols; candidate may supply accessible page names.
    await page.locator('.pager button').last().click()
    await expect(page.locator('tbody textarea').first()).toHaveValue(/^Synthetic example 10:/)
    const datasetNextPageMs = await duration(page, nextStarted)
    const datasetNext = await measure(page, nextStarted)
    if (variant === 'candidate') expect(datasetNext.fullReads.filter((request) => request.store === 'datasets_items')).toEqual([])

    const historyStarted = await page.evaluate(() => performance.now())
    await page.getByRole('tab', { name: 'History', exact: true }).click()
    const historyRows = variant === 'candidate' ? 20 : 1_000
    await expect(page.locator('.list > .run')).toHaveCount(historyRows, { timeout: 60_000 })
    const historyReadyMs = await duration(page, historyStarted)
    const history = await measure(page, historyStarted)
    const initialCandidateRows = await page.locator('.cand').count()
    let historyExpandMs: number | null = null
    let historyNextPageMs: number | null = null
    if (variant === 'candidate') {
      expect(initialCandidateRows).toBe(0)
      expect(history.fullReads.filter((request) => request.store === 'candidates')).toEqual([])
      expect(history.domNodes).toBeLessThan(2_000)
      const expandedAt = await page.evaluate(() => performance.now())
      await page.locator('.list > .run').first().locator('summary').click()
      await expect(page.locator('.cand')).toHaveCount(8)
      historyExpandMs = await duration(page, expandedAt)
      expect(await page.locator('.cand .score').allTextContents()).toEqual(['6.10', '6.00', '5.90', '5.80', '5.70', '5.60', '5.50', '5.40'])
      const pagedAt = await page.evaluate(() => performance.now())
      await page.getByRole('navigation', { name: 'History', exact: true }).getByRole('button', { name: 'Next', exact: true }).click()
      await expect(page.getByRole('navigation', { name: 'History', exact: true })).toContainText('21–40 of 1000 runs')
      await expect(page.locator('.list > .run')).toHaveCount(20)
      await expect(page.locator('.cand')).toHaveCount(0)
      historyNextPageMs = await duration(page, pagedAt)
    } else {
      expect(initialCandidateRows).toBe(8_000)
    }
    // The baseline creates a very tall 1,000-card document. A viewport capture
    // keeps evidence useful without allocating a hundreds-of-megapixels image.
    if (round === 0) await attachScreenshot(page, info, `${variant}-1000-run-history-viewport`, false)
    expect(blocked).toEqual([])
    expect(errors).toEqual([])
    return { variant, round, datasetReadyMs, datasetNextPageMs, historyReadyMs, historyExpandMs, historyNextPageMs, historyRows, initialCandidateRows, dataset, datasetNext, history }
  } finally { await context.close() }
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

test('@benchmark same-host 10k examples / 1k runs: bounded UI and paired measurements', async ({ browser }, info) => {
  test.setTimeout(360_000)
  const baselineURL = process.env.E2E_BASELINE_URL
  const samples: Awaited<ReturnType<typeof benchmarkVariant>>[] = []
  for (let round = 0; round < 3; round += 1) {
    const order: ('baseline' | 'candidate')[] = baselineURL ? (round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) : ['candidate']
    for (const variant of order) {
      samples.push(await benchmarkVariant(browser, variant === 'baseline' ? baselineURL! : 'http://127.0.0.1:4173', variant, round, info))
    }
  }
  const summary = (variant: string) => {
    const rows = samples.filter((sample) => sample.variant === variant)
    if (!rows.length) return null
    return {
      samples: rows.length,
      datasetReadyMedianMs: median(rows.map((row) => row.datasetReadyMs)),
      datasetNextPageMedianMs: median(rows.map((row) => row.datasetNextPageMs)),
      historyReadyMedianMs: median(rows.map((row) => row.historyReadyMs)),
      historyDomNodesMedian: median(rows.map((row) => row.history.domNodes)),
      historyLongTaskTotalMedianMs: median(rows.map((row) => row.history.longTaskTotalMs)),
      datasetFcpMedianMs: median(rows.map((row) => row.dataset.firstContentfulPaintMs).filter((value): value is number => value !== null)),
    }
  }
  const report = {
    schemaVersion: 1,
    environment: { node: process.version, browser: browser.version(), platform: process.platform, viewport: { width: 1440, height: 1000 }, locale: 'en-US', timezone: 'UTC', reducedMotion: true },
    revisions: { baseline: process.env.E2E_BASELINE_SHA ?? null, candidate: process.env.E2E_CANDIDATE_SHA ?? null },
    fixture: { version: 'e2e-v1', examples: 10_000, runs: 1_000, candidatesPerRun: 12, syntheticOnly: true },
    method: 'Fresh browser contexts; static production builds on the same runner; no-store HTTP; alternating baseline/candidate order; three samples per build; fixture insertion excluded. Interaction durations include automation and DOM-ready waits. FCP is a paint entry, not an interaction or human-usability score. No relative timing assertion or human-study claim.',
    summary: { baseline: summary('baseline'), candidate: summary('candidate') },
    samples,
  }
  const output = info.outputPath('benchmark-comparison.json')
  await writeFile(output, JSON.stringify(report, null, 2))
  await info.attach('benchmark-comparison', { path: output, contentType: 'application/json' })
})
