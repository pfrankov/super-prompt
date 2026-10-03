import { test as base, expect, type BrowserContext, type Page, type TestInfo } from '@playwright/test'

export const TASK_ID = 'synthetic-task'
export const DATASET_ID = 'synthetic-dataset'
export const ORIGINAL_PROMPT = 'You are a helpful assistant. Give a clear and concise answer.'
export const IMPROVED_PROMPT = `${ORIGINAL_PROMPT}\nBefore answering, identify the user intent and hard constraints. Return the final answer first.`

export const test = base.extend<{ safety: void }>({
  safety: [async ({ context, page }, use) => {
    const blocked: string[] = []
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await confineNetwork(context, blocked)
    await use()
    expect(blocked, 'Synthetic tests must never contact an external provider').toEqual([])
    expect(errors, 'No uncaught application errors').toEqual([])
  }, { auto: true }],
})
export { expect }

export async function confineNetwork(context: BrowserContext, blocked: string[] = []) {
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1' && ['4173', '4174'].includes(url.port)) {
      await route.continue()
    } else {
      blocked.push(`${url.origin}${url.pathname}`)
      await route.abort('blockedbyclient')
    }
  })
}

// The fixture uses the public, stable v1 IndexedDB schema. Both revisions get
// byte-equivalent logical records; it does not import candidate application code.
export async function seedWorkspace(page: Page, options: {
  origin?: string
  itemCount?: number
  runCount?: number
  candidatesPerRun?: number
  providerBaseUrl?: string
  lastRunStatus?: 'completed' | 'running' | 'paused' | 'stopped' | 'failed'
} = {}) {
  const origin = options.origin ?? 'http://127.0.0.1:4173'
  await page.goto(`${origin}/__fixture.html`)
  await page.evaluate(async ({ options, taskId, datasetId, original, improved }) => {
    localStorage.setItem('sp.lang', 'en')
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('super-prompt', 1)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
      request.onupgradeneeded = () => {
        const db = request.result
        const stores: Record<string, [string, string | string[]][]> = {
          tasks: [['by-updatedAt', 'updatedAt']],
          datasets: [['by-taskId', 'taskId']],
          datasets_items: [['by-datasetId', 'datasetId']],
          runs: [['by-taskId', 'taskId'], ['by-status', 'status']],
          candidates: [['by-runId', 'runId'], ['by-runId-score', ['runId', 'score']]],
          iterations: [['by-runId', 'runId'], ['by-runId-index', ['runId', 'index']]],
          pairs: [['by-iterationId', 'iterationId']],
          settings: [],
        }
        for (const [name, indexes] of Object.entries(stores)) {
          const store = db.createObjectStore(name, { keyPath: 'id' })
          for (const [name, path] of indexes) store.createIndex(name, path)
        }
      }
    })
    const names = Array.from(database.objectStoreNames)
    const transaction = database.transaction(names, 'readwrite')
    const completed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    for (const name of names) transaction.objectStore(name).clear()
    const put = (store: string, value: object) => transaction.objectStore(store).put(value)
    const now = 1_760_000_000_000
    const itemCount = options.itemCount ?? 8
    const runCount = options.runCount ?? 0
    const candidatesPerRun = options.candidatesPerRun ?? 12
    const config = { iterationsCap: 8, tokenBudget: 0, concurrency: 1, sampleSizePerIter: 2, earlyStopPlateau: 0, judgeTemperature: 0, targetTemperature: 0, mutatorTemperature: 0 }
    put('settings', {
      id: 'singleton', lang: 'en',
      provider: { id: 'synthetic-demo', label: 'Synthetic demo', baseUrl: options.providerBaseUrl ?? 'mock://super-prompt', apiKey: '', targetModel: 'mock-target', judgeModel: 'mock-judge', requestTimeoutMs: 5000, maxRetries: 0, modelRateLimits: [] },
      arbitrator: { enabled: false, baseUrl: '', apiKey: '', model: '' },
      judgeTemperature: 0, targetTemperature: 0, mutatorTemperature: 0, sampleSizePerIter: 2, concurrency: 1,
    })
    put('tasks', { id: taskId, name: 'Synthetic prompt fixture', description: 'Synthetic local-only benchmark. No customer data.', initialPrompt: original, seedPrompts: [], rubric: { text: 'Score accuracy and instruction following from 0 to 10.' }, datasetId, providerId: null, createdAt: now, updatedAt: now })
    put('datasets', { id: datasetId, taskId, name: 'Synthetic examples', itemCount, createdAt: now })
    for (let index = 0; index < itemCount; index += 1) {
      put('datasets_items', { id: `item-${String(index).padStart(5, '0')}`, datasetId, input: `Synthetic example ${index}: Return the final answer only: ${index} + 1.`, expectedOutput: String(index + 1), meta: { source: 'manual', fixture: 'e2e-v1' } })
    }
    for (let index = 0; index < runCount; index += 1) {
      const runId = `run-${String(index).padStart(5, '0')}`
      const last = index === runCount - 1
      const status = last ? (options.lastRunStatus ?? 'completed') : 'completed'
      put('runs', { id: runId, taskId, config, status, bestCandidateId: `${runId}-candidate-${candidatesPerRun - 1}`, totalTokensIn: 1000, totalTokensOut: 500, iterationCount: 3, startedAt: now + index * 1000, finishedAt: ['running', 'paused'].includes(status) ? null : now + index * 1000 + 900, errorMessage: status === 'failed' ? 'Synthetic provider failure' : null })
      for (let candidate = 0; candidate < candidatesPerRun; candidate += 1) {
        put('candidates', { id: `${runId}-candidate-${candidate}`, runId, parentId: candidate ? `${runId}-candidate-0` : null, text: candidate ? `${improved}\nSynthetic revision ${candidate}.` : original, source: candidate ? 'mutated' : 'seed', score: 5 + candidate / 10, wins: candidate, losses: 0, ties: 0, iterations: 1, tokensIn: 100, tokensOut: 50, rationale: 'Synthetic mutation, not evidence of quality.', createdAt: now + index * 1000 + candidate })
      }
    }
    await completed
    database.close()
  }, { options, taskId: TASK_ID, datasetId: DATASET_ID, original: ORIGINAL_PROMPT, improved: IMPROVED_PROMPT })
}

export async function openWorkspace(page: Page) {
  await page.goto(`/#/task/${TASK_ID}/improve`)
  await expect(page.getByTestId('workspace-ready')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Your prompt', exact: true })).toHaveAttribute('contenteditable', 'true')
}

export async function readRecords(page: Page, store: string): Promise<Record<string, unknown>[]> {
  return page.evaluate(async (store) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('super-prompt', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const request = db.transaction(store).objectStore(store).getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    } finally { db.close() }
  }, store)
}

export async function attachScreenshot(page: Page, info: TestInfo, name: string, fullPage = true) {
  await info.attach(name, { body: await page.screenshot({ fullPage, animations: 'disabled' }), contentType: 'image/png' })
}

export async function expectNoOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
  expect(dimensions.scroll, 'The document must fit the viewport').toBeLessThanOrEqual(dimensions.width + 1)
}
