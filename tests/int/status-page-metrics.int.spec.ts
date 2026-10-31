/**
 * Custom status page metrics (#155): push authentication, validation and rate limiting, rollup
 * aggregation and retention, monitor-backed metrics, and what a status page publishes.
 */
import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { GET as getMetric, PATCH as patchMetric } from '@/app/api/orgs/[orgId]/metrics/[id]/route'
import {
  GET as seriesRoute,
  POST as pushRoute,
} from '@/app/api/orgs/[orgId]/metrics/[id]/points/route'
import { GET as listMetrics, POST as createMetric } from '@/app/api/orgs/[orgId]/metrics/route'
import { GET as publicMetricsRoute } from '@/app/api/status-pages/[slug]/metrics/route'
import type { MetricRow, PublicMetric } from '@/lib/metrics'
import { defaultMonitorValues } from '@/lib/validation/monitor'
import type { Metric, Monitor, Organization, StatusPage } from '@/payload-types'
import { generateApiKey } from '@/server/api-keys'
import { runRetention } from '@/server/jobs/retention'
import { foldSeries, viewWindow } from '@/server/metrics/series'
import { handlePush } from '@/server/metrics/push-http'
import type { RateLimiter } from '@/server/security/rate-limit'
import { recordHeartbeat } from '@/server/stats/uptime-calculator'

let payload: Payload
const run = Date.now().toString(36)
const MINUTE = 60 * 1000

let org: Organization
let other: Organization
let page: StatusPage
let otherPage: StatusPage
let monitor: Monitor
let readKey: string
let writeKey: string
let foreignKey: string

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

