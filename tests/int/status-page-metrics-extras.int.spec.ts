/**
 * Custom metrics extras (#280): backfill into the hourly and daily rollups, the cross-process push
 * lock, threshold state, picking and ordering a page's metrics from the builder, and metrics in the
 * Marmot export and import.
 */
import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import { GET as exportRoute } from '@/app/api/orgs/[orgId]/export/route'
import { POST as importRoute } from '@/app/api/orgs/[orgId]/import/route'
import { POST as pushRoute } from '@/app/api/orgs/[orgId]/metrics/[id]/points/route'
import { POST as createMetricRoute } from '@/app/api/orgs/[orgId]/metrics/route'
import {
  GET as pageMetricsGet,
  PUT as pageMetricsPut,
} from '@/app/api/orgs/[orgId]/status-pages/[id]/metrics/route'
import { GET as publicMetricsRoute } from '@/app/api/status-pages/[slug]/metrics/route'
import { env } from '@/env'
import type { ImportReport } from '@/lib/import-export'
import { metricThresholdState, type MetricRow, type PublicMetric } from '@/lib/metrics'
import { defaultMonitorValues } from '@/lib/validation/monitor'
import type { Metric, Monitor, Organization, StatusPage, User } from '@/payload-types'
import { generateApiKey } from '@/server/api-keys'
import type { MarmotExport } from '@/server/import-export/marmot'
import {
  bucketPoints,
  granularitiesFor,
  maxPointAgeSeconds,
  pointProblem,
} from '@/server/metrics/ingest'
import { closeMetricLocks, withRedisMetricLock } from '@/server/metrics/lock'
import { orderForPage } from '@/server/metrics/public'
import { readMetricSeries } from '@/server/metrics/series'

let payload: Payload
const run = Date.now().toString(36)
const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const PASSWORD = 'password-123'

let org: Organization
let other: Organization
let target: Organization
let page: StatusPage
let secondPage: StatusPage
let monitor: Monitor
let readKey: string
let writeKey: string
let owner: { user: User; cookie: string }

async function mintKey(owner: Organization, scope: 'read' | 'write') {
  const generated = generateApiKey()
  await payload.create({
    collection: 'api-keys',
    overrideAccess: true,
    data: {
      organization: owner.id,
      name: `${scope}-${run}`,
      scope,
      keyHash: generated.keyHash,
      prefix: generated.prefix,
    },
  })
  return generated.key
}

