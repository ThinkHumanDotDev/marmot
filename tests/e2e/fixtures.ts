import { execFileSync } from 'node:child_process'

import {
  test as base,
  expect,
  request,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test'

import { baseURL, RESET_DB_BUNDLE, targetURL } from './e2e-env'

export { expect }
export { ADMIN_STATE, baseURL, targetURL } from './e2e-env'

/**
 * Shared e2e fixtures and helpers.
 *
 * The `setup` project (`00-setup.e2e.spec.ts`) resets the database with `resetDatabase()`, runs the
 * first-run wizard as `ADMIN` (creating `SETUP_ORG`) and stores the session in `ADMIN_STATE`. Every
 * other spec runs in the `chromium` project, which depends on `setup` and starts signed in as that
 * superadmin; use `test.use({ storageState: ANONYMOUS })` or the `anonymousPage` fixture for visitors.
 *
 * The Playwright process never imports the Payload config: seeding goes through the REST API as the
 * superadmin (`adminApi` fixture) and the reset runs a bundled Local API script in a child process.
 */

/** Superadmin created by the setup wizard. */
export const ADMIN = {
  name: 'Ada Lovelace',
  email: 'ada@marmot.test',
  password: 'correct-horse-battery',
} as const

/** Organization created by the setup wizard. */
export const SETUP_ORG = { name: 'Analytical Engines', slug: 'analytical-engines' } as const

/** Storage state of a signed-out visitor. */
export const ANONYMOUS = { cookies: [], origins: [] }

/** Document ids are numbers on Postgres and strings on MongoDB. */
export type DocId = string | number

/** Unique suffix for names and slugs created by one run (or one retry) of a spec file. */
export const runId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

/** URL on the local fixture HTTP server that monitors can check. */
export const targetUrl = (path = '/health') => `${targetURL}${path}`

/**
 * Deletes every document (except applied migrations) through the Local API so the instance needs
 * setup again. Runs the bundle built by `global-setup.ts` with plain `node`.
 */
export function resetDatabase(): void {
  execFileSync(process.execPath, [RESET_DB_BUNDLE], { stdio: 'inherit', timeout: 120_000 })
}

/** Signs in through the Marmot login page; resolves once the app has navigated away from it. */
export async function signIn(
  page: Page,
  user: { email: string; password: string },
  next?: string,
): Promise<void> {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : '/login')
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Password').fill(user.password)
  await page.getByRole('button', { name: /^sign in$/i }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
}

/** A fresh browser context (and page) with the given storage state. */
export async function newSession(
  browser: Browser,
  storageState: string | typeof ANONYMOUS = ANONYMOUS,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ storageState })
  const page = await context.newPage()
  return { context, page }
}

/** Thin JSON client for the Payload REST API, authenticated as the setup admin. */
export class AdminApi {
  constructor(readonly context: APIRequestContext) {}

  private async json<T>(method: string, path: string, data?: unknown): Promise<T> {
    const res = await this.context.fetch(`/api${path}`, { method, data })
    if (!res.ok()) {
      throw new Error(`${method} /api${path} → ${res.status()}: ${await res.text()}`)
    }
    return (await res.json()) as T
  }

  /** `GET /api/<collection>` with a flat `where[field][op]=value` query. */
  async find<T = Record<string, unknown>>(
    collection: string,
    where: Record<string, Record<string, string>> = {},
    extra: Record<string, string> = {},
  ): Promise<T[]> {
    const params = new URLSearchParams({ depth: '0', ...extra })
    for (const [field, ops] of Object.entries(where)) {
      for (const [op, value] of Object.entries(ops)) params.set(`where[${field}][${op}]`, value)
    }
    return (await this.json<{ docs: T[] }>('GET', `/${collection}?${params}`)).docs
  }

