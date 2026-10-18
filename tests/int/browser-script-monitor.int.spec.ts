/**
 * Browser Script monitor (#139) end to end: a real Chromium (a local Playwright browser server, the
 * kind of remote browser the monitor connects to) runs scripted journeys against a local login
 * page through the real check path (`processCheckJob`), and failing checks store a screenshot and a
 * Playwright trace. The sandbox's escape attempts are covered without a browser in
 * `src/server/browser-script/sandbox.test.ts`; here they run through the whole stack.
 *
 * Chromium comes from `PLAYWRIGHT_CHROMIUM_PATH` when set, else Playwright's own install
 * (`pnpm exec playwright install chromium`, done by CI before the integration tests).
 */
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { chromium, type BrowserServer } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import { GET as restGet } from '@/app/(payload)/api/[...slug]/route'
import { env, resetEnvCache } from '@/env'
import { parseBrowserDetails } from '@/lib/browser-script'
import { monitorFormSchema } from '@/lib/validation/monitor-schema'
import type { CheckArtifact, Heartbeat, Monitor, Organization } from '@/payload-types'
import { clearHeartbeatListeners, processCheckJob, type ChecksQueue } from '@/server/engine'
import { processAdhocCheckJob } from '@/server/engine/on-demand-jobs'
import { runRetention } from '@/server/jobs/retention'

let payload: Payload
let org: Organization
let browserServer: BrowserServer
let remoteBrowser: string
let server: http.Server
let baseUrl: string
const run = Date.now().toString(36)

const GUARD_VARS = [
  'MONITOR_DENY_PRIVATE_ADDRESSES',
  'MONITOR_DENY_CIDRS',
  'MONITOR_ALLOW_CIDRS',
] as const
const savedGuard = Object.fromEntries(GUARD_VARS.map((key) => [key, process.env[key]]))

function setGuard(vars: Partial<Record<(typeof GUARD_VARS)[number], string>>) {
  for (const key of GUARD_VARS) {
    if (vars[key] === undefined) delete process.env[key]
    else process.env[key] = vars[key]
  }
  resetEnvCache()
}

const LOGIN_PAGE = `<!doctype html>
<html><head><title>Sign in</title></head><body>
<form method="post" action="/login">
  <label for="email">Email</label><input id="email" name="email" type="email">
  <label for="password">Password</label><input id="password" name="password" type="password">
  <button type="submit">Sign in</button>
</form>
<img src="/missing.png" alt="">
<script>console.error('analytics failed to load')</script>
</body></html>`

const DASHBOARD = `<!doctype html>
<html><head><title>Dashboard</title></head><body><h1>Welcome, Ada</h1></body></html>`

const JOURNEY = (expected: string) => `
await test.step('open the login page', async () => {
  await page.goto('/login')
})
await test.step('sign in', async () => {
  await page.getByLabel('Email').fill(vars.email)
  await page.getByLabel('Password').fill(secrets.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
})
await test.step('see the dashboard', async () => {
  await expect(page).toHaveURL(/\\/dashboard$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(${JSON.stringify(expected)}, { timeout: 1500 })
})
`

const fakeQueue = () =>
  ({
    upsertJobScheduler: vi.fn(async () => undefined),
    removeJobScheduler: vi.fn(async () => true),
  }) as unknown as ChecksQueue

async function createMonitor(data: Partial<Monitor> = {}): Promise<Monitor> {
  return (await payload.create({
    collection: 'monitors',
    overrideAccess: true,
    depth: 0,
    context: { skipEngineSync: true },
    data: {
      organization: org.id,
      name: `Login journey ${run}`,
      type: 'browser-script',
      url: baseUrl,
      remoteBrowser,
      browserScript: JOURNEY('Welcome, Ada'),
      browserVariables: [{ name: 'email', value: 'ada@example.com' }],
      browserSecrets: [{ name: 'password', value: 'hunter22-secret' }],
      interval: 60,
      retryInterval: 60,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 20,
      ...data,
    } as RequiredDataFromCollectionSlug<'monitors'>,
  })) as Monitor
}

