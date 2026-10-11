/**
 * Prometheus query monitor (#140) through the real check path: a local mock of the Prometheus HTTP
 * API (`/api/v1/query`) answers, the worker judges the value against the monitor's conditions,
 * stores it on the heartbeat and rolls it up for the detail chart. No request leaves the process.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { monitorFormSchema } from '@/lib/validation/monitor-schema'
import type { Heartbeat, Monitor, Organization } from '@/payload-types'
import { clearHeartbeatListeners, processCheckJob, type ChecksQueue } from '@/server/engine'
import { registerStatsListener } from '@/server/stats'
import { getRangeStats } from '@/server/stats/range-stats'

let payload: Payload
let org: Organization
const run = Date.now().toString(36)

const ERROR_RATE =
  'sum(rate(http_requests_total{code=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))'

// ---- Mock Prometheus ---------------------------------------------------------------------------

interface Answer {
  status: number
  body: unknown
}
interface Seen {
  path: string
  query: string | null
  authorization: string | undefined
  tenant: string | undefined
}

let server: http.Server
let baseUrl: string
let answer: Answer
const seen: Seen[] = []

const vector = (...series: { labels?: Record<string, string>; value: string }[]) => ({
  status: 'success',
  data: {
    resultType: 'vector',
    result: series.map((s) => ({ metric: s.labels ?? {}, value: [1_790_000_000, s.value] })),
  },
})

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
      name: `Error rate ${run}`,
      type: 'prometheus',
      url: `${baseUrl}/prom`,
      prometheusQuery: ERROR_RATE,
      prometheusDownOperator: '>',
      prometheusDownThreshold: 0.05,
      prometheusDegradedOperator: '>',
      prometheusDegradedThreshold: 0.01,
      interval: 60,
      retryInterval: 60,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 10,
      ...data,
    } as RequiredDataFromCollectionSlug<'monitors'>,
  })) as Monitor
}

const reload = async (id: string | number) =>
  (await payload.findByID({
    collection: 'monitors',
    id,
    depth: 0,
    overrideAccess: true,
  })) as Monitor

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
    const url = new URL(req.url ?? '/', 'http://localhost')
    seen.push({
      path: url.pathname,
      query: url.searchParams.get('query'),
      authorization: req.headers.authorization,
      tenant: req.headers['x-scope-orgid'] as string | undefined,
    })
    res
      .writeHead(answer.status, { 'content-type': 'application/json' })
      .end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  org = await payload.create({
    collection: 'organizations',
    data: { name: 'Prometheus Org', slug: `prometheus-${run}` },
  })
})

afterEach(() => {
  clearHeartbeatListeners()
  seen.length = 0
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (org?.id) {
    const where = { organization: { equals: org.id } }
    for (const collection of [
      'heartbeats',
      'stat-minutely',
      'stat-hourly',
      'stat-daily',
      'monitors',
    ] as const) {
      await payload.delete({ collection, where, overrideAccess: true })
    }
    await payload.delete({ collection: 'organizations', id: org.id, overrideAccess: true })
  }
})

describe('prometheus monitor form validation', () => {
  const base = {
    name: 'Error rate',
    type: 'prometheus',
    url: 'https://prometheus.example.com',
    prometheusQuery: ERROR_RATE,
    prometheusDownThreshold: 0.05,
    interval: 60,
    retryInterval: 60,
    maxRetries: 0,
    resendInterval: 0,
    timeout: 30,
  }
  const issues = (input: Record<string, unknown>) => {
    const parsed = monitorFormSchema.safeParse({ ...base, ...input })
    return parsed.success
      ? {}
      : Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message]))
  }

  it('accepts a query with a DOWN threshold and fills the defaults', () => {
    expect(monitorFormSchema.parse(base)).toMatchObject({
      prometheusDownOperator: '>',
      prometheusDegradedOperator: null,
      prometheusDegradedThreshold: null,
      prometheusAggregate: 'worst',
      prometheusNoDataStatus: 'down',
      prometheusErrorStatus: 'down',
    })
  })

  it('requires the URL, the query and the thresholds, and limits authentication', () => {
    expect(issues({ url: null })).toHaveProperty('url')
    expect(issues({ url: 'ftp://prom' })).toHaveProperty('url')
    expect(issues({ prometheusQuery: '' })).toHaveProperty('prometheusQuery')
    expect(issues({ prometheusDownThreshold: null })).toHaveProperty('prometheusDownThreshold')
    expect(issues({ prometheusDegradedOperator: '>' })).toHaveProperty(
      'prometheusDegradedThreshold',
    )
    expect(issues({ authMethod: 'oauth2-cc' })).toHaveProperty('authMethod')
    expect(issues({ authMethod: 'bearer' })).toHaveProperty('bearerToken')
  })
})

describe('prometheus monitor checks', () => {
  it('goes DOWN when the error rate crosses 5 % and stores the value', async () => {
    registerStatsListener(payload)
    const monitor = await createMonitor({
      authMethod: 'bearer',
      bearerToken: `token-${run}`,
      headers: JSON.stringify({ 'X-Scope-OrgID': 'tenant-1' }),
    })

    answer = { status: 200, body: vector({ value: '0.002' }) }
    const healthy = await check(monitor)
    expect(healthy.status).toBe('up')
    expect(healthy.value).toBeCloseTo(0.002)
    expect(healthy.msg).toBe('Value 0.002')
    expect(seen[0]).toMatchObject({
      path: '/prom/api/v1/query',
      query: ERROR_RATE,
      authorization: `Bearer token-${run}`,
      tenant: 'tenant-1',
    })

    answer = { status: 200, body: vector({ value: '0.03' }) }
    const degraded = await check(monitor)
    expect(degraded.status).toBe('degraded')
    expect(degraded.msg).toContain('degraded condition > 0.01')

    answer = { status: 200, body: vector({ value: '0.0712' }) }
    const down = await check(monitor)
    expect(down.status).toBe('down')
    expect(down.value).toBeCloseTo(0.0712)
    expect(down.msg).toBe('Value 0.0712 meets the DOWN condition > 0.05')
    expect(down.important).toBe(true)
    expect((await reload(monitor.id)).status?.lastStatus).toBe('down')

    // The detail chart reads the value from the rollups.
    const stats = await getRangeStats(payload, monitor.id, '1d')
    const values = stats.series.flatMap((point) => (point.value ? [point.value] : []))
    expect(values.reduce((sum, v) => sum + v.count, 0)).toBe(3)
    expect(Math.max(...values.map((v) => v.max))).toBeCloseTo(0.0712)
    expect(Math.min(...values.map((v) => v.min))).toBeCloseTo(0.002)
  })

  it('uses noDataStatus for an empty result', async () => {
    answer = { status: 200, body: vector() }
    const down = await createMonitor({ prometheusNoDataStatus: 'down' })
    const beat = await check(down)
    expect(beat.status).toBe('down')
    expect(beat.msg).toBe('The query returned no data')
    expect(beat.value ?? null).toBeNull()

    const up = await createMonitor({ prometheusNoDataStatus: 'up' })
    expect((await check(up)).status).toBe('up')

    // Pending keeps the monitor's state: a held beat, not a retry or a DOWN.
    const pending = await createMonitor({ prometheusNoDataStatus: 'pending' })
    answer = { status: 200, body: vector({ value: '0' }) }
    expect((await check(pending)).status).toBe('up')
    answer = { status: 200, body: vector() }
    const held = await check(pending)
    expect(held.status).toBe('pending')
    expect((await reload(pending.id)).status?.lastStatus).toBe('up')
  })

  it('uses errorStatus when the query fails', async () => {
    answer = {
      status: 400,
      body: { status: 'error', errorType: 'bad_data', error: 'parse error at char 5' },
    }
    const down = await createMonitor()
    const beat = await check(down)
    expect(beat.status).toBe('down')
    expect(beat.msg).toBe('HTTP 400: Query failed: bad_data: parse error at char 5')

    const up = await createMonitor({ prometheusErrorStatus: 'up' })
    const upBeat = await check(up)
    expect(upBeat.status).toBe('up')
    expect(upBeat.msg).toContain('(counted as UP)')

    answer = { status: 200, body: '<html>not the API</html>' }
    expect((await check(down)).msg).toContain('not JSON')
  })

  it('aggregates several series', async () => {
    answer = {
      status: 200,
      body: vector(
        { labels: { __name__: 'queue_depth', queue: 'a' }, value: '3' },
        { labels: { __name__: 'queue_depth', queue: 'b' }, value: '250' },
        { labels: { __name__: 'queue_depth', queue: 'c' }, value: '120' },
      ),
    }
    const settings = {
      prometheusQuery: 'queue_depth',
      prometheusDownThreshold: 100,
      prometheusDegradedOperator: null,
      prometheusDegradedThreshold: null,
    } as const
    const worst = await check(await createMonitor({ ...settings, prometheusAggregate: 'worst' }))
    expect(worst.status).toBe('down')
    expect(worst.value).toBe(250)
    expect(worst.msg).toBe('queue_depth{queue="b"} = 250 (3 series) meets the DOWN condition > 100')

    const any = await check(await createMonitor({ ...settings, prometheusAggregate: 'any' }))
    expect(any.status).toBe('down')
    expect(any.value).toBe(250)

    const all = await check(await createMonitor({ ...settings, prometheusAggregate: 'all' }))
    expect(all.status).toBe('up')
    expect(all.value).toBe(3)
  })
})
