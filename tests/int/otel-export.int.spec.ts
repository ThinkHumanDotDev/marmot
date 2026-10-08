import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import type { Role } from '@/access/permissions'
import { GET as listRoute, POST as createRoute } from '@/app/api/orgs/[orgId]/otel-collectors/route'
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as patchRoute,
} from '@/app/api/orgs/[orgId]/otel-collectors/[id]/route'
import { POST as testRoute } from '@/app/api/orgs/[orgId]/otel-collectors/[id]/test/route'
import { env, resetEnvCache } from '@/env'
import { OTEL_METRICS, type OtelCollectorRow } from '@/lib/otel'
import type { Heartbeat, Monitor, Organization, OtelCollector, User } from '@/payload-types'
import { emitHeartbeat, type HeartbeatEvent } from '@/server/engine/hooks'
import type { OtlpMetric, OtlpMetricsRequest } from '@/server/otel/encode'
import {
  closeOtelExports,
  exportHeartbeat,
  flushOtelExports,
  registerOtelListener,
  unregisterOtelListener,
} from '@/server/otel/listener'
import { invalidateOtelCollectors } from '@/server/otel/resolve'

/**
 * OpenTelemetry metrics export (#99) against a local mock OTLP/HTTP collector: collector RBAC and
 * write-only sealed headers, audit redaction, default-collector inheritance, the exported metrics,
 * batching through one reused exporter, failure bookkeeping and the test route.
 */

let payload: Payload
const run = Date.now().toString(36)
const email = (name: string) => `${name}+otelint-${run}@marmot.test`
const PASSWORD = 'password-123'
const TOKEN = `glc_secret_${run}`

type Session = { user: User; cookie: string }
type Id = string | number

async function createMember(name: string, org: Organization, role: Role): Promise<Session> {
  const user = await payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name },
  })
  await addOrgMembership({ payload, userId: user.id, orgId: org.id, role })
  const { token } = await payload.login({
    collection: 'users',
    data: { email: email(name), password: PASSWORD },
  })
  return { user, cookie: `payload-token=${token}` }
}

/** The session's user with its current memberships, for Local API calls as that user. */
async function asUser(session: Session) {
  const user = await payload.findByID({ collection: 'users', id: session.user.id, depth: 0 })
  return { ...user, collection: 'users' as const }
}

/** A route's string id as the adapter's id type (numbers on Postgres). */
const docId = (id: string): Id => (payload.db.defaultIDType === 'number' ? Number(id) : id)

