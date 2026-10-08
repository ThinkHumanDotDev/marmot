import { readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { resetEnvCache } from '@/env'
import { parseRequestTiming, timingTotal, type RequestTiming } from '@/lib/request-timing'
import type { Heartbeat, Monitor } from '@/payload-types'
import {
  clearHeartbeatListeners,
  processCheckJob,
  recordBeat,
  registerHeartbeatListener,
  type ChecksQueue,
} from '@/server/engine'
import { processManualCheckJob } from '@/server/engine/on-demand-jobs'
import { createStatsListener, getBuckets } from '@/server/stats'
import { getRangeStats } from '@/server/stats/range-stats'

/**
 * Request timing phases (#94): HTTP(S) checks record DNS, connect, TLS, TTFB and transfer on the
 * heartbeat, TCP checks DNS and connect, and the stat buckets keep per-phase averages.
 */

const FIXTURES = path.join(process.cwd(), 'tests/fixtures/tls')
const cert = readFileSync(path.join(FIXTURES, 'localhost.crt'), 'utf8')
const key = readFileSync(path.join(FIXTURES, 'localhost.key'), 'utf8')

/** The server waits before the headers and between two body chunks, so TTFB and transfer show. */
const HEADERS_DELAY = 60
const BODY_DELAY = 40

let payload: Payload
let httpsServer: https.Server
let httpServer: http.Server
let tcpServer: net.Server
let httpsPort: number
let httpPort: number
let tcpPort: number
let organizationId: string | number

const run = Date.now().toString(36)

const slowHandler: http.RequestListener = (req, res) => {
  if (req.url === '/redirect') {
    res.writeHead(302, { location: '/' })
    res.end()
    return
  }
  setTimeout(() => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.write('first chunk ')
    setTimeout(() => res.end('last chunk'), BODY_DELAY)
  }, HEADERS_DELAY)
}

const queue = {
  upsertJobScheduler: vi.fn(async () => undefined),
  removeJobScheduler: vi.fn(async () => true),
} as unknown as ChecksQueue

async function createMonitor(data: Partial<Monitor> & { name: string; type: Monitor['type'] }) {
  return (await payload.create({
    collection: 'monitors',
    overrideAccess: true,
    depth: 0,
    data: {
      organization: organizationId,
      interval: 60,
      retryInterval: 20,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 10,
      ...data,
    } as RequiredDataFromCollectionSlug<'monitors'>,
  })) as Monitor
}

async function check(monitor: Monitor): Promise<Heartbeat> {
  const result = await processCheckJob(
    payload,
    { data: { monitorId: String(monitor.id) } },
    {
      queue,
    },
  )
  expect(result.outcome).toBe('processed')
  return result.heartbeat as Heartbeat
}

/**
 * The server's delays show up in TTFB and transfer. Server and client share one event loop, so a
 * busy loop can stamp the headers late: that moves time from transfer to TTFB, never the reverse.
 */
function expectServerDelays(timing: RequestTiming) {
  expect(timing.ttfb).toBeGreaterThanOrEqual(HEADERS_DELAY - 5)
  expect(timing.transfer).toBeGreaterThan(0)
  expect((timing.ttfb as number) + (timing.transfer as number)).toBeGreaterThanOrEqual(
    HEADERS_DELAY + BODY_DELAY - 5,
  )
}

/** The stored heartbeat, read back from the database (not the create() return value). */
async function storedTiming(heartbeat: Heartbeat): Promise<RequestTiming | null> {
  const doc = await payload.findByID({
    collection: 'heartbeats',
    id: heartbeat.id,
    depth: 0,
    overrideAccess: true,
  })
  return parseRequestTiming((doc as Heartbeat).timing)
}

beforeAll(async () => {
  payload = await getPayload({ config })
  const org = await payload.create({
    collection: 'organizations',
    data: { name: 'http-timing-org', slug: `http-timing-org-${run}` },
  })
  organizationId = org.id

  httpsServer = https.createServer({ cert, key }, slowHandler)
  httpServer = http.createServer(slowHandler)
  tcpServer = net.createServer((socket) => socket.end())
  const listen = (server: net.Server) =>
    new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
    )
  ;[httpsPort, httpPort, tcpPort] = await Promise.all([
    listen(httpsServer),
    listen(httpServer),
    listen(tcpServer),
  ])
})

