import { defineConfig, devices } from '@playwright/test'

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './tests/e2e',
  /* Run tests in files in parallel */
  fullyParallel: false,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: Boolean(process.env.CI),
  /* Retry on CI only - skipped for now as during exploration it is expected for lot of tests to fail and retries will slow down seeing tests that do pass */
  retries: process.env.CI ? 2 : 0,
  /* Limit the number of workers on CI, use default locally */
  workers: process.env.CI ? 3 : undefined,
  globalSetup: './tests/test-setup-e2e.ts',
  globalTeardown: './tests/test-teardown-e2e.ts',
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: process.env.CI ? [['blob'], ['list']] : [['list']],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: process.env.URL,
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
    extraHTTPHeaders: {
      /* Add debug logging for netlify cache headers */
      'x-nf-debug-logging': '1',
      'x-next-debug-logging': '1',
      'x-nf-enable-tracing': '1',
    },
  },
  timeout: 10 * 60 * 1000,
  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
