import { writeFile } from 'node:fs/promises'
import { test, expect, attachScreenshot, confineNetwork, expectNoOverflow, seedWorkspace, TASK_ID } from './fixtures'

const LINE_COUNT = 50_000
const ORIGINAL = Array.from({ length: LINE_COUNT }, (_, i) => `A ${i}\n`).join('')
const REVISED = Array.from({ length: LINE_COUNT }, (_, i) => `B ${i}\n`).join('')
type ReaderEvidence = Window & { __readerLongTasks: { start: number; duration: number }[] }

test('oversized revision reader bounds text and preserves keyboard paging', async ({ page }, info) => {
  await seedWorkspace(page, { runCount: 1, candidatesPerRun: 2, initialPrompt: ORIGINAL, bestPrompt: REVISED })
  await page.goto(`/#/task/${TASK_ID}/improve`)
  const reader = page.getByTestId('result-prompt')
  await expect(reader).toBeVisible()
  const first = (await reader.textContent())!
  expect(first.length).toBeLessThanOrEqual(32_000)
  expect((first.match(/\n/g) ?? []).length).toBeLessThanOrEqual(200)
  expect(REVISED.startsWith(first)).toBe(true)
  await expect(page.getByTestId('result-prompt-pagination')).toBeVisible()
  await expect(page.getByTestId('result-prompt-previous')).toBeDisabled()
  await page.getByTestId('result-prompt-next').focus()
  await page.keyboard.press('Enter')
  const second = (await reader.textContent())!
  expect(second).toBe(REVISED.slice(first.length, first.length + second.length))
  expect(second.length).toBeLessThanOrEqual(32_000)
  expect((second.match(/\n/g) ?? []).length).toBeLessThanOrEqual(200)
  await page.getByTestId('result-prompt-previous').press('Enter')
  expect(await reader.textContent()).toBe(first)
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { (window as unknown as { __copiedPrompt: string }).__copiedPrompt = value } } })
  })
  await page.getByRole('button', { name: 'Copy', exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as { __copiedPrompt: string }).__copiedPrompt)).toBe(REVISED)
  await expectNoOverflow(page)
  await attachScreenshot(page, info, 'bounded-revision-reader', false)
})

test('@benchmark same-host oversized revision reader layout', async ({ browser }, info) => {
  test.skip(!process.env.E2E_READER_BASELINE_URL, 'Requires the immutable reader baseline build')
  test.setTimeout(180_000)
  const samples: Record<string, unknown>[] = []
  const order = ['baseline', 'candidate', 'candidate', 'baseline', 'baseline', 'candidate'] as const
  for (const [index, variant] of order.entries()) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
    const blocked: string[] = []
    const errors: string[] = []
    await confineNetwork(context, blocked)
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(() => {
      const evidence = window as unknown as ReaderEvidence
      evidence.__readerLongTasks = []
      if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        new PerformanceObserver((list) => evidence.__readerLongTasks.push(...list.getEntries().map((entry) => ({ start: entry.startTime, duration: entry.duration })))).observe({ type: 'longtask', buffered: true })
      }
    })
    try {
      const origin = variant === 'baseline' ? process.env.E2E_READER_BASELINE_URL! : 'http://127.0.0.1:4173'
      await seedWorkspace(page, { origin, runCount: 1, candidatesPerRun: 2, initialPrompt: ORIGINAL, bestPrompt: REVISED })
      await page.goto(`${origin}/#/task/${TASK_ID}/improve`)
      const reader = page.getByTestId('result-prompt')
      await expect(reader).toBeVisible()
      const sample = await reader.evaluate(async (element) => {
        const layoutStart = performance.now()
        const scrollHeight = element.scrollHeight
        const clientHeight = element.clientHeight
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        const readyAt = performance.now()
        const evidence = window as unknown as ReaderEvidence
        const heap = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize
        const text = element.textContent ?? ''
        return {
          navigationToReaderPaintOpportunityMs: readyAt,
          finalLayoutReadToPaintOpportunityMs: readyAt - layoutStart,
          renderedCharacters: text.length,
          renderedLineBreaks: (text.match(/\n/g) ?? []).length,
          scrollHeight, clientHeight,
          domNodes: document.querySelectorAll('*').length,
          longTaskTotalMs: evidence.__readerLongTasks.reduce((sum, task) => sum + task.duration, 0),
          longestTaskMs: Math.max(0, ...evidence.__readerLongTasks.map((task) => task.duration)),
          usedJSHeapSizeBytes: typeof heap === 'number' ? heap : null,
        }
      })
      if (variant === 'candidate') {
        expect(sample.renderedCharacters).toBeLessThanOrEqual(32_000)
        expect(sample.renderedLineBreaks).toBeLessThanOrEqual(200)
      } else expect(sample.renderedCharacters).toBe(REVISED.length)
      if (index < 2) await attachScreenshot(page, info, `reader-${variant}`, false)
      samples.push({ variant, round: Math.floor(index / 2), ...sample })
      expect(blocked).toEqual([])
      expect(errors).toEqual([])
    } finally { await context.close() }
  }
  const report = {
    revisions: { baseline: process.env.E2E_READER_BASELINE_SHA, candidate: process.env.E2E_CANDIDATE_SHA },
    fixture: { lines: LINE_COUNT, originalCharacters: ORIGINAL.length, proposedCharacters: REVISED.length },
    method: 'Three interleaved samples per exact production build on the same runner, fresh browser contexts, identical synthetic IndexedDB fixture, reduced motion. Time starts at navigation time origin and includes page loading, layout and automation wait overhead. The final geometry read plus two animation frames records a paint opportunity, not an actual display timestamp or INP. Structural text/line caps are hard assertions; timings are observations, not relative speed gates. Optional JS heap is coarse, excludes total process memory and has no forced-GC control.',
    samples,
  }
  const path = info.outputPath('reader-comparison.json')
  await writeFile(path, JSON.stringify(report, null, 2))
  await info.attach('reader-comparison', { path, contentType: 'application/json' })
})
