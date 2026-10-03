import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:4173'
const baselineURL = process.env.E2E_BASELINE_URL
const readerBaselineURL = process.env.E2E_READER_BASELINE_URL

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // Shared-host measurements must not compete with another browser worker.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  outputDir: 'test-results',
  reporter: [
    ['line'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
  ],
  use: {
    baseURL,
    locale: 'en-US',
    timezoneId: 'UTC',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    {
      name: 'mobile',
      grepInvert: /@benchmark/,
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' },
    },
  ],
  webServer: [
    {
      command: 'node tests/e2e/serve.mjs',
      url: baseURL,
      reuseExistingServer: false,
      timeout: 15_000,
    },
    ...(baselineURL ? [{
      command: 'node tests/e2e/serve.mjs',
      url: baselineURL,
      env: { E2E_PORT: '4174', E2E_DIST_DIR: '.benchmark-baseline/dist' },
      reuseExistingServer: false,
      timeout: 15_000,
    }] : []),
    ...(readerBaselineURL ? [{
      command: 'node tests/e2e/serve.mjs',
      url: readerBaselineURL,
      env: { E2E_PORT: '4175', E2E_DIST_DIR: '.reader-baseline/dist' },
      reuseExistingServer: false,
      timeout: 15_000,
    }] : []),
  ],
})