async function check(monitor: Monitor): Promise<Heartbeat> {
  const result = await processCheckJob(
    payload,
    { data: { monitorId: String(monitor.id) } },
    { queue: fakeQueue() },
  )
  expect(result.outcome).toBe('processed')
  return result.heartbeat as Heartbeat
}

async function artifactsOf(heartbeat: Heartbeat): Promise<CheckArtifact[]> {
  const { docs } = await payload.find({
    collection: 'check-artifacts',
    where: { heartbeat: { equals: heartbeat.id } },
    depth: 0,
    overrideAccess: true,
    sort: 'kind',
  })
  return docs as CheckArtifact[]
}

const artifactFile = (doc: CheckArtifact) =>
  readFile(path.join(env.UPLOADS_DIR, 'check-artifacts', doc.filename ?? ''))

beforeAll(async () => {
  payload = await getPayload({ config })
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'POST' && url.pathname === '/login') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const form = new URLSearchParams(body)
        const ok =
          form.get('email') === 'ada@example.com' && form.get('password') === 'hunter22-secret'
        if (ok) res.writeHead(302, { location: '/dashboard' }).end()
        else res.writeHead(401, { 'content-type': 'text/html' }).end('<h1>Invalid credentials</h1>')
      })
      return
    }
    if (url.pathname === '/login') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(LOGIN_PAGE)
    } else if (url.pathname === '/dashboard') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(DASHBOARD)
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  browserServer = await chromium.launchServer({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {}),
  })
  remoteBrowser = browserServer.wsEndpoint()
  org = await payload.create({
    collection: 'organizations',
    data: { name: 'Browser Script Org', slug: `browser-script-${run}` },
  })
}, 120_000)

afterEach(() => {
  clearHeartbeatListeners()
  setGuard(savedGuard)
})

afterAll(async () => {
  setGuard(savedGuard)
  await browserServer?.close().catch(() => undefined)
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  if (org?.id) {
    // Monitors take their heartbeats and artifacts (files included) with them.
    await payload.delete({
      collection: 'monitors',
      where: { organization: { equals: org.id } },
      overrideAccess: true,
    })
    await payload.delete({ collection: 'organizations', id: org.id, overrideAccess: true })
  }
})