function keyRequest(url: string, key: string, init: { method?: string; body?: unknown } = {}) {
  return new Request(url, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${key}`,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

/** Browser-like request: Payload only honours the cookie when `Origin` passes its CSRF allowlist. */
function sessionRequest(url: string, body: unknown, method = 'POST'): Request {
  return new Request(url, {
    method,
    headers: {
      Origin: env.NEXT_PUBLIC_SERVER_URL,
      cookie: owner.cookie,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

const orgUrl = (owner: Organization, rest: string) =>
  `http://localhost/api/orgs/${owner.id}/${rest}`

async function create(body: Record<string, unknown>): Promise<MetricRow> {
  const res = await createMetricRoute(
    keyRequest(orgUrl(org, 'metrics'), writeKey, { method: 'POST', body }),
    { params: Promise.resolve({ orgId: String(org.id) }) },
  )
  expect(res.status).toBe(201)
  return ((await res.json()) as { doc: MetricRow }).doc
}

const push = (metricId: string, body: unknown) =>
  pushRoute(
    keyRequest(orgUrl(org, `metrics/${metricId}/points`), writeKey, { method: 'POST', body }),
    { params: Promise.resolve({ orgId: String(org.id), id: metricId }) },
  )

async function publicMetrics(slug: string, query = '') {
  const res = await publicMetricsRoute(
    new Request(`http://localhost/api/status-pages/${slug}/metrics${query}`),
    { params: Promise.resolve({ slug }) },
  )
  return (await res.json()) as { metrics: PublicMetric[] }
}

const pageMetrics = (key: string, pageId: string | number, body?: unknown) => {
  const url = orgUrl(org, `status-pages/${pageId}/metrics`)
  const context = { params: Promise.resolve({ orgId: String(org.id), id: String(pageId) }) }
  return body === undefined
    ? pageMetricsGet(keyRequest(url, key), context)
    : pageMetricsPut(keyRequest(url, key, { method: 'PUT', body }), context)
}

const statsOf = (metricId: string) =>
  payload
    .find({
      collection: 'metric-stats',
      where: { metric: { equals: metricId } },
      sort: 'timestamp',
      limit: 50,
    })
    .then((result) => result.docs)

describe('custom metrics extras (#280)', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    const mkOrg = (name: string, slug: string) =>
      payload.create({
        collection: 'organizations',
        data: { name, slug: `${slug}-${run}` },
        overrideAccess: true,
      })
    org = await mkOrg('Extras Acme', 'extras-acme')
    other = await mkOrg('Extras Other', 'extras-other')
    target = await mkOrg('Extras Target', 'extras-target')
    readKey = await mintKey(org, 'read')
    writeKey = await mintKey(org, 'write')
    const mkPage = (organization: Organization, title: string, slug: string) =>
      payload.create({
        collection: 'status-pages',
        data: { organization: organization.id, title, slug: `${slug}-${run}`, published: true },
        depth: 0,
        overrideAccess: true,
      })
    page = await mkPage(org, 'Extras Status', 'extras')
    secondPage = await mkPage(org, 'Extras Second', 'extras-second')
    monitor = (await payload.create({
      collection: 'monitors',
      data: {
        ...defaultMonitorValues('http'),
        name: 'Extras source',
        url: 'https://extras.example.com/metrics',
        organization: org.id,
        active: false,
      } as never,
      depth: 0,
      overrideAccess: true,
    })) as Monitor

    const user = await payload.create({
      collection: 'users',
      data: { email: `owner+extras-${run}@marmot.test`, password: PASSWORD, name: 'Owner' },
    })
    for (const organization of [org, target]) {
      await addOrgMembership({ payload, userId: user.id, orgId: organization.id, role: 'owner' })
    }
    const { token } = await payload.login({
      collection: 'users',
      data: { email: `owner+extras-${run}@marmot.test`, password: PASSWORD },
    })
    owner = { user, cookie: `payload-token=${token}` }
  })

  afterAll(async () => {
    const orgs = [org?.id, other?.id, target?.id].filter((id) => id !== undefined)
    for (const collection of [
      'metrics',
      'incidents',
      'status-pages',
      'monitors',
      'notifications',
      'api-keys',
      'audit-logs',
    ] as const) {
      await payload.delete({
        collection,
        where: { organization: { in: orgs } },
        overrideAccess: true,
      })
    }
    await payload.delete({ collection: 'organizations', where: { id: { in: orgs } } })
    await payload.delete({
      collection: 'users',
      where: { email: { like: `+extras-${run}@marmot.test` } },
    })
    await closeMetricLocks()
  })

  describe('backfill', () => {
    it('routes old points to the rollups that still keep their time', () => {
      const now = new Date('2026-10-12T12:00:00Z')
      const at = (ms: number) => now.getTime() - ms
      expect(granularitiesFor(at(HOUR), now)).toEqual(['minute', 'hour', 'day'])
      expect(granularitiesFor(at(3 * DAY), now)).toEqual(['hour', 'day'])
      expect(granularitiesFor(at(40 * DAY), now)).toEqual(['day'])

      const buckets = bucketPoints(
        [
          { value: 1, at: at(HOUR) },
          { value: 2, at: at(3 * DAY) },
          { value: 3, at: at(40 * DAY) },
        ],
        now,
      )
      expect(buckets.minute.size).toBe(1)
      expect(buckets.hour.size).toBe(2)
      expect(buckets.day.size).toBe(3)

      // The data period bounds the age; without long-term retention a 10-year cap applies.
      expect(maxPointAgeSeconds(90)).toBe(90 * 86400)
      expect(maxPointAgeSeconds(0)).toBeGreaterThan(10 * 365 * 86400)
      expect(pointProblem(at(40 * DAY), now, maxPointAgeSeconds(90))).toBeNull()
      expect(pointProblem(at(100 * DAY), now, maxPointAgeSeconds(90))).toBe('metricPointTooOld')
      expect(pointProblem(at(2 * DAY), now)).toBe('metricPointTooOld')
    })

    it('accepts points older than 24 hours into the hourly and daily rollups only', async () => {
      const metric = await create({ name: 'Backfilled', visible: true })
      expect((await push(metric.id, { value: 7 })).status).toBe(202)
      const now = Date.now()
      const res = await push(metric.id, {
        points: [
          { value: 10, timestamp: new Date(now - 3 * DAY).toISOString() },
          { value: 20, timestamp: now - 3 * DAY },
          { value: 30, timestamp: Math.floor((now - 40 * DAY) / 1000) },
        ],
      })
      expect(res.status).toBe(202)
      expect(await res.json()).toEqual({ accepted: 3 })

      const rows = await statsOf(metric.id)
      const count = (granularity: string) =>
        rows.filter((r) => r.granularity === granularity).reduce((n, r) => n + r.count, 0)
      expect(count('minute')).toBe(1)
      expect(count('hour')).toBe(3)
      expect(count('day')).toBe(4)

      // A batch of old points leaves the latest value alone.
      const stored = (await payload.findByID({ collection: 'metrics', id: metric.id })) as Metric
      expect(stored.lastValue).toBe(7)

      // The weekly chart (hourly rollup) shows the backfilled interval.
      const week = await readMetricSeries(payload, stored, 'week')
      expect(week.series.map((p) => p.value)).toContain(15)
      expect(week.summary).toBeCloseTo(37 / 3)
    })
  })

  describe('cross-process push lock', () => {
    it('serialises holders of the same metric and frees the lock afterwards', async () => {
      const events: string[] = []
      const task = (name: string) => async () => {
        events.push(`${name}:start`)
        await new Promise((resolve) => setTimeout(resolve, 150))
        events.push(`${name}:end`)
        return name
      }
      // Straight to the Redis lock, as two processes would (no in-process queue in between).
      const results = await Promise.all([
        withRedisMetricLock(`test-${run}`, task('a')),
        withRedisMetricLock(`test-${run}`, task('b')),
      ])
      expect(results.sort()).toEqual(['a', 'b'])
      expect(events[1]).toBe(`${events[0].split(':')[0]}:end`)
      // Different metrics do not wait for each other.
      const parallel: string[] = []
      await Promise.all([
        withRedisMetricLock(`test-${run}-x`, async () => {
          parallel.push('x:start')
          await new Promise((resolve) => setTimeout(resolve, 100))
          parallel.push('x:end')
        }),
        withRedisMetricLock(`test-${run}-y`, async () => {
          parallel.push('y:start')
          await new Promise((resolve) => setTimeout(resolve, 100))
          parallel.push('y:end')
        }),
      ])
      expect(parallel.slice(0, 2).sort()).toEqual(['x:start', 'y:start'])
    })

    it('still pushes when Redis is unavailable', async () => {
      const broken = {
        set: async () => {
          throw new Error('connection refused')
        },
        eval: async () => 0,
        quit: async () => 'OK' as const,
      }
      const result = await withRedisMetricLock(`test-${run}-down`, async () => 'pushed', {
        client: broken as never,
      })
      expect(result).toBe('pushed')
    })

    it('keeps every point of concurrent pushes to one bucket', async () => {
      const metric = await create({ name: 'Concurrent', aggregation: 'sum' })
      const at = Date.now() - 60_000
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => push(metric.id, { value: 1, timestamp: at })),
      )
      expect(responses.map((r) => r.status)).toEqual(Array(8).fill(202))
      const rows = await statsOf(metric.id)
      for (const granularity of ['minute', 'hour', 'day']) {
        const row = rows.filter((r) => r.granularity === granularity)
        expect(row).toHaveLength(1)
        expect(row[0].count).toBe(8)
      }
    })
  })

  describe('threshold state', () => {
    it('reads a value against the thresholds in either direction', () => {
      const up = { warning: 5, critical: 10 }
      expect(metricThresholdState(1, up)).toBe('ok')
      expect(metricThresholdState(5, up)).toBe('warning')
      expect(metricThresholdState(12, up)).toBe('critical')
      // Critical below warning: lower is worse (a success rate).
      const down = { warning: 99, critical: 95 }
      expect(metricThresholdState(99.5, down)).toBe('ok')
      expect(metricThresholdState(97, down)).toBe('warning')
      expect(metricThresholdState(90, down)).toBe('critical')
      expect(metricThresholdState(3, { warning: null, critical: 2 })).toBe('critical')
      expect(metricThresholdState(null, up)).toBeNull()
      expect(metricThresholdState(3, { warning: null, critical: null })).toBeNull()
    })

    it('exposes the state of the headline value in the public JSON', async () => {
      const metric = await create({
        name: 'Error budget',
        thresholds: { warning: 5, critical: 10 },
        showThresholdState: true,
        visible: true,
        statusPages: [secondPage.id],
      })
      expect(metric.showThresholdState).toBe(true)
      expect((await push(metric.id, { value: 7 })).status).toBe(202)
      const { metrics } = await publicMetrics(secondPage.slug)
      expect(metrics.find((m) => m.id === metric.id)).toMatchObject({
        current: 7,
        state: 'warning',
        showThresholdState: true,
      })
    })
  })

  describe('status page builder', () => {
    it('orders metrics by the page, then by their own order', () => {
      const docs = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]
      expect(orderForPage(docs, [3, 1]).map((d) => d.id)).toEqual([3, 1, 2, 4])
      expect(orderForPage(docs, null).map((d) => d.id)).toEqual([1, 2, 3, 4])
    })

    it('picks and orders the metrics of a page', async () => {
      const first = await create({ name: 'First', visible: true, order: 1 })
      const second = await create({ name: 'Second', visible: true, order: 2 })
      const dropped = await create({ name: 'Dropped', visible: true, statusPages: [page.id] })

      // Reading needs metric:read; writing needs a write key (metric:update + status-page:update).
      const listed = await pageMetrics(readKey, page.id)
      expect(listed.status).toBe(200)
      expect(((await listed.json()) as { selected: string[] }).selected).toEqual([dropped.id])
      expect((await pageMetrics(readKey, page.id, { metrics: [first.id] })).status).toBe(403)

      const res = await pageMetrics(writeKey, page.id, { metrics: [second.id, first.id] })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { selected: string[]; metrics: MetricRow[] }
      expect(body.selected).toEqual([second.id, first.id])
      expect(body.metrics.find((m) => m.id === dropped.id)?.statusPages).not.toContain(
        String(page.id),
      )

      const shown = await publicMetrics(page.slug)
      expect(shown.metrics.map((m) => m.name)).toEqual(['Second', 'First'])

      const reordered = await pageMetrics(writeKey, page.id, { metrics: [first.id, second.id] })
      expect(((await reordered.json()) as { selected: string[] }).selected).toEqual([
        first.id,
        second.id,
      ])
      expect((await publicMetrics(page.slug)).metrics.map((m) => m.name)).toEqual([
        'First',
        'Second',
      ])
    })

    it('refuses metrics and pages of another organization', async () => {
      const foreign = await payload.create({
        collection: 'metrics',
        data: { organization: other.id, name: 'Foreign' } as never,
        overrideAccess: true,
      })
      const res = await pageMetrics(writeKey, page.id, { metrics: [String(foreign.id)] })
      expect(res.status).toBe(400)
      const otherPage = await payload.create({
        collection: 'status-pages',
        data: { organization: other.id, title: 'Other', slug: `extras-foreign-${run}` },
        depth: 0,
        overrideAccess: true,
      })
      expect((await pageMetrics(writeKey, otherPage.id)).status).toBe(404)
      expect((await pageMetrics(writeKey, page.id, { metrics: 'all' })).status).toBe(400)
    })
  })

  describe('import and export', () => {
    it('carries metric definitions and page links to another organization', async () => {
      await create({
        name: 'From the monitor',
        source: 'monitor',
        monitor: monitor.id,
        visible: true,
        statusPages: [page.id],
        thresholds: { warning: 1, critical: 2 },
        showThresholdState: true,
      })
      const exported = await exportRoute(
        sessionRequest(`http://localhost/api/orgs/${org.id}/export`, undefined, 'GET'),
        { params: Promise.resolve({ orgId: String(org.id) }) },
      )
      expect(exported.status).toBe(200)
      const file = (await exported.json()) as MarmotExport
      const names = file.metrics.map((m) => m.name)
      expect(names).toEqual(expect.arrayContaining(['First', 'Second', 'From the monitor']))
      const fromMonitor = file.metrics.find((m) => m.name === 'From the monitor')!
      expect(fromMonitor).toMatchObject({
        source: 'monitor',
        monitor: monitor.id,
        statusPages: [page.id],
        showThresholdState: true,
      })
      const exportedPage = file.statusPages.find((p) => p.slug === page.slug)!
      expect(exportedPage.metricOrder?.map(String)).toHaveLength(2)

      // Page slugs are global: the import into another organization renames them.
      const importUrl = `http://localhost/api/orgs/${target.id}/import`
      const ctx = { params: Promise.resolve({ orgId: String(target.id) }) }
      const dry = await importRoute(sessionRequest(`${importUrl}?dryRun=1`, file), ctx)
      expect(dry.status).toBe(200)
      const dryReport = (await dry.json()) as ImportReport
      expect(dryReport.metrics.create).toBe(file.metrics.length)
      expect(
        await payload
          .count({ collection: 'metrics', where: { organization: { equals: target.id } } })
          .then((r) => r.totalDocs),
      ).toBe(0)

      const committed = await importRoute(sessionRequest(importUrl, file), ctx)
      expect(committed.status).toBe(201)
      const report = (await committed.json()) as ImportReport
      expect(report.metrics.created).toHaveLength(file.metrics.length)

      const { docs } = await payload.find({
        collection: 'metrics',
        where: { organization: { equals: target.id } },
        depth: 0,
        limit: 50,
      })
      const imported = docs.find((d) => d.name === 'From the monitor')!
      const importedMonitor = await payload.find({
        collection: 'monitors',
        where: { organization: { equals: target.id } },
        depth: 0,
        limit: 1,
      })
      expect(String(imported.monitor)).toBe(String(importedMonitor.docs[0].id))
      const importedPages = await payload.find({
        collection: 'status-pages',
        where: {
          and: [{ organization: { equals: target.id } }, { title: { equals: page.title } }],
        },
        depth: 0,
        limit: 1,
      })
      const importedPage = importedPages.docs[0]
      expect((imported.statusPages ?? []).map(String)).toEqual([String(importedPage.id)])
      const order = (importedPage.metricOrder ?? []).map(String)
      const byName = new Map(docs.map((d) => [String(d.id), d.name]))
      expect(order.map((id) => byName.get(id))).toEqual(['First', 'Second'])

      // Importing again skips metrics whose name exists.
      const again = await importRoute(sessionRequest(`${importUrl}?dryRun=1`, file), ctx)
      const againReport = (await again.json()) as ImportReport
      expect(againReport.metrics.create).toBe(0)
      expect(againReport.metrics.skipped).toHaveLength(file.metrics.length)
    })
  })
})