function request(
  url: string,
  init: { method?: string; body?: unknown; session?: Session } = {},
): Request {
  return new Request(url, {
    method: init.method ?? 'GET',
    headers: {
      Origin: env.NEXT_PUBLIC_SERVER_URL,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.session ? { cookie: init.session.cookie } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
}

const BASE = 'http://localhost:3000/api/orgs'
const orgParams = (orgId: Id) => ({ params: Promise.resolve({ orgId: String(orgId) }) })
const idParams = (orgId: Id, id: Id) => ({
  params: Promise.resolve({ orgId: String(orgId), id: String(id) }),
})

// ---------------------------------------------------------------------------------------------
// Mock OTLP/HTTP collector: `/v1/metrics` and `/otlp/v1/metrics` accept, `/reject` answers 400,
// `/flaky` answers 503 once, then 200.

interface Export {
  path: string
  headers: http.IncomingHttpHeaders
  body: OtlpMetricsRequest
}

let server: http.Server
let collectorUrl: string
const exports: Export[] = []
let flakyCalls = 0

const exportsAt = (path: string) => exports.filter((e) => e.path === path)

const metricsOf = (body: OtlpMetricsRequest): OtlpMetric[] =>
  body.resourceMetrics.flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics))

const attr = (attributes: { key: string; value: object }[], key: string) => {
  const value = attributes.find((a) => a.key === key)?.value
  return value ? Object.values(value)[0] : undefined
}

let orgA: Organization
let orgB: Organization
let admin: Session
let member: Session
let viewer: Session
let outsider: Session

async function createCollector(
  session: Session,
  body: Record<string, unknown>,
  org: Organization = orgA,
) {
  const response = await createRoute(
    request(`${BASE}/${org.id}/otel-collectors`, { method: 'POST', body, session }),
    orgParams(org.id),
  )
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

async function createMonitor(
  data: Partial<RequiredDataFromCollectionSlug<'monitors'>>,
  org: Organization = orgA,
): Promise<Monitor> {
  return (await payload.create({
    collection: 'monitors',
    data: {
      organization: org.id,
      name: 'Checkout API',
      type: 'http',
      url: 'https://shop.example.com/health?key=hidden',
      interval: 60,
      active: false,
      ...data,
    } as RequiredDataFromCollectionSlug<'monitors'>,
    depth: 0,
    overrideAccess: true,
    context: { skipEngineSync: true },
  })) as Monitor
}

let beatTime = Date.now() - 60_000

function beat(
  monitor: Monitor,
  status: Heartbeat['status'],
  extra: Partial<Heartbeat> = {},
  event: Partial<HeartbeatEvent> = {},
): HeartbeatEvent {
  beatTime += 1_000
  return {
    payload,
    monitor,
    heartbeat: {
      id: 0,
      monitor: monitor.id,
      status,
      msg: '',
      ping: status === 'up' ? 42 : null,
      time: new Date(beatTime).toISOString(),
      updatedAt: new Date(beatTime).toISOString(),
      createdAt: new Date(beatTime).toISOString(),
      ...extra,
    } as Heartbeat,
    isFirstBeat: false,
    notify: false,
    organizationId: orgA.id,
    ...event,
  }
}

describe('OpenTelemetry metrics export', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const path = req.url ?? '/'
        const raw = Buffer.concat(chunks).toString('utf8')
        let body: OtlpMetricsRequest = { resourceMetrics: [] }
        try {
          body = JSON.parse(raw) as OtlpMetricsRequest
        } catch {
          // recorded as empty
        }
        exports.push({ path, headers: req.headers, body })
        if (path === '/reject') {
          res.writeHead(400, { 'content-type': 'application/json' }).end('{"message":"bad"}')
        } else if (path === '/flaky' && flakyCalls++ === 0) {
          res.writeHead(503, { 'retry-after': '0' }).end('busy')
        } else {
          res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    collectorUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    orgA = await payload.create({
      collection: 'organizations',
      data: { name: 'Otel A', slug: `otel-a-${run}` },
    })
    orgB = await payload.create({
      collection: 'organizations',
      data: { name: 'Otel B', slug: `otel-b-${run}` },
    })
    admin = await createMember('admin', orgA, 'admin')
    member = await createMember('member', orgA, 'member')
    viewer = await createMember('viewer', orgA, 'viewer')
    outsider = await createMember('outsider', orgB, 'owner')
  })

  afterEach(async () => {
    await closeOtelExports()
    invalidateOtelCollectors()
    exports.length = 0
  })

  afterAll(async () => {
    unregisterOtelListener()
    delete process.env.MONITOR_DENY_PRIVATE_ADDRESSES
    delete process.env.OTLP_EXPORT_ENABLED
    resetEnvCache()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const orgIds = [orgA?.id, orgB?.id].filter(Boolean)
    if (orgIds.length) {
      await payload.delete({ collection: 'monitors', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
      const left = await payload.count({
        collection: 'otel-collectors',
        where: { organization: { in: orgIds } },
        overrideAccess: true,
      })
      expect(left.totalDocs).toBe(0)
    }
    await payload.delete({ collection: 'users', where: { email: { like: `+otelint-${run}@` } } })
  })

  describe('collectors', () => {
    let collectorId: string

    it('lets admins create a collector whose header values are sealed and write-only', async () => {
      const created = await createCollector(admin, {
        name: 'Grafana Cloud',
        endpoint: `${collectorUrl}/otlp/v1/metrics`,
        headers: [
          { name: 'Authorization', value: `Bearer ${TOKEN}` },
          { name: 'X-Scope-OrgID', value: 'tenant-1' },
        ],
        default: true,
      })
      expect(created.status).toBe(201)
      const doc = created.json.doc as OtelCollectorRow
      expect(doc.headerNames).toEqual(['Authorization', 'X-Scope-OrgID'])
      expect(doc.default).toBe(true)
      expect(JSON.stringify(created.json)).not.toContain(TOKEN)
      collectorId = doc.id

      // At rest the value is sealed, not plaintext.
      const stored = (await payload.findByID({
        collection: 'otel-collectors',
        id: doc.id,
        overrideAccess: true,
        depth: 0,
      })) as OtelCollector
      expect(stored.headers).toMatch(/^v1\./)
      expect(stored.headers).not.toContain(TOKEN)

      // Members read collectors (to pick one) but never the headers.
      const listed = await listRoute(
        request(`${BASE}/${orgA.id}/otel-collectors`, { session: member }),
        orgParams(orgA.id),
      )
      expect(listed.status).toBe(200)
      const text = await listed.text()
      expect(text).toContain('Grafana Cloud')
      expect(text).not.toContain(TOKEN)
      const asMember = await payload.findByID({
        collection: 'otel-collectors',
        id: doc.id,
        user: await asUser(member),
        overrideAccess: false,
      })
      expect(asMember).not.toHaveProperty('headers')
    })

    it('redacts the headers in the audit log', async () => {
      const { docs } = await payload.find({
        collection: 'audit-logs',
        where: {
          and: [
            { entityType: { equals: 'otel_collector' } },
            { entityId: { equals: collectorId } },
          ],
        },
        overrideAccess: true,
        depth: 0,
      })
      expect(docs.map((d) => d.action)).toContain('otel_collector.created')
      const text = JSON.stringify(docs)
      expect(text).not.toContain(TOKEN)
      expect(text).not.toMatch(/"headers":"v1\./)
    })

    it('refuses members, viewers and other organizations', async () => {
      for (const session of [member, viewer]) {
        const created = await createCollector(session, {
          name: 'Nope',
          endpoint: `${collectorUrl}/v1/metrics`,
        })
        expect(created.status).toBe(403)
      }
      const viewerList = await listRoute(
        request(`${BASE}/${orgA.id}/otel-collectors`, { session: viewer }),
        orgParams(orgA.id),
      )
      expect(viewerList.status).toBe(403)
      const foreign = await getRoute(
        request(`${BASE}/${orgB.id}/otel-collectors/${collectorId}`, { session: outsider }),
        idParams(orgB.id, collectorId),
      )
      expect(foreign.status).toBe(404)
      const patched = await patchRoute(
        request(`${BASE}/${orgA.id}/otel-collectors/${collectorId}`, {
          method: 'PATCH',
          body: { name: 'Hijacked' },
          session: outsider,
        }),
        idParams(orgA.id, collectorId),
      )
      expect(patched.status).toBe(403)
    })

    it('validates endpoints and headers', async () => {
      const credentials = await createCollector(admin, {
        name: 'Bad',
        endpoint: 'https://user:pass@otlp.example.com/v1/metrics',
      })
      expect(credentials.status).toBe(400)
      const scheme = await createCollector(admin, { name: 'Bad', endpoint: 'ftp://x/v1/metrics' })
      expect(scheme.status).toBe(400)
      const reserved = await createCollector(admin, {
        name: 'Bad',
        endpoint: `${collectorUrl}/v1/metrics`,
        headers: [{ name: 'Content-Type', value: 'text/plain' }],
      })
      expect(reserved.status).toBe(400)

      // With the outbound guard on, a literal private address is refused at save time.
      process.env.MONITOR_DENY_PRIVATE_ADDRESSES = 'true'
      resetEnvCache()
      try {
        const blocked = await createCollector(admin, {
          name: 'Internal',
          endpoint: `${collectorUrl}/v1/metrics`,
        })
        expect(blocked.status).toBe(400)
        expect(String(blocked.json.error)).toMatch(/not allowed/)
      } finally {
        delete process.env.MONITOR_DENY_PRIVATE_ADDRESSES
        resetEnvCache()
      }
    })

    it('keeps stored header values unless replaced', async () => {
      const response = await patchRoute(
        request(`${BASE}/${orgA.id}/otel-collectors/${collectorId}`, {
          method: 'PATCH',
          body: {
            headers: [
              { name: 'Authorization', value: null },
              { name: 'X-Extra', value: 'yes' },
            ],
          },
          session: admin,
        }),
        idParams(orgA.id, collectorId),
      )
      expect(response.status).toBe(200)
      const { doc } = (await response.json()) as { doc: OtelCollectorRow }
      expect(doc.headerNames).toEqual(['Authorization', 'X-Extra'])

      const tested = await testRoute(
        request(`${BASE}/${orgA.id}/otel-collectors/${collectorId}/test`, {
          method: 'POST',
          session: admin,
        }),
        idParams(orgA.id, collectorId),
      )
      expect(await tested.json()).toMatchObject({ ok: true, status: 200 })
      const [sent] = exportsAt('/otlp/v1/metrics')
      expect(sent.headers.authorization).toBe(`Bearer ${TOKEN}`)
      expect(sent.headers['x-extra']).toBe('yes')
      expect(sent.headers['x-scope-orgid']).toBeUndefined()
      expect(metricsOf(sent.body).map((m) => m.name)).toEqual(['marmot.collector.test'])
    })

    it('refuses a collector of another organization on a monitor', async () => {
      const foreign = await createCollector(
        outsider,
        { name: 'B collector', endpoint: `${collectorUrl}/v1/metrics` },
        orgB,
      )
      expect(foreign.status).toBe(201)
      await expect(
        createMonitor({ otlpCollector: docId((foreign.json.doc as OtelCollectorRow).id) as never }),
      ).rejects.toThrow()
    })
  })

  describe('export', () => {
    it('pushes the documented metrics of each check to the default collector', async () => {
      const monitor = await createMonitor({ name: 'Checkout API' })
      const timing = { dns: 2, connect: 5, tls: 11, ttfb: 30, transfer: 1 }
      expect(await exportHeartbeat(payload, beat(monitor, 'up', { timing, statusCode: 200 }))).toBe(
        true,
      )
      expect(await exportHeartbeat(payload, beat(monitor, 'down', { statusCode: 503 }))).toBe(true)
      expect(await exportHeartbeat(payload, beat(monitor, 'down', { statusCode: 503 }))).toBe(true)
      // Batched: nothing is sent before the interval or a flush.
      expect(exportsAt('/otlp/v1/metrics')).toHaveLength(0)
      await flushOtelExports()

      const sent = exportsAt('/otlp/v1/metrics')
      expect(sent).toHaveLength(1)
      expect(sent[0].headers['content-type']).toBe('application/json')
      expect(sent[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
      const resource = sent[0].body.resourceMetrics[0].resource.attributes
      expect(attr(resource, 'service.name')).toBe('marmot-synthetic-check')
      expect(attr(resource, 'marmot.organization.id')).toBe(String(orgA.id))
      expect(attr(resource, 'service.instance.id')).toBeTruthy()

      const metrics = metricsOf(sent[0].body)
      const byName = (name: string) => metrics.find((m) => m.name === name)!

      const duration = byName(OTEL_METRICS.duration).gauge!.dataPoints
      expect(duration).toHaveLength(1)
      expect(duration[0].asDouble).toBe(42)
      expect(attr(duration[0].attributes, 'marmot.monitor.id')).toBe(String(monitor.id))
      expect(attr(duration[0].attributes, 'marmot.monitor.name')).toBe('Checkout API')
      expect(attr(duration[0].attributes, 'marmot.monitor.type')).toBe('http')
      expect(attr(duration[0].attributes, 'marmot.monitor.target')).toBe(
        'https://shop.example.com/health',
      )
      expect(attr(duration[0].attributes, 'marmot.location')).toBe('local')
      expect(attr(duration[0].attributes, 'http.response.status_code')).toBe('200')

      const phases = byName(OTEL_METRICS.phaseDuration).gauge!.dataPoints
      expect(
        Object.fromEntries(
          phases.map((p) => [attr(p.attributes, 'marmot.check.phase'), p.asDouble]),
        ),
      ).toEqual(timing)

      expect(byName(OTEL_METRICS.status).gauge!.dataPoints.map((p) => p.asDouble)).toEqual([
        1, 0, 0,
      ])
      const errors = byName(OTEL_METRICS.errors).sum!
      expect(errors.isMonotonic).toBe(true)
      expect(errors.dataPoints.map((p) => p.asInt)).toEqual(['0', '1', '2'])
      expect(new Set(errors.dataPoints.map((p) => p.startTimeUnixNano)).size).toBe(1)

      // The outcome is recorded on the collector.
      const { docs } = await payload.find({
        collection: 'otel-collectors',
        where: { organization: { equals: orgA.id }, default: { equals: true } },
        overrideAccess: true,
        depth: 0,
      })
      expect(docs[0].lastExportAt).toBeTruthy()
      expect(docs[0].lastError ?? null).toBeNull()
    })

    it('reports packet loss for ping monitors and skips beats that ran no check', async () => {
      const monitor = await createMonitor({
        name: 'Router',
        type: 'ping',
        url: null,
        hostname: '10.1.1.1',
      })
      await exportHeartbeat(payload, beat(monitor, 'down'))
      expect(await exportHeartbeat(payload, beat(monitor, 'maintenance'))).toBe(false)
      expect(
        await exportHeartbeat(payload, beat(monitor, 'pending', {}, { checkerOffline: true })),
      ).toBe(false)
      await flushOtelExports()
      const metrics = metricsOf(exportsAt('/otlp/v1/metrics')[0].body)
      const loss = metrics.find((m) => m.name === OTEL_METRICS.packetLoss)!
      expect(loss.gauge!.dataPoints.map((p) => p.asDouble)).toEqual([1])
      expect(attr(loss.gauge!.dataPoints[0].attributes, 'marmot.monitor.target')).toBe('10.1.1.1')
    })

    it('honours the opt-out, a monitor collector and the instance switch', async () => {
      const optedOut = await createMonitor({ name: 'Quiet', otlpExport: false })
      expect(await exportHeartbeat(payload, beat(optedOut, 'up'))).toBe(false)

      const own = await createCollector(admin, {
        name: 'Local collector',
        endpoint: collectorUrl, // base URL: /v1/metrics is appended
      })
      const ownId = (own.json.doc as OtelCollectorRow).id
      const routed = await createMonitor({ name: 'Routed', otlpCollector: docId(ownId) as never })
      expect(await exportHeartbeat(payload, beat(routed, 'up'))).toBe(true)
      await flushOtelExports()
      expect(exportsAt('/v1/metrics')).toHaveLength(1)
      expect(exportsAt('/otlp/v1/metrics')).toHaveLength(0)

      // An inactive collector receives nothing, and the monitor does not fall back to the default.
      await patchRoute(
        request(`${BASE}/${orgA.id}/otel-collectors/${ownId}`, {
          method: 'PATCH',
          body: { active: false },
          session: admin,
        }),
        idParams(orgA.id, ownId),
      )
      expect(await exportHeartbeat(payload, beat(routed, 'up'))).toBe(false)

      process.env.OTLP_EXPORT_ENABLED = 'false'
      resetEnvCache()
      try {
        const monitor = await createMonitor({ name: 'Switched off' })
        expect(await exportHeartbeat(payload, beat(monitor, 'up'))).toBe(false)
      } finally {
        delete process.env.OTLP_EXPORT_ENABLED
        resetEnvCache()
      }

      // Deleting a collector detaches its monitors (they use the default again).
      const deleted = await deleteRoute(
        request(`${BASE}/${orgA.id}/otel-collectors/${ownId}`, {
          method: 'DELETE',
          session: admin,
        }),
        idParams(orgA.id, ownId),
      )
      expect(deleted.status).toBe(200)
      const after = await payload.findByID({
        collection: 'monitors',
        id: routed.id,
        overrideAccess: true,
        depth: 0,
      })
      expect(after.otlpCollector ?? null).toBeNull()
    })

    it('runs through the heartbeat pipeline and never fails a check on export errors', async () => {
      registerOtelListener(payload)
      const rejecting = await createCollector(admin, {
        name: 'Rejecting',
        endpoint: `${collectorUrl}/reject`,
      })
      const rejectingId = (rejecting.json.doc as OtelCollectorRow).id
      const monitor = await createMonitor({
        name: 'Rejected',
        otlpCollector: docId(rejectingId) as never,
      })
      await emitHeartbeat(beat(monitor, 'up'))
      await flushOtelExports()
      expect(exportsAt('/reject')).toHaveLength(1) // 400 is not retried
      const stored = (await payload.findByID({
        collection: 'otel-collectors',
        id: rejectingId,
        overrideAccess: true,
        depth: 0,
      })) as OtelCollector
      expect(stored.lastError).toMatch(/HTTP 400/)

      const flaky = await createCollector(admin, {
        name: 'Flaky',
        endpoint: `${collectorUrl}/flaky`,
      })
      const flakyMonitor = await createMonitor({
        name: 'Flaky target',
        otlpCollector: docId((flaky.json.doc as OtelCollectorRow).id) as never,
      })
      await emitHeartbeat(beat(flakyMonitor, 'up'))
      await flushOtelExports()
      // 503 then 200: retried once, delivered once.
      expect(exportsAt('/flaky')).toHaveLength(2)
      expect(metricsOf(exportsAt('/flaky')[1].body).length).toBeGreaterThan(0)
    })
  })
})