afterAll(async () => {
  for (const server of [httpsServer, httpServer]) server?.closeAllConnections()
  await Promise.all(
    [httpsServer, httpServer, tcpServer].map(
      (server) => new Promise((resolve) => server?.close(resolve)),
    ),
  )
  for (const collection of ['stat-minutely', 'stat-hourly', 'stat-daily', 'heartbeats'] as const) {
    await payload.delete({
      collection,
      where: { organization: { equals: organizationId } },
      overrideAccess: true,
    })
  }
  await payload.delete({
    collection: 'monitors',
    where: { organization: { equals: organizationId } },
    overrideAccess: true,
  })
  await payload.delete({ collection: 'organizations', where: { id: { equals: organizationId } } })
})

afterEach(() => {
  clearHeartbeatListeners()
})

describe('HTTP request timing phases', () => {
  it('records DNS, connect, TLS, TTFB and transfer for an HTTPS check, adding up to the ping', async () => {
    const monitor = await createMonitor({
      name: 'https-timing',
      type: 'http',
      // A host name (not an IP literal), so there is a DNS phase.
      url: `https://localhost:${httpsPort}/`,
      ignoreTls: true,
    })
    const heartbeat = await check(monitor)
    expect(heartbeat.status).toBe('up')

    const timing = await storedTiming(heartbeat)
    expect(timing).not.toBeNull()
    const phases = timing as RequestTiming
    for (const phase of ['dns', 'connect', 'tls', 'ttfb', 'transfer'] as const) {
      expect(phases[phase], phase).toEqual(expect.any(Number))
    }
    expectServerDelays(phases)

    // The phases cover the request: their sum is close to the total ping (which also includes
    // request setup and reading the body into a string).
    const ping = heartbeat.ping as number
    const total = timingTotal(phases)
    expect(total).toBeLessThanOrEqual(ping + 2)
    expect(total).toBeGreaterThanOrEqual(ping * 0.75 - 10)
  })

  it('leaves TLS empty for plain HTTP and DNS empty for an IP literal', async () => {
    const monitor = await createMonitor({
      name: 'http-timing',
      type: 'keyword',
      keyword: 'last chunk',
      url: `http://127.0.0.1:${httpPort}/`,
    })
    const heartbeat = await check(monitor)
    expect(heartbeat.status).toBe('up')
    const timing = (await storedTiming(heartbeat)) as RequestTiming
    expect(timing.tls).toBeNull()
    expect(timing.dns).toBeNull()
    expect(timing.connect).toEqual(expect.any(Number))
    expect(timing.ttfb).toBeGreaterThanOrEqual(HEADERS_DELAY - 5)
  })

  it('reports the final hop of a redirect chain', async () => {
    const monitor = await createMonitor({
      name: 'redirect-timing',
      type: 'http',
      url: `http://127.0.0.1:${httpPort}/redirect`,
    })
    const heartbeat = await check(monitor)
    expect(heartbeat.status).toBe('up')
    const timing = (await storedTiming(heartbeat)) as RequestTiming
    // The final response is the slow one.
    expectServerDelays(timing)
  })

  it('counts the outbound guard resolution as the DNS phase when the guard is on', async () => {
    const saved = process.env.MONITOR_DENY_CIDRS
    // Any deny list turns the guard on; this one does not match the local server.
    process.env.MONITOR_DENY_CIDRS = '203.0.113.0/24'
    resetEnvCache()
    try {
      const monitor = await createMonitor({
        name: 'guarded-timing',
        type: 'http',
        url: `https://localhost:${httpsPort}/`,
        ignoreTls: true,
      })
      const heartbeat = await check(monitor)
      expect(heartbeat.status).toBe('up')
      const timing = (await storedTiming(heartbeat)) as RequestTiming
      for (const phase of ['dns', 'connect', 'tls', 'ttfb', 'transfer'] as const) {
        expect(timing[phase], phase).toEqual(expect.any(Number))
      }
    } finally {
      if (saved === undefined) delete process.env.MONITOR_DENY_CIDRS
      else process.env.MONITOR_DENY_CIDRS = saved
      resetEnvCache()
    }
  })

  it('records the phases a failing check received a response for', async () => {
    const monitor = await createMonitor({
      name: 'http-timing-down',
      type: 'http',
      url: `http://127.0.0.1:${httpPort}/`,
      acceptedStatusCodes: ['500'],
    })
    const heartbeat = await check(monitor)
    expect(heartbeat.status).toBe('down')
    expect((await storedTiming(heartbeat))?.ttfb).toEqual(expect.any(Number))
  })

  it('records DNS and connect for a TCP port check', async () => {
    const monitor = await createMonitor({
      name: 'tcp-timing',
      type: 'port',
      hostname: 'localhost',
      port: tcpPort,
    })
    const heartbeat = await check(monitor)
    expect(heartbeat.status).toBe('up')
    const timing = (await storedTiming(heartbeat)) as RequestTiming
    expect(timing.dns).toEqual(expect.any(Number))
    expect(timing.connect).toEqual(expect.any(Number))
    expect(timing.tls).toBeNull()
    expect(timing.ttfb).toBeNull()
    expect(timing.transfer).toBeNull()
  })

  it('stores no timing for types that do not measure it', async () => {
    const monitor = await createMonitor({ name: 'manual-timing', type: 'manual' })
    const heartbeat = await check(monitor)
    expect(await storedTiming(heartbeat)).toBeNull()
  })

  it('returns the phases from an on-demand check', async () => {
    const monitor = await createMonitor({
      name: 'on-demand-timing',
      type: 'http',
      url: `https://127.0.0.1:${httpsPort}/`,
      ignoreTls: true,
    })
    const result = await processManualCheckJob(payload, {
      monitorId: String(monitor.id),
      record: false,
      deadline: Date.now() + 30_000,
    } as Parameters<typeof processManualCheckJob>[1])
    expect(result.timing?.tls).toEqual(expect.any(Number))
    expect(result.timing?.dns).toBeNull()
  })
})

