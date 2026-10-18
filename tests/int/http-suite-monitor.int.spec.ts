/**
 * Multi-step API checks (#138) through the real check path and the import/export paths: a local
 * API answers a login → profile → logout suite, the worker stores per-step results on the heartbeat
 * with every secret redacted, and suites survive a Marmot export/import and a monitors-as-code
 * export/apply round trip unchanged. No request leaves the process.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { addOrgMembership } from '@/access/memberships'
import type { MonitorDoc } from '@/cli/core/client'
import { exportMonitors, toYaml } from '@/cli/core/export'
import { planMonitors } from '@/cli/core/plan'
import { parseSpecText, readSpecDocument } from '@/cli/core/spec'
import config from '@payload-config'
import { parseSuiteStepResults } from '@/lib/validation/http-suite'
import { monitorToFormValues } from '@/lib/validation/monitor'
import type { Heartbeat, Monitor, Organization, User } from '@/payload-types'
import { clearHeartbeatListeners, processCheckJob, type ChecksQueue } from '@/server/engine'
import { applyImportPlan } from '@/server/import-export/apply'
import { buildMarmotExport, parseMarmotExport } from '@/server/import-export/marmot'
import type { RequestUser } from '@/server/monitors/http'

let payload: Payload
let orgA: Organization
let orgB: Organization
let owner: RequestUser
const run = Date.now().toString(36)

const PASSWORD = `pw-${run}-correct-horse`
const TOKEN = `tok-${run}-battery-staple`

let server: http.Server
let base: string
const calls: string[] = []
let acceptToken = true

const fakeQueue = () =>
  ({
    upsertJobScheduler: vi.fn(async () => undefined),
    removeJobScheduler: vi.fn(async () => true),
  }) as unknown as ChecksQueue

/** The suite as a monitors-as-code file would write it (maps), see `src/lib/validation/http-suite.ts`. */
const suiteInput = () => ({
  vars: { base },
  secrets: { password: PASSWORD },
  steps: [
    {
      key: 'login',
      name: 'log in',
      method: 'POST',
      url: '{{ vars.base }}/login',
      body: '{"password": "{{ secrets.password }}"}',
      store: { token: { from: '$.data.token', secret: true } },
    },
    {
      key: 'profile',
      name: 'get profile',
      url: '{{ vars.base }}/me',
      headers: { Authorization: 'Bearer {{ steps.login.token }}' },
      assertions: [{ kind: 'jsonBody', target: '$.name', comparator: 'eq', value: 'Monitor' }],
    },
    {
      key: 'logout',
      name: 'log out',
      method: 'POST',
      url: '{{ vars.base }}/logout',
      headers: { Authorization: 'Bearer {{ vars.token }}' },
      alwaysRun: true,
    },
  ],
})

