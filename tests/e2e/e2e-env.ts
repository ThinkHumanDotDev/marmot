/**
 * Addresses used by the e2e suite. Shared by `playwright.config.ts` (which starts the processes) and
 * the specs (which point monitors at the target server), so it must stay free of Payload imports.
 *
 * - `E2E_BASE_URL` – web app origin (default `http://localhost:<E2E_PORT>`)
 * - `E2E_PORT` – web app port when `E2E_BASE_URL` is unset (default 3000)
 * - `E2E_REALTIME_PORT` – realtime (socket.io) port (default web port + 1)
 * - `E2E_TARGET_PORT` – local HTTP server that HTTP monitors check (default web port + 2)
 */
const rawBaseURL = process.env.E2E_BASE_URL?.trim()

const port = Number(process.env.E2E_PORT || (rawBaseURL ? new URL(rawBaseURL).port : '') || 3000)

export const baseURL = (rawBaseURL || `http://localhost:${port}`).replace(/\/+$/, '')

export const webPort = port

export const realtimePort = Number(process.env.E2E_REALTIME_PORT || port + 1)

export const realtimeURL = `http://${new URL(baseURL).hostname}:${realtimePort}`

export const targetPort = Number(process.env.E2E_TARGET_PORT || port + 2)

/** Origin of the fixture HTTP server (`tests/e2e/target-server.mjs`). */
export const targetURL = `http://127.0.0.1:${targetPort}`

/** Storage state of the admin created by the setup wizard (written by `00-setup.e2e.spec.ts`). */
export const ADMIN_STATE = 'test-results/e2e/.auth/admin.json'

/** Bundled `support/reset-db.ts`, built by `global-setup.ts`. */
export const RESET_DB_BUNDLE = 'node_modules/.cache/marmot-e2e/reset-db.mjs'
