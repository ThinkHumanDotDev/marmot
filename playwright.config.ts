import { defineConfig, devices } from '@playwright/test'
import 'dotenv/config'

const baseURL = process.env.E2E_BASE_URL || 'http://localhost:3000'

export default defineConfig({
  testDir: './tests/e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [
        ['junit', { outputFile: 'test-results/e2e-junit.xml' }],
        ['html', { open: 'never' }],
        ['github'],
      ]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chromium',
        ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
          : {}),
      },
    },
  ],
  webServer: {
    command: process.env.E2E_WEB_COMMAND || 'pnpm dev:web',
    reuseExistingServer: !process.env.CI,
    url: baseURL,
    timeout: 180_000,
  },
})