function keyRequest(
  url: string,
  key: string | null,
  init: { method?: string; body?: unknown } = {},
) {
  return new Request(url, {
    method: init.method ?? 'GET',
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

const orgUrl = (owner: Organization, rest: string) =>
  `http://localhost/api/orgs/${owner.id}/${rest}`
const params = (orgId: string | number, id = '') => Promise.resolve({ orgId: String(orgId), id })

async function create(body: Record<string, unknown>, key = writeKey): Promise<MetricRow> {
  const res = await createMetric(
    keyRequest(orgUrl(org, 'metrics'), key, { method: 'POST', body }),
    {
      params: params(org.id),
    },
  )
  expect(res.status).toBe(201)
  return ((await res.json()) as { doc: MetricRow }).doc
}

async function push(metricId: string, body: unknown, key: string | null = writeKey, owner = org) {
  return pushRoute(
    keyRequest(orgUrl(owner, `metrics/${metricId}/points`), key, { method: 'POST', body }),
    { params: params(owner.id, metricId) },
  )
}

async function publicMetrics(slug: string, query = '') {
  const res = await publicMetricsRoute(
    new Request(`http://localhost/api/status-pages/${slug}/metrics${query}`),
    { params: Promise.resolve({ slug }) },
  )
  return { status: res.status, body: (await res.json()) as { metrics: PublicMetric[] } }
}

describe('custom status page metrics', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    org = await payload.create({
      collection: 'organizations',
      data: { name: 'Metrics Acme', slug: `metrics-acme-${run}` },
      overrideAccess: true,
    })
    other = await payload.create({
      collection: 'organizations',
      data: { name: 'Metrics Other', slug: `metrics-other-${run}` },
      overrideAccess: true,
    })
    readKey = await mintKey(org, 'read')
    writeKey = await mintKey(org, 'write')
    foreignKey = await mintKey(other, 'write')
    page = await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'Metrics Status',
        slug: `metrics-${run}`,
        published: true,
      },
      depth: 0,
      overrideAccess: true,
    })
    otherPage = await payload.create({
      collection: 'status-pages',
      data: {
        organization: other.id,
        title: 'Other Status',
        slug: `metrics-other-${run}`,
        published: true,
      },
      depth: 0,
      overrideAccess: true,
    })
    monitor = (await payload.create({
      collection: 'monitors',
      data: {
        ...defaultMonitorValues('http'),
        name: 'Queue depth source',
        url: 'https://queue.example.com/metrics',
        organization: org.id,
        active: false,
      } as never,
      depth: 0,
      overrideAccess: true,
    })) as Monitor
  })

  afterAll(async () => {
    const orgs = [org?.id, other?.id].filter((id) => id !== undefined)
    for (const collection of [
      'metrics',
      'status-pages',
      'stat-minutely',
      'stat-hourly',
      'stat-daily',
      'monitors',
      'api-keys',
      'audit-logs',
    ] as const) {
      await payload.delete({
        collection,
        where: { organization: { in: orgs } },
        overrideAccess: true,
      })
    }
  })

  describe('push API', () => {
    it('needs a write key of the metric organization', async () => {
      const metric = await create({ name: 'Auth check' })
      const point = { value: 1 }
      expect((await push(metric.id, point, null)).status).toBe(401)
      expect((await push(metric.id, point, 'mk_invalid')).status).toBe(401)
      expect((await push(metric.id, point, readKey)).status).toBe(403)
      // Another organization's key, on either organization's URL.
      expect((await push(metric.id, point, foreignKey)).status).toBe(403)
      expect((await push(metric.id, point, foreignKey, other)).status).toBe(404)
      expect((await push(metric.id, point)).status).toBe(202)
    })

    it('validates the batch and every point', async () => {
      const metric = await create({ name: 'Validation' })
      const tooMany = { points: Array.from({ length: 1001 }, () => ({ value: 1 })) }
      for (const body of [
        {},
        { points: [] },
        { points: [{ value: 'high' }] },
        { points: [{ value: Number.MAX_VALUE }] },
        { points: [{ value: 1, timestamp: 'yesterday' }] },
        tooMany,
      ]) {
        expect((await push(metric.id, body)).status).toBe(400)
      }
      // Older than the data period (backfill reaches back as far as the daily rollup keeps, #280).
      const old = await push(metric.id, {
        points: [
          { value: 1 },
          { value: 2, timestamp: Math.floor(Date.now() / 1000) - 11 * 366 * 86400 },
        ],
      })
      expect(old.status).toBe(400)
      expect(((await old.json()) as { error: string }).error).toContain('Point 1')
      const future = await push(metric.id, {
        value: 1,
        timestamp: new Date(Date.now() + 3600 * 1000).toISOString(),
      })
      expect(future.status).toBe(400)
      // Nothing of a rejected batch was stored.
      const { totalDocs } = await payload.count({
        collection: 'metric-stats',
        where: { metric: { equals: metric.id } },
      })
      expect(totalDocs).toBe(0)
    })

    it('refuses pushes to monitor-backed metrics', async () => {
      const metric = await create({ name: 'From monitor', source: 'monitor', monitor: monitor.id })
      expect((await push(metric.id, { value: 1 })).status).toBe(409)
    })

    it('is rate limited per key and metric', async () => {
      const metric = await create({ name: 'Limited' })
      const spent = new Set<string>()
      const limiter: RateLimiter = {
        name: 'test',
        points: 1,
        duration: 60,
        consume: async (key: string) => {
          const allowed = !spent.has(key)
          spent.add(key)
          return {
            allowed,
            limit: 1,
            remaining: 0,
            retryAfterSeconds: allowed ? 0 : 60,
            degraded: false,
          }
        },
      }
      const request = () =>
        keyRequest(orgUrl(org, `metrics/${metric.id}/points`), writeKey, {
          method: 'POST',
          body: { value: 1 },
        })
      expect((await handlePush(request(), String(org.id), metric.id, limiter)).status).toBe(202)
      const limited = await handlePush(request(), String(org.id), metric.id, limiter)
      expect(limited.status).toBe(429)
      expect(limited.headers.get('Retry-After')).toBeTruthy()
    })
  })

  describe('aggregation', () => {
    it('rolls points up into minutely, hourly and daily buckets', async () => {
      const metric = await create({ name: 'Error rate', suffix: '%', decimals: 2 })
      const base = Math.floor(Date.now() / MINUTE) * MINUTE - 10 * MINUTE
      const res = await push(metric.id, {
        points: [
          { value: 2, timestamp: (base + 1000) / 1000 },
          { value: 4, timestamp: base + 2000 },
          { value: 9, timestamp: new Date(base + MINUTE + 1000).toISOString() },
        ],
      })
      expect(res.status).toBe(202)
      expect(await res.json()).toEqual({ accepted: 3 })
      // A second push into the same minute merges with the stored bucket.
      expect(
        (await push(metric.id, { points: [{ value: 6, timestamp: base + 3000 }] })).status,
      ).toBe(202)

      const { docs } = await payload.find({
        collection: 'metric-stats',
        where: { metric: { equals: metric.id } },
        sort: 'timestamp',
        limit: 10,
      })
      const minutes = docs.filter((d) => d.granularity === 'minute')
      expect(minutes.map((d) => [d.count, d.sum, d.min, d.max, d.last])).toEqual([
        [3, 12, 2, 6, 6],
        [1, 9, 9, 9, 9],
      ])
      for (const granularity of ['hour', 'day'] as const) {
        const rows = docs.filter((d) => d.granularity === granularity)
        expect(rows.reduce((n, d) => n + d.count, 0)).toBe(4)
      }

      const stored = (await payload.findByID({ collection: 'metrics', id: metric.id })) as Metric
      // The value of the latest push.
      expect(stored.lastValue).toBe(6)
      expect(stored.lastPushAt).toBeTruthy()

      const series = await seriesRoute(
        keyRequest(orgUrl(org, `metrics/${metric.id}/points?view=hour`), readKey),
        { params: params(org.id, metric.id) },
      )
      expect(series.status).toBe(200)
      const body = (await series.json()) as { step: number; series: unknown[]; summary: number }
      expect(body.step).toBe(60)
      expect(body.series).toHaveLength(60)
      expect(body.summary).toBe(21 / 4)
    })

    it('applies each aggregation per interval and over the period', () => {
      const window = viewWindow('hour', new Date())
      const row = (offset: number, values: number[]) => ({
        timestamp: window.from + offset * 60,
        count: values.length,
        sum: values.reduce((a, b) => a + b, 0),
        min: Math.min(...values),
        max: Math.max(...values),
        last: values[values.length - 1],
        lastAt: (window.from + offset * 60) * 1000,
      })
      const rows = [row(0, [1, 3]), row(1, [10]), row(1, [2])]
      const pick = (aggregation: 'average' | 'sum' | 'last' | 'max') => {
        const result = foldSeries(rows, aggregation, window)
        return [
          result.series[0].value,
          result.series[1].value,
          result.series[2].value,
          result.summary,
        ]
      }
      expect(pick('average')).toEqual([2, 6, null, 4])
      expect(pick('sum')).toEqual([4, 12, null, 16])
      expect(pick('max')).toEqual([3, 10, null, 10])
      // Equal times: the row merged last wins.
      expect(pick('last')).toEqual([3, 2, null, 2])
    })

    it('expires rollups with the stat retention', async () => {
      const metric = await create({ name: 'Retention' })
      const metricId = (await payload.findByID({ collection: 'metrics', id: metric.id })).id
      // Rows of two days ago: past the minutely retention, within the hourly and daily ones.
      const old = Math.floor(Date.now() / 1000) - 2 * 86400
      for (const [granularity, size] of [
        ['minute', 60],
        ['hour', 3600],
        ['day', 86400],
      ] as const) {
        await payload.create({
          collection: 'metric-stats',
          data: {
            metric: metricId,
            organization: org.id,
            granularity,
            timestamp: Math.floor(old / size) * size,
            count: 1,
            sum: 5,
            min: 5,
            max: 5,
            last: 5,
            lastAt: old * 1000,
          } as never,
          overrideAccess: true,
        })
      }
      const result = await runRetention(payload, new Date(), { keepDataPeriodDays: 365 })
      expect(result.metricStats).toBeGreaterThanOrEqual(1)
      const left = await payload.find({
        collection: 'metric-stats',
        where: { metric: { equals: metric.id } },
        limit: 10,
      })
      expect(left.docs.map((d) => d.granularity).sort()).toEqual(['day', 'hour'])
    })

    it('charts the value a monitor records', async () => {
      const metric = await create({
        name: 'Queue depth',
        source: 'monitor',
        monitor: monitor.id,
        aggregation: 'max',
        visible: true,
        statusPages: [page.id],
      })
      for (const [i, value] of [12, 30, 18].entries()) {
        await recordHeartbeat(payload, {
          monitorId: monitor.id,
          organizationId: org.id,
          status: 'up',
          ping: 10,
          value,
          time: new Date(Date.now() - (5 - i) * MINUTE),
        })
      }
      const { body } = await publicMetrics(page.slug, `?metric=${metric.id}&view=hour`)
      expect(body.metrics[0].summary).toBe(30)
      expect(body.metrics[0].series.filter((p) => p.value !== null).length).toBe(3)
    })
  })

  describe('visibility and access', () => {
    it('validates the metric and keeps its relations in the organization', async () => {
      const bad = await createMetric(
        keyRequest(orgUrl(org, 'metrics'), writeKey, {
          method: 'POST',
          body: { name: 'Bad', decimals: 9 },
        }),
        { params: params(org.id) },
      )
      expect(bad.status).toBe(400)
      const foreignPage = await createMetric(
        keyRequest(orgUrl(org, 'metrics'), writeKey, {
          method: 'POST',
          body: { name: 'Foreign', statusPages: [otherPage.id] },
        }),
        { params: params(org.id) },
      )
      expect(foreignPage.status).toBe(400)
      const noMonitor = await createMetric(
        keyRequest(orgUrl(org, 'metrics'), writeKey, {
          method: 'POST',
          body: { name: 'No monitor', source: 'monitor' },
        }),
        { params: params(org.id) },
      )
      expect(noMonitor.status).toBe(400)
      const viewer = await createMetric(
        keyRequest(orgUrl(org, 'metrics'), readKey, { method: 'POST', body: { name: 'Viewer' } }),
        { params: params(org.id) },
      )
      expect(viewer.status).toBe(403)
    })

    it('hides metrics of other organizations from the management API', async () => {
      const metric = await create({ name: 'Private' })
      const foreign = await getMetric(
        keyRequest(orgUrl(other, `metrics/${metric.id}`), foreignKey),
        { params: params(other.id, metric.id) },
      )
      expect(foreign.status).toBe(404)
      const list = await listMetrics(keyRequest(orgUrl(other, 'metrics'), foreignKey), {
        params: params(other.id),
      })
      const { docs } = (await list.json()) as { docs: MetricRow[] }
      expect(docs.map((d) => d.id)).not.toContain(metric.id)
    })

    it('publishes only visible metrics listed for the page, without internals', async () => {
      const published = await create({
        name: 'Published rate',
        suffix: '%',
        decimals: 1,
        defaultView: 'week',
        thresholds: { warning: 5, critical: 10 },
        visible: true,
        statusPages: [page.id],
        order: -1,
      })
      const hidden = await create({ name: 'Hidden rate', visible: false, statusPages: [page.id] })
      const unlisted = await create({ name: 'Unlisted rate', visible: true })
      for (const metric of [published, hidden, unlisted]) {
        expect((await push(metric.id, { value: 3.25 })).status).toBe(202)
      }

      const { status, body } = await publicMetrics(page.slug)
      expect(status).toBe(200)
      const names = body.metrics.map((m) => m.name)
      expect(names).toContain('Published rate')
      expect(names).not.toContain('Hidden rate')
      expect(names).not.toContain('Unlisted rate')
      const shown = body.metrics.find((m) => m.id === published.id)
      expect(shown).toMatchObject({
        suffix: '%',
        decimals: 1,
        view: 'week',
        step: 3600,
        thresholds: { warning: 5, critical: 10 },
        current: 3.25,
      })
      expect(shown?.series).toHaveLength(168)
      const json = JSON.stringify(body)
      for (const secret of ['lastPushAt', 'organization', 'monitor', 'statusPages', 'Hidden']) {
        expect(json).not.toContain(secret)
      }

      expect((await publicMetrics(page.slug, `?metric=${hidden.id}`)).status).toBe(404)
      expect((await publicMetrics(page.slug, '?view=year')).status).toBe(400)
      expect((await publicMetrics(otherPage.slug)).body.metrics).toEqual([])

      // Unpublishing takes it off the page at once.
      await patchMetric(
        keyRequest(orgUrl(org, `metrics/${published.id}`), writeKey, {
          method: 'PATCH',
          body: { visible: false },
        }),
        { params: params(org.id, published.id) },
      )
      const after = await publicMetrics(page.slug)
      expect(after.body.metrics.map((m) => m.id)).not.toContain(published.id)
    })

    it('follows the access control of a password-protected page', async () => {
      await payload.update({
        collection: 'status-pages',
        id: page.id,
        data: { access: 'password', password: 'correct horse battery' } as Partial<StatusPage>,
        overrideAccess: true,
      })
      try {
        expect((await publicMetrics(page.slug)).status).toBe(401)
        const allowed = await publicMetrics(page.slug, '?pw=correct%20horse%20battery')
        expect(allowed.status).toBe(200)
      } finally {
        await payload.update({
          collection: 'status-pages',
          id: page.id,
          data: { access: 'public' } as Partial<StatusPage>,
          overrideAccess: true,
        })
      }
    })
  })
})