  async create<T extends { id: DocId } = { id: DocId }>(
    collection: string,
    data: Record<string, unknown>,
  ): Promise<T> {
    return (await this.json<{ doc: T }>('POST', `/${collection}?depth=0`, data)).doc
  }

  async update<T extends { id: DocId } = { id: DocId }>(
    collection: string,
    id: DocId,
    data: Record<string, unknown>,
  ): Promise<T> {
    return (await this.json<{ doc: T }>('PATCH', `/${collection}/${id}?depth=0`, data)).doc
  }

  async delete(collection: string, id: DocId): Promise<void> {
    await this.json('DELETE', `/${collection}/${id}`)
  }

  /**
   * Creates a monitor whose checks the worker will run. The `monitors` afterChange hook upserts the
   * BullMQ scheduler before the create transaction commits, so an idle worker can pick up the first
   * job, not find the monitor yet and drop the scheduler. So the monitor is created paused and
   * activated once the row is committed (activating before any beat also means the update cannot
   * write a stale `status` over the worker's first result).
   */
  async createMonitor(data: Record<string, unknown>): Promise<{ id: DocId }> {
    const monitor = await this.create('monitors', { ...data, active: false })
    if (data.active ?? true) await this.update('monitors', monitor.id, { active: true })
    return monitor
  }

  async organizationId(slug: string): Promise<DocId> {
    const [org] = await this.find<{ id: DocId }>('organizations', { slug: { equals: slug } })
    if (!org) throw new Error(`No organization ${slug}`)
    return org.id
  }

  /** Token of the most recent pending invitation addressed to `email`. */
  async invitationToken(email: string): Promise<string> {
    const [invitation] = await this.find<{ token?: string }>(
      'invitations',
      { email: { equals: email }, status: { equals: 'pending' } },
      { sort: '-createdAt', limit: '1' },
    )
    if (!invitation?.token) throw new Error(`No pending invitation for ${email}`)
    return invitation.token
  }

  /**
   * Waits until the worker has checked the monitor: a heartbeat with `status` exists and the
   * monitor's `status.lastStatus` (written after the heartbeat, read by status pages) matches.
   */
  async waitForHeartbeat(monitorId: DocId, status = 'up', timeout = 45_000): Promise<void> {
    await expect
      .poll(
        async () => {
          const beats = await this.find('heartbeats', {
            monitor: { equals: String(monitorId) },
            status: { equals: status },
          })
          if (beats.length === 0) return 'no heartbeat'
          const [monitor] = await this.find<{ status?: { lastStatus?: string } }>('monitors', {
            id: { equals: String(monitorId) },
          })
          return monitor?.status?.lastStatus ?? 'unknown'
        },
        { timeout, message: `heartbeat "${status}" for monitor ${monitorId}` },
      )
      .toBe(status)
  }
}

interface TestFixtures {
  /** A page in a separate, signed-out browser context. */
  anonymousPage: Page
}

interface WorkerFixtures {
  /** REST client signed in as the setup admin (superadmin); usable in `beforeAll`. */
  adminApi: AdminApi
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  adminApi: [
    async ({}, provide) => {
      // Authenticate with a bearer token rather than the stored cookie, so the client does not depend
      // on Payload's cookie/CSRF rules for non-browser requests.
      const login = await request.newContext({ baseURL })
      const res = await login.post('/api/users/login', {
        data: { email: ADMIN.email, password: ADMIN.password },
      })
      if (!res.ok()) throw new Error(`admin login failed: ${res.status()} ${await res.text()}`)
      const { token } = (await res.json()) as { token: string }
      await login.dispose()
      const context = await request.newContext({
        baseURL,
        extraHTTPHeaders: { Authorization: `JWT ${token}` },
      })
      await provide(new AdminApi(context))
      await context.dispose()
    },
    { scope: 'worker' },
  ],
  anonymousPage: async ({ browser }, provide) => {
    const { context, page } = await newSession(browser)
    await provide(page)
    await context.close()
  },
})