describe('browser-script monitor', () => {
  it('validates the form: script and remote browser required, variable names', () => {
    const base = {
      name: 'Journey',
      type: 'browser-script' as const,
      interval: 60,
      retryInterval: 60,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 20,
    }
    const missing = monitorFormSchema.safeParse({ ...base, browserScript: '' })
    expect(missing.success).toBe(false)
    const paths = missing.error?.issues.map((issue) => issue.path.join('.')) ?? []
    expect(paths).toContain('browserScript')
    expect(paths).toContain('remoteBrowser')

    const badName = monitorFormSchema.safeParse({
      ...base,
      browserScript: 'await page.goto(url)',
      remoteBrowser: 'ws://browser:3000',
      browserSecrets: [
        { name: 'not valid', value: 'x' },
        { name: 'token', value: 'a' },
        { name: 'token', value: 'b' },
      ],
    })
    expect(badName.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'browserSecrets.0.name',
      'browserSecrets.2.name',
    ])

    const ok = monitorFormSchema.safeParse({
      ...base,
      browserScript: 'await page.goto(url)',
      remoteBrowser: 'ws://browser:3000',
    })
    expect(ok.success).toBe(true)
    expect(ok.data?.browserArtifacts).toBe('failure')
  })

  it('passes a scripted login journey with per-step timing', async () => {
    const monitor = await createMonitor()
    const beat = await check(monitor)
    expect(beat.msg).toBe('Passed (3 steps)')
    expect(beat.status).toBe('up')
    expect(beat.ping).toBeGreaterThan(0)

    const browser = parseBrowserDetails(beat.browser)
    expect(browser?.steps.map((step) => [step.name, step.error])).toEqual([
      ['open the login page', null],
      ['sign in', null],
      ['see the dashboard', null],
    ])
    for (const step of browser?.steps ?? []) expect(step.durationMs).toBeGreaterThanOrEqual(0)
    // The login page's console error and missing image are reported even on success.
    expect(browser?.consoleErrors).toContain('analytics failed to load')
    expect(browser?.failedRequests).toContainEqual({
      method: 'GET',
      url: `${baseUrl}/missing.png`,
      status: 404,
      error: null,
    })
    expect(browser?.finalUrl).toBe(`${baseUrl}/dashboard`)
    expect(browser?.webVitals?.ttfb).toEqual(expect.any(Number))
    // Artifacts are kept on failure only (the default).
    expect(await artifactsOf(beat)).toEqual([])
  }, 60_000)

  it('fails when the expected text changes and attaches a screenshot and a trace', async () => {
    const monitor = await createMonitor({ browserScript: JOURNEY('Welcome, Grace') })
    const beat = await check(monitor)
    expect(beat.status).toBe('down')
    expect(beat.msg).toContain('toHaveText failed')
    expect(beat.msg).toContain('Expected: "Welcome, Grace"')
    expect(beat.msg).toContain('Received: "Welcome, Ada"')

    const browser = parseBrowserDetails(beat.browser)
    expect(browser?.steps.at(-1)).toMatchObject({ name: 'see the dashboard' })
    expect(browser?.steps.at(-1)?.error).toContain('toHaveText failed')

    const artifacts = await artifactsOf(beat)
    expect(artifacts.map((doc) => doc.kind)).toEqual(['screenshot', 'trace'])
    for (const doc of artifacts) {
      expect(String(doc.monitor)).toBe(String(monitor.id))
      expect(String(doc.organization)).toBe(String(org.id))
    }
    const [screenshot, trace] = await Promise.all(artifacts.map(artifactFile))
    expect([...screenshot!.subarray(0, 2)]).toEqual([0xff, 0xd8]) // JPEG
    expect(trace!.subarray(0, 2).toString()).toBe('PK') // zip
    // The heartbeat links both files.
    expect(browser?.artifacts?.map((ref) => ref.kind).sort()).toEqual(['screenshot', 'trace'])
    expect(browser?.artifacts?.every((ref) => ref.url.includes('/api/check-artifacts/file/'))).toBe(
      true,
    )
  }, 60_000)

  it('keeps the files away from people outside the organization', async () => {
    const monitor = await createMonitor({ browserScript: `throw new Error('boom')` })
    const beat = await check(monitor)
    const [screenshot] = await artifactsOf(beat)
    expect(screenshot).toBeDefined()
    const fetchFile = async (cookie?: string) => {
      const slug = ['check-artifacts', 'file', screenshot!.filename!]
      const request = new Request(`http://localhost/api/${slug.join('/')}`, {
        headers: { Origin: env.NEXT_PUBLIC_SERVER_URL, ...(cookie ? { cookie } : {}) },
      })
      return (await restGet(request, { params: Promise.resolve({ slug }) })).status
    }
    expect(await fetchFile()).toBeGreaterThanOrEqual(400)

    const login = async (name: string, member: boolean) => {
      const email = `${name}+bs-${run}@marmot.test`
      const user = await payload.create({
        collection: 'users',
        data: { email, password: 'password-123', name },
      })
      if (member) {
        await addOrgMembership({ payload, userId: user.id, orgId: org.id, role: 'viewer' })
      }
      const { token } = await payload.login({
        collection: 'users',
        data: { email, password: 'password-123' },
      })
      return { user, cookie: `payload-token=${token}` }
    }
    const outsider = await login('outsider', false)
    const viewer = await login('viewer', true)
    try {
      expect(await fetchFile(outsider.cookie)).toBeGreaterThanOrEqual(400)
      expect(await fetchFile(viewer.cookie)).toBe(200)
    } finally {
      for (const { user } of [outsider, viewer]) {
        await payload.delete({ collection: 'users', id: user.id, overrideAccess: true })
      }
    }
  }, 60_000)

  it('keeps secrets out of messages, logs and step names', async () => {
    const monitor = await createMonitor({
      browserScript: `
        console.log('typing ' + secrets.password)
        await test.step('use ' + secrets.password, async () => {})
        throw new Error('rejected ' + secrets.password)
      `,
    })
    const beat = await check(monitor)
    expect(beat.status).toBe('down')
    expect(beat.msg).toBe('rejected [redacted]')
    const serialized = JSON.stringify(beat.browser)
    expect(serialized).not.toContain('hunter22-secret')
    expect(serialized).toContain('typing [redacted]')
  }, 60_000)

  it('gives the script no way out of the sandbox', async () => {
    const monitor = await createMonitor({
      browserScript: `
        expect(typeof process).toBe('undefined')
        expect(typeof require).toBe('undefined')
        expect(typeof module).toBe('undefined')
        expect(typeof fetch).toBe('undefined')
        expect(typeof globalThis.constructor.constructor('return typeof process')()).toBe('string')
        expect(globalThis.constructor.constructor('return typeof process')()).toBe('undefined')
        expect(page.goto.constructor('return typeof require')()).toBe('undefined')
        let imported = 'no'
        try { await import('node:fs'); imported = 'yes' } catch (err) {}
        expect(imported).toBe('no')
        // Only the allow-listed API: nothing that reaches the worker's files or network.
        expect(typeof page.context).toBe('undefined')
        expect(typeof page.request).toBe('undefined')
        expect(typeof page.route).toBe('undefined')
        expect(typeof page.screenshot).toBe('undefined')
        expect(typeof page.getByLabel('x').setInputFiles).toBe('undefined')
        let opened = 'no'
        try { await page.goto('file:///etc/passwd'); opened = 'yes' } catch (err) {}
        expect(opened).toBe('no')
        expect(page.url()).not.toContain('file:')
      `,
    })
    const beat = await check(monitor)
    expect(beat.msg).toBe('Passed')
    expect(beat.status).toBe('up')
  }, 60_000)

  it('kills a script that never finishes at the timeout', async () => {
    const monitor = await createMonitor({
      timeout: 4,
      browserScript: `await page.goto('/login'); await page.waitForTimeout(600000)`,
    })
    const started = Date.now()
    const beat = await check(monitor)
    expect(Date.now() - started).toBeLessThan(6_000)
    expect(beat.status).toBe('down')
    expect(beat.msg).toMatch(/^Script timed out after \ds$/)
    // A timed-out check still leaves its screenshot behind.
    expect((await artifactsOf(beat)).map((doc) => doc.kind)).toContain('screenshot')
  }, 60_000)

  it('kills a busy loop', async () => {
    const monitor = await createMonitor({ timeout: 10, browserScript: `while (true) {}` })
    const started = Date.now()
    const beat = await check(monitor)
    expect(Date.now() - started).toBeLessThan(8_000)
    expect(beat.status).toBe('down')
    expect(beat.msg).toContain('without awaiting the browser')
  }, 60_000)

  it('applies the outbound address guard to navigation and every request', async () => {
    // Saved before the guard is configured (it refuses literal denied targets on save).
    const blocked = await createMonitor({ browserScript: `await page.goto('/login')` })
    const sub = await createMonitor({
      browserScript: `
        await page.goto('/login')
        const status = await page.evaluate(() =>
          fetch('http://127.0.0.2:9/secret').then((r) => r.status, () => 'refused'))
        expect(status).toBe('refused')
      `,
    })

    setGuard({ MONITOR_DENY_CIDRS: '127.0.0.0/8' })
    const beat = await check(blocked)
    expect(beat.status).toBe('down')
    expect(beat.msg).toBe('Blocked: 127.0.0.1 resolves to a denied address (MONITOR_DENY_CIDRS)')

    // Allowed page, denied fetch: refused by the browser context's route.
    setGuard({ MONITOR_DENY_CIDRS: '127.0.0.2/32' })
    const subBeat = await check(sub)
    expect(subBeat.msg).toBe('Passed')
    expect(parseBrowserDetails(subBeat.browser)?.failedRequests).toContainEqual(
      expect.objectContaining({
        url: 'http://127.0.0.2:9/secret',
        error: 'Blocked: 127.0.0.2 resolves to a denied address (MONITOR_DENY_CIDRS)',
      }),
    )

    // While private addresses are denied the type is refused, like the Browser Engine monitor.
    setGuard({ MONITOR_DENY_PRIVATE_ADDRESSES: 'true' })
    const refused = await check(blocked)
    expect(refused.msg).toBe(
      'Blocked: The Browser Script monitor is not allowed on this instance (MONITOR_DENY_PRIVATE_ADDRESSES)',
    )
  }, 60_000)

  it('returns the screenshot inline from "Run now" and stores nothing', async () => {
    const parsed = monitorFormSchema.parse({
      name: 'Unsaved journey',
      type: 'browser-script',
      url: baseUrl,
      remoteBrowser,
      browserScript: JOURNEY('Welcome, Grace'),
      browserVariables: [{ name: 'email', value: 'ada@example.com' }],
      browserSecrets: [{ name: 'password', value: 'hunter22-secret' }],
      interval: 60,
      retryInterval: 60,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 20,
    })
    const before = await payload.count({ collection: 'check-artifacts', overrideAccess: true })
    const result = await processAdhocCheckJob(payload, {
      monitor: parsed,
      organizationId: org.id,
      deadline: Date.now() + 60_000,
    } as never)
    expect(result.status).toBe('down')
    expect(result.browser?.steps).toHaveLength(3)
    expect(result.browser?.screenshotDataUrl).toMatch(/^data:image\/jpeg;base64,/)
    expect(result.browser?.artifacts).toBeUndefined()
    const after = await payload.count({ collection: 'check-artifacts', overrideAccess: true })
    expect(after.totalDocs).toBe(before.totalDocs)
  }, 60_000)

  it('removes old artifacts with the important-heartbeat retention and with the monitor', async () => {
    const monitor = await createMonitor({ browserScript: `throw new Error('boom')` })
    const beat = await check(monitor)
    const docs = await artifactsOf(beat)
    expect(docs).toHaveLength(2)
    const files = docs.map((doc) =>
      path.join(env.UPLOADS_DIR, 'check-artifacts', doc.filename ?? ''),
    )

    // Not yet expired.
    await runRetention(payload, new Date(), { keepDataPeriodDays: 180 })
    expect(await artifactsOf(beat)).toHaveLength(2)
    // Stored 200 days ago they are, files included.
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString()
    for (const doc of docs) {
      await payload.db.updateOne({
        collection: 'check-artifacts',
        id: doc.id,
        data: { createdAt: old },
      })
    }
    const result = await runRetention(payload, new Date(), { keepDataPeriodDays: 180 })
    expect(result.checkArtifacts).toBeGreaterThanOrEqual(2)
    expect(await artifactsOf(beat)).toEqual([])
    for (const file of files) await expect(readFile(file)).rejects.toThrow(/ENOENT/)

    // Deleting the monitor takes its artifacts along.
    const beat2 = await check(monitor)
    expect(await artifactsOf(beat2)).toHaveLength(2)
    await payload.delete({ collection: 'monitors', id: monitor.id, overrideAccess: true })
    expect(await artifactsOf(beat2)).toEqual([])
  }, 60_000)
})
