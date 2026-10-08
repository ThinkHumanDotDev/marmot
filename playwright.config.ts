import { defineConfig, devices } from '@playwright/test'
import 'dotenv/config'

import {
  ADMIN_STATE,
  baseURL,
  mailPort,
  mailURL,
  realtimePort,
  smtpPort,
  realtimeURL,
  targetPort,
  targetURL,
  webPort,
} from './tests/e2e/e2e-env'

/**
 * E2E runs the whole stack: web, worker (checks + heartbeats) and realtime (socket.io), plus a
 * local HTTP server for monitors to check. Worker and realtime always run from the esbuild bundle
 * (`pnpm build:server`, ~100 ms): loading the Payload config through tsx at runtime intermittently
 * never settles. The web app runs `next dev` locally; CI sets `E2E_WEB_COMMAND=pnpm start`. Every
 * command can be overridden (`E2E_WEB_COMMAND`, `E2E_WORKER_COMMAND`, `E2E_REALTIME_COMMAND`).
 * Ports and the base URL are configurable, see `tests/e2e/e2e-env.ts`.
 */
const isCI = !!process.env.CI

// Every process must agree on the public origins: Payload's CSRF check (and the realtime server's
// CORS) only trust NEXT_PUBLIC_SERVER_URL, and the browser connects to NEXT_PUBLIC_REALTIME_URL.
const serverEnv: Record<string, string> = {
  PORT: String(webPort),
  NEXT_PUBLIC_SERVER_URL: baseURL,
  REALTIME_PORT: String(realtimePort),
  NEXT_PUBLIC_REALTIME_URL: process.env.NEXT_PUBLIC_REALTIME_URL || realtimeURL,
  // Every email goes to the mail sink, where specs read emailed links.
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: String(smtpPort),
  SMTP_SECURE: 'false',
  SMTP_USER: '',
  SMTP_PASSWORD: '',
}

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.e2e\.spec\.ts$/,
  globalSetup: './tests/e2e/global-setup.ts',
  outputDir: 'test-results/e2e',
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: isCI
    ? [
        ['junit', { outputFile: 'test-results/e2e-junit.xml' }],
        ['html', { open: 'never' }],
        ['github'],
      ]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
      : {}),
  },
  projects: [
    {
      // Resets the database, runs the first-run wizard and stores the admin session.
      name: 'setup',
      testMatch: /00-setup\.e2e\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
    {
      name: 'chromium',
      dependencies: ['setup'],
      testIgnore: /00-setup\.e2e\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], channel: 'chromium', storageState: ADMIN_STATE },
    },
  ],
  webServer: [
    {
      name: 'target',
      command: `node tests/e2e/target-server.mjs ${targetPort}`,
      url: `${targetURL}/health`,
      reuseExistingServer: !isCI,
      timeout: 10_000,
    },
    {
      name: 'mail',
      command: `node tests/e2e/mail-sink.mjs ${smtpPort} ${mailPort}`,
      url: `${mailURL}/health`,
      reuseExistingServer: !isCI,
      timeout: 10_000,
    },
    {
      name: 'web',
      command: process.env.E2E_WEB_COMMAND || 'pnpm dev:web',
      url: `${baseURL}/api/health`,
      env: serverEnv,
      reuseExistingServer: !isCI,
      timeout: 180_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
    {
      name: 'realtime',
      command: process.env.E2E_REALTIME_COMMAND || 'pnpm build:server && pnpm start:realtime',
      url: `http://localhost:${realtimePort}/healthz`,
      env: serverEnv,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
    {
      // No HTTP port: ready once the BullMQ check worker logs that it consumes the queue.
      name: 'worker',
      command: process.env.E2E_WORKER_COMMAND || 'pnpm build:server && pnpm start:worker',
      wait: { stdout: /check worker ready/ },
      env: serverEnv,
      timeout: 120_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
  ],
})