async function createSuite(org: Organization, name: string, httpSuite: unknown): Promise<Monitor> {
  return (await payload.create({
    collection: 'monitors',
    overrideAccess: true,
    depth: 0,
    context: { skipEngineSync: true },
    data: {
      organization: org.id,
      name,
      type: 'http-suite',
      httpSuite,
      interval: 60,
      retryInterval: 60,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 10,
      // As the API saves it (form values): the collection default only applies to SNMP.
      snmpCommunity: null,
      dnsResolveServer: null,
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

beforeAll(async () => {
  payload = await getPayload({ config })
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
    req.on('end', () => {
      calls.push(`${req.method} ${req.url}`)
      const json = (status: number, value: unknown) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
      if (req.url === '/login') {
        const { password } = JSON.parse(body || '{}') as { password?: string }
        return password === PASSWORD
          ? json(200, { data: { token: acceptToken ? TOKEN : `${TOKEN}-stale` } })
          : json(401, { error: 'bad password' })
      }
      if (req.url === '/me') {
        // Echo the credential back, as some APIs do in their errors.
        return req.headers.authorization === `Bearer ${TOKEN}`
          ? json(200, { name: 'Monitor' })
          : json(401, { error: 'invalid token', got: req.headers.authorization })
      }
      if (req.url === '/logout') return json(200, { ok: true })
      return json(404, {})
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  orgA = await payload.create({
    collection: 'organizations',
    data: { name: 'Suite Org', slug: `suite-a-${run}` },
  })
  orgB = await payload.create({
    collection: 'organizations',
    data: { name: 'Suite Import Org', slug: `suite-b-${run}` },
  })
  const user = await payload.create({
    collection: 'users',
    data: { email: `suite-${run}@marmot.test`, password: 'password-123', name: 'Owner' },
  })
  await addOrgMembership({ payload, userId: user.id, orgId: orgA.id, role: 'owner' })
  await addOrgMembership({ payload, userId: user.id, orgId: orgB.id, role: 'owner' })
  const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
  owner = { ...(fresh as User), collection: 'users' }
})

afterAll(async () => {
  clearHeartbeatListeners()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('http-suite monitors', () => {
  it('refuses a suite that uses a value no earlier step stores', async () => {
    const error = await createSuite(orgA, `Broken ${run}`, {
      steps: [{ key: 'a', url: 'https://api.test/{{ steps.b.id }}' }],
    }).catch((err: unknown) => err as { data?: { errors?: { path: string; message: string }[] } })
    expect(error).toMatchObject({
      data: {
        errors: [
          {
            path: 'httpSuite',
            message: expect.stringMatching(/^steps\.0\.url: steps\.b\.id is not defined/),
          },
        ],
      },
    })
  })

  it('records an UP beat with per-step results and nothing secret', async () => {
    acceptToken = true
    calls.length = 0
    const monitor = await createSuite(orgA, `Login flow ${run}`, suiteInput())
    const beat = await check(monitor)
    expect(beat.status).toBe('up')
    expect(beat.msg).toBe('3 steps passed')
    expect(calls).toEqual(['POST /login', 'GET /me', 'POST /logout'])
    const steps = parseSuiteStepResults(beat.steps)
    expect(steps.map((s) => [s.name, s.outcome, s.statusCode])).toEqual([
      ['log in', 'passed', 200],
      ['get profile', 'passed', 200],
      ['log out', 'passed', 200],
    ])

    const stored = await payload.findByID({ collection: 'heartbeats', id: beat.id, depth: 0 })
    const text = JSON.stringify(stored)
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(PASSWORD)
  })

  it('goes DOWN at the failing step, runs the cleanup and keeps the token out of the log', async () => {
    acceptToken = false
    calls.length = 0
    const monitor = await createSuite(orgA, `Stale token ${run}`, suiteInput())
    const beat = await check(monitor)
    expect(beat.status).toBe('down')
    expect(beat.msg).toBe('step 2 "get profile": status 401')
    expect(calls).toEqual(['POST /login', 'GET /me', 'POST /logout'])
    expect(parseSuiteStepResults(beat.steps).map((s) => s.outcome)).toEqual([
      'passed',
      'failed',
      'passed',
    ])
    expect(beat.statusCode).toBe(401)

    const stored = await payload.findByID({ collection: 'heartbeats', id: beat.id, depth: 0 })
    // The failed beat keeps the body, which echoed the (stale) token: redacted.
    expect(stored.response?.body).toContain('[redacted]')
    const text = JSON.stringify(stored)
    expect(text).not.toContain(`${TOKEN}-stale`)
    expect(text).not.toContain(PASSWORD)
    const reloaded = await payload.findByID({ collection: 'monitors', id: monitor.id, depth: 0 })
    expect(JSON.stringify(reloaded.status)).not.toContain(TOKEN)
  })

  it('round-trips through a Marmot export and import', async () => {
    const monitor = await createSuite(orgA, `Exported ${run}`, suiteInput())
    const exported = await buildMarmotExport(payload, { orgId: orgA.id, user: owner })
    const row = exported.monitors.find((m) => m.name === `Exported ${run}`)
    expect(row?.httpSuite).toEqual(monitorToFormValues(monitor).httpSuite)

    const report = await applyImportPlan(payload, {
      orgId: orgB.id,
      user: owner,
      plan: parseMarmotExport({ ...exported, monitors: [row], statusPages: [], templates: [] }),
      dryRun: false,
    })
    expect(report.monitors.skipped).toEqual([])
    expect(report.monitors.created).toHaveLength(1)
    const imported = (await payload.findByID({
      collection: 'monitors',
      id: report.monitors.created![0]!,
      depth: 0,
      overrideAccess: true,
    })) as Monitor
    expect(imported.type).toBe('http-suite')
    expect(imported.httpSuite).toEqual(monitor.httpSuite)
  })

  it('round-trips through monitors-as-code: export, re-read and plan is a no-op', async () => {
    const monitor = await createSuite(orgA, `As code ${run}`, suiteInput())
    const doc = { ...monitor, key: `suite-${run}` } as unknown as MonitorDoc
    const state = { monitors: [doc], notifications: [], tags: [] }

    // Plain export (secrets in the file) re-reads to the same configuration.
    const { document } = exportMonitors(state)
    const reread = readSpecDocument(parseSpecText(toYaml(document))).document
    const plan = planMonitors(reread, state).plan
    expect(plan.summary).toMatchObject({ create: 0, update: 0, unchanged: 1 })

    // A redacted export references the secret and still applies cleanly with it set.
    const redacted = exportMonitors(state, { redactSecrets: true })
    const yaml = toYaml(redacted.document)
    expect(yaml).not.toContain(PASSWORD)
    const variable = `MARMOT_SUITE_${run.toUpperCase()}_HTTP_SUITE_SECRET_PASSWORD`
    expect(redacted.secretVariables).toContain(variable)
    // Header values that are only placeholders hold no secret and stay in the file.
    expect(yaml).toContain('Bearer {{ steps.login.token }}')
    const env = Object.fromEntries(
      redacted.secretVariables.map((name) => [name, name === variable ? PASSWORD : 'public']),
    )
    const fromEnv = readSpecDocument(parseSpecText(yaml), env).document
    expect(planMonitors(fromEnv, state).plan.summary).toMatchObject({ update: 0, unchanged: 1 })

    // A file written by hand with maps creates the same suite, and a changed step is an update
    // whose values are masked in the plan output.
    const handWritten = readSpecDocument({
      monitors: [
        {
          key: `suite-${run}`,
          name: `As code ${run}`,
          type: 'http-suite',
          timeout: 10,
          httpSuite: suiteInput(),
        },
      ],
    }).document
    const handPlan = planMonitors(handWritten, state).plan
    expect(handPlan.changes[0]?.fields.map((f) => [f.field, f.before, f.after])).toEqual([])
    expect(handPlan.summary).toMatchObject({ unchanged: 1 })
    const changed = suiteInput()
    changed.steps[1]!.url = '{{ vars.base }}/profile'
    const update = planMonitors(
      readSpecDocument({
        monitors: [
          {
            key: `suite-${run}`,
            name: `As code ${run}`,
            type: 'http-suite',
            timeout: 10,
            httpSuite: changed,
          },
        ],
      }).document,
      state,
    ).plan
    expect(update.changes[0]?.action).toBe('update')
    expect(update.changes[0]?.fields).toEqual([
      expect.objectContaining({ field: 'httpSuite', secret: true }),
    ])
  })
})
