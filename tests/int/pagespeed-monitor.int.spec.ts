/**
 * PageSpeed monitor (#137) through the real check path: a local mock of the PageSpeed Insights v5
 * API (`PAGESPEED_API_URL`) answers with a recorded response, the worker judges the scores against
 * the monitor's minimums, stores them on the heartbeat, notifies on a drop and rolls the scores up
 * for the trend charts. No request leaves the process.
 */
import { readFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { resetEnvCache } from '@/env'
import { PAGESPEED_MIN_INTERVAL_SECONDS } from '@/lib/pagespeed'
import { defaultMonitorValues } from '@/lib/validation/monitor'
import { monitorFormSchema } from '@/lib/validation/monitor-schema'
import type { Heartbeat, Monitor, Organization } from '@/payload-types'
import {
  clearHeartbeatListeners,
  processCheckJob,
  registerHeartbeatListener,
  type ChecksQueue,
  type HeartbeatEvent,
} from '@/server/engine'
import { effectiveIntervalMs } from '@/server/engine/scheduler'
import { resetInstanceSettingsCache } from '@/server/settings'
import { registerStatsListener } from '@/server/stats'
import { getRangeStats } from '@/server/stats/range-stats'

let payload: Payload
let org: Organization
const run = Date.now().toString(36)
const previousApiUrl = process.env.PAGESPEED_API_URL
const previousApiKey = process.env.PAGESPEED_API_KEY

const recorded = JSON.parse(
  readFileSync(path.join(process.cwd(), 'tests/fixtures/pagespeed/psi-mobile.json'), 'utf8'),
) as { lighthouseResult: { categories: Record<string, { score: number }> } }

/** The recorded answer with the performance score replaced. */
const withPerformance = (score: number) => {
  const body = structuredClone(recorded)
  body.lighthouseResult.categories.performance.score = score
  return body
}

let server: http.Server
let answer: { status: number; body: unknown }
const seen: URLSearchParams[] = []

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
      name: `PageSpeed ${run}`,
      type: 'pagespeed',
      url: 'https://www.example.com/',
      pagespeedStrategy: 'mobile',
      pagespeedMinPerformance: 70,
      interval: 900,
      retryInterval: 900,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 30,
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

beforeAll(async () => {
  payload = await getPayload({ config })
  server = http.createServer((req, res) => {
    seen.push(new URL(req.url ?? '/', 'http://localhost').searchParams)
    res
      .writeHead(answer.status, { 'content-type': 'application/json' })
      .end(JSON.stringify(answer.body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  process.env.PAGESPEED_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/pagespeedonline/v5/runPagespeed`
  process.env.PAGESPEED_API_KEY = `env-key-${run}`
  resetEnvCache()
  resetInstanceSettingsCache()
  org = await payload.create({
    collection: 'organizations',
    data: { name: 'PageSpeed Org', slug: `pagespeed-${run}` },
  })
})

afterEach(() => {
  clearHeartbeatListeners()
  seen.length = 0
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const [name, value] of [
    ['PAGESPEED_API_URL', previousApiUrl],
    ['PAGESPEED_API_KEY', previousApiKey],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  resetEnvCache()
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

describe('pagespeed monitor form validation', () => {
  const base = {
    name: 'Home page',
    type: 'pagespeed',
    url: 'https://www.example.com/',
    interval: 900,
    retryInterval: 900,
    maxRetries: 0,
    resendInterval: 0,
    timeout: 120,
  }
  const issues = (input: Record<string, unknown>) => {
    const parsed = monitorFormSchema.safeParse({ ...base, ...input })
    return parsed.success
      ? {}
      : Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message]))
  }

  it('fills the defaults: PageSpeed Insights, mobile, every category, degraded below a minimum', () => {
    expect(monitorFormSchema.parse({ ...base, pagespeedMinPerformance: 70 })).toMatchObject({
      pagespeedBackend: 'psi',
      pagespeedStrategy: 'mobile',
      pagespeedFailStatus: 'degraded',
      pagespeedCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      pagespeedMinPerformance: 70,
      pagespeedMinSeo: null,
    })
    expect(defaultMonitorValues('pagespeed')).toMatchObject({
      interval: PAGESPEED_MIN_INTERVAL_SECONDS,
      retryInterval: PAGESPEED_MIN_INTERVAL_SECONDS,
      timeout: 120,
      url: 'https://',
    })
  })

  it('enforces the 15 minute interval, the URL, the scores and the remote browser', () => {
    expect(issues({ interval: 300 })).toEqual({
      interval: 'PageSpeed monitors run at most every 15 minutes: at least 900 seconds',
    })
    expect(issues({ retryInterval: 60 })).toHaveProperty('retryInterval')
    expect(issues({ url: 'ftp://example.com' })).toHaveProperty('url')
    expect(issues({ pagespeedMinPerformance: 101 })).toHaveProperty('pagespeedMinPerformance')
    expect(issues({ pagespeedCategories: [] })).toHaveProperty('pagespeedCategories')
    expect(issues({ pagespeedBackend: 'lighthouse' })).toHaveProperty('remoteBrowser')
    expect(
      issues({ pagespeedBackend: 'lighthouse', remoteBrowser: 'ws://browserless:3000' }),
    ).toEqual({})
  })

  it('never schedules a PageSpeed monitor more often than every 15 minutes', () => {
    const monitor = { type: 'pagespeed', interval: 60, retryInterval: 60, status: null }
    expect(effectiveIntervalMs(monitor as never)).toBe(PAGESPEED_MIN_INTERVAL_SECONDS * 1000)
  })
})

describe('pagespeed monitor checks', () => {
  it('charts the scores and notifies when performance drops below the minimum', async () => {
    registerStatsListener(payload)
    const events: HeartbeatEvent[] = []
    registerHeartbeatListener((event) => {
      events.push(event)
    })
    const monitor = await createMonitor()

    answer = { status: 200, body: recorded }
    const healthy = await check(monitor)
    expect(healthy.status).toBe('up')
    expect(healthy.msg).toBe(
      'performance 91, accessibility 97, best-practices 100, seo 92 (mobile)',
    )
    expect(healthy.ping).toBe(87)
    expect(healthy.pagespeed).toMatchObject({
      backend: 'psi',
      strategy: 'mobile',
      scores: { performance: 91, seo: 92 },
      metrics: { lcp: 2613, cls: 0.021, inp: 143, ttfb: 87 },
    })
    expect(seen[0].get('strategy')).toBe('MOBILE')
    expect(seen[0].get('key')).toBe(`env-key-${run}`)

    answer = { status: 200, body: withPerformance(0.54) }
    const dropped = await check(monitor)
    expect(dropped.status).toBe('degraded')
    expect(dropped.msg).toBe('performance 54 < 70 (mobile)')
    expect(dropped.important).toBe(true)
    expect(events.at(-1)).toMatchObject({ notify: true, notificationEvent: 'degraded' })

    answer = { status: 200, body: withPerformance(0.8) }
    const recovered = await check(monitor)
    expect(recovered.status).toBe('up')
    expect(events.at(-1)).toMatchObject({ notify: true, notificationEvent: 'degraded' })

    // The trend charts read the scores from the rollups.
    const stats = await getRangeStats(payload, monitor.id, '1d')
    const performance = stats.series.flatMap((point) =>
      point.pagespeed?.performance ? [point.pagespeed.performance] : [],
    )
    expect(performance.reduce((sum, v) => sum + v.count, 0)).toBe(3)
    expect(Math.min(...performance.map((v) => v.min))).toBe(54)
    expect(Math.max(...performance.map((v) => v.max))).toBe(91)
  })

  it('goes DOWN when the monitor treats a drop as down, and when the page fails to load', async () => {
    const events: HeartbeatEvent[] = []
    registerHeartbeatListener((event) => {
      events.push(event)
    })
    const monitor = await createMonitor({ pagespeedFailStatus: 'down' })
    answer = { status: 200, body: withPerformance(0.41) }
    const down = await check(monitor)
    expect(down.status).toBe('down')
    expect(down.msg).toBe('performance 41 < 70 (mobile)')
    expect(down.pagespeed).toMatchObject({ scores: { performance: 41 } })
    expect(events.at(-1)).toMatchObject({ notify: true, notificationEvent: 'down' })

    const unreachable = await createMonitor()
    answer = {
      status: 400,
      body: JSON.parse(
        readFileSync(
          path.join(process.cwd(), 'tests/fixtures/pagespeed/psi-error-dns.json'),
          'utf8',
        ),
      ),
    }
    const failed = await check(unreachable)
    expect(failed.status).toBe('down')
    expect(failed.msg).toMatch(/^Lighthouse returned error: DNS_FAILURE/)
    expect(failed.pagespeed ?? null).toBeNull()
  })

  it('holds the monitor when the API quota is exhausted', async () => {
    const monitor = await createMonitor()
    answer = { status: 200, body: recorded }
    expect((await check(monitor)).status).toBe('up')
    answer = {
      status: 429,
      body: JSON.parse(
        readFileSync(
          path.join(process.cwd(), 'tests/fixtures/pagespeed/psi-error-quota.json'),
          'utf8',
        ),
      ),
    }
    const held = await check(monitor)
    expect(held.status).toBe('pending')
    expect(held.important).toBe(false)
    expect(held.msg).toMatch(/quota exceeded/)
  })
})