describe('per-phase averages in the stat buckets', () => {
  it('stores and rolls up no timing for a deferred beat', async () => {
    registerHeartbeatListener(createStatsListener(payload))
    const monitor = await createMonitor({
      name: 'deferred-timing',
      type: 'http',
      url: `http://127.0.0.1:${httpPort}/`,
    })
    const { heartbeat } = await recordBeat(
      payload,
      monitor,
      {
        ok: false,
        msg: 'rate limited',
        deferred: true,
        timing: { dns: 1, connect: 2, tls: null, ttfb: 3, transfer: 4 },
      },
      { queue },
    )
    expect(await storedTiming(heartbeat)).toBeNull()
    const buckets = await getBuckets(payload, monitor.id, '24h')
    expect(buckets.every((b) => b.extras.timing === undefined)).toBe(true)
  })

  it('rolls up the phase averages and keeps the ping statistics unchanged', async () => {
    registerHeartbeatListener(createStatsListener(payload))
    const monitor = await createMonitor({
      name: 'timing-rollup',
      type: 'http',
      url: `http://127.0.0.1:${httpPort}/`,
    })
    const first = await check(monitor)
    const second = await check(monitor)
    const t1 = (await storedTiming(first)) as RequestTiming
    const t2 = (await storedTiming(second)) as RequestTiming

    for (const range of ['24h', '30d', '1y'] as const) {
      const buckets = await getBuckets(payload, monitor.id, range)
      const up = buckets.reduce((sum, b) => sum + b.up, 0)
      expect(up, range).toBe(2)
      // The beats may straddle a bucket boundary; fold the buckets the way a reader would.
      const timing = buckets.map((b) => b.extras.timing ?? {})
      const ttfbCount = timing.reduce((sum, t) => sum + (t.ttfb?.count ?? 0), 0)
      const ttfbSum = timing.reduce((sum, t) => sum + (t.ttfb ? t.ttfb.avg * t.ttfb.count : 0), 0)
      expect(ttfbCount, range).toBe(2)
      expect(ttfbSum / ttfbCount).toBeCloseTo(((t1.ttfb as number) + (t2.ttfb as number)) / 2, 5)
      // Plain HTTP: no TLS phase, so no TLS average.
      expect(timing.every((t) => t.tls === undefined)).toBe(true)

      // Existing ping statistics are untouched by the timing rollup.
      const pings = [first.ping as number, second.ping as number]
      const pingMin = Math.min(...buckets.map((b) => b.pingMin as number))
      const pingMax = Math.max(...buckets.map((b) => b.pingMax as number))
      expect(pingMin).toBe(Math.min(...pings))
      expect(pingMax).toBe(Math.max(...pings))
    }

    // The detail page's chart series carries the interval averages for the phase chart.
    const stats = await getRangeStats(payload, monitor.id, '1d')
    const withTiming = stats.series.filter((point) => point.timing)
    expect(withTiming.length).toBeGreaterThan(0)
    expect(withTiming.every((point) => typeof point.timing?.ttfb === 'number')).toBe(true)
    expect(stats.series.some((point) => point.up > 0 && !point.timing)).toBe(false)
  })
})
