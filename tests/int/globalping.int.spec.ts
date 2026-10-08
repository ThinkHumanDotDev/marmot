/**
 * Globalping monitor type (#142) through the real persistence path: the collection stores its
 * fields, the worker records per-probe results on the heartbeat, the instance token is sent, a
 * majority failure goes DOWN, and rate limits leave the monitor PENDING (held, never DOWN).
 * Every Globalping API call is answered by a mocked fixture: no request leaves the process.
 */
import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { monitorFormSchema } from '@/lib/validation/monitor-schema'
import type { Heartbeat, Monitor, Organization } from '@/payload-types'
import {
  clearHeartbeatListeners,
  processCheckJob,
  registerHeartbeatListener,
  type ChecksQueue,
  type HeartbeatEvent,
} from '@/server/engine'
import { parseUptimeKumaBackup } from '@/server/import-export/uptime-kuma'
import { GLOBALPING_API_URL, resetGlobalpingRateLimit } from '@/server/monitor-types/globalping'
import type { ProbeResult } from '@/server/monitor-types/types'
import { resetInstanceSettingsCache } from '@/server/settings'

let payload: Payload
let org: Organization
const run = Date.now().toString(36)

const fakeQueue = () =>
  ({
    upsertJobScheduler: vi.fn(async () => undefined),
    removeJobScheduler: vi.fn(async () => true),
  }) as unknown as ChecksQueue

const europeanProbe = (city: string, country: string, asn: number) => ({
  continent: 'EU',
  country,
  state: null,
  city,
  asn,
  network: `Net ${city}`,
  tags: [],
})

const httpProbe = (
  city: string,
  country: string,
  asn: number,
  statusCode: number,
  total: number,
) => ({
  probe: europeanProbe(city, country, asn),
  result: {
    status: 'finished',
    statusCode,
    statusCodeName: statusCode === 200 ? 'OK' : 'Bad Gateway',
    timings: { total },
    tls: { authorized: true },
    rawOutput: '',
  },
})

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })

/** Globalping API fixture: POST creates `m-<n>`, GET returns the queued measurement result. */
function mockGlobalping(results: ReturnType<typeof httpProbe>[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (!url.startsWith(GLOBALPING_API_URL)) throw new Error(`unexpected request to ${url}`)
    if (init?.method === 'POST')
      return json({ id: 'm-int', probesCount: results.length }, { status: 202 })
    return json({ id: 'm-int', status: 'finished', results })
  })
}

function mockRateLimit(seconds = 90) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () =>
      json(
        { error: { type: 'too_many_requests', message: 'Too many requests. Please retry later.' } },
        { status: 429, headers: { 'x-ratelimit-reset': String(seconds) } },
      ),
    )
}

async function createMonitor(data: Partial<Monitor> = {}): Promise<Monitor> {
  return (await payload.create({
    collection: 'monitors',
    overrideAccess: true,
    depth: 0,
    data: {
      organization: org.id,
      name: `Globalping ${run}`,
      type: 'globalping',
      url: 'https://example.com/',
      method: 'GET',
      acceptedStatusCodes: ['200-299'],
      globalpingMeasurement: 'http',
      globalpingLocations: 'Europe',
      globalpingProbes: 3,
      globalpingSuccessRule: 'atLeast',
      globalpingMinSuccess: 2,
      interval: 60,
      retryInterval: 60,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 10,
      ...data,
    } as RequiredDataFromCollectionSlug<'monitors'>,
  })) as Monitor
}

const check = async (monitor: Monitor) => {
  const result = await processCheckJob(
    payload,
    { data: { monitorId: String(monitor.id) } },
    { queue: fakeQueue() },
  )
  expect(result.outcome).toBe('processed')
  return result.heartbeat as Heartbeat
}

const reload = async (id: string | number) =>
  (await payload.findByID({
    collection: 'monitors',
    id,
    depth: 0,
    overrideAccess: true,
  })) as Monitor

const setToken = async (globalpingApiToken: string | null) => {
  await payload.updateGlobal({
    slug: 'instance-settings',
    data: { globalpingApiToken },
    overrideAccess: true,
  })
  resetInstanceSettingsCache()
}

beforeAll(async () => {
  payload = await getPayload({ config })
  org = await payload.create({
    collection: 'organizations',
    data: { name: 'Globalping Org', slug: `globalping-${run}` },
  })
})

beforeEach(() => {
  resetGlobalpingRateLimit()
})

afterEach(() => {
  vi.restoreAllMocks()
  clearHeartbeatListeners()
})

afterAll(async () => {
  await setToken(null)
  if (org?.id) {
    const where = { organization: { equals: org.id } }
    for (const collection of ['heartbeats', 'monitors'] as const) {
      await payload.delete({ collection, where, overrideAccess: true })
    }
    await payload.delete({ collection: 'organizations', id: org.id, overrideAccess: true })
  }
})

describe('globalping monitor form validation', () => {
  const base = {
    name: 'GP',
    type: 'globalping',
    interval: 60,
    retryInterval: 60,
    maxRetries: 0,
    resendInterval: 0,
    timeout: 30,
    url: 'https://example.com/',
  }
  const issues = (input: Record<string, unknown>) => {
    const parsed = monitorFormSchema.safeParse({ ...base, ...input })
    return parsed.success
      ? {}
      : Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message]))
  }

  it('accepts an HTTP measurement with the defaults', () => {
    const parsed = monitorFormSchema.parse(base)
    expect(parsed).toMatchObject({
      globalpingMeasurement: 'http',
      globalpingProbes: 3,
      globalpingSuccessRule: 'all',
      globalpingProtocol: null,
      globalpingLocations: null,
    })
  })

  it('enforces the minimum interval, the target, the method and the status rule', () => {
    expect(issues({ interval: 30, retryInterval: 20 })).toMatchObject({
      interval: expect.stringMatching(/at least 60 seconds/),
      retryInterval: expect.stringMatching(/at least 60 seconds/),
    })
    expect(issues({ method: 'POST' })).toHaveProperty('method')
    expect(issues({ globalpingMeasurement: 'ping', url: null })).toHaveProperty('hostname')
    expect(
      issues({ globalpingMeasurement: 'ping', hostname: 'example.com', globalpingProtocol: 'UDP' }),
    ).toHaveProperty('globalpingProtocol')
    expect(
      issues({ globalpingMeasurement: 'dns', hostname: 'example.com', dnsResolveType: 'CAA' }),
    ).toHaveProperty('dnsResolveType')
    expect(issues({ globalpingSuccessRule: 'atLeast' })).toHaveProperty('globalpingMinSuccess')
    expect(issues({ globalpingSuccessRule: 'atLeast', globalpingMinSuccess: 4 })).toHaveProperty(
      'globalpingMinSuccess',
    )
    expect(issues({ globalpingProbes: 51 })).toHaveProperty('globalpingProbes')
    expect(issues({ globalpingSuccessRule: 'atLeast', globalpingMinSuccess: 2 })).toEqual({})
  })
})

describe('globalping monitor checks', () => {
  it('reports per-probe latency of 3 European probes and goes DOWN when the majority fails', async () => {
    const fetchSpy = mockGlobalping([
      httpProbe('Amsterdam', 'NL', 1136, 200, 120),
      httpProbe('Frankfurt', 'DE', 24940, 502, 80),
      httpProbe('Paris', 'FR', 16276, 502, 95),
    ])
    const monitor = await createMonitor()
    const beat = await check(monitor)

    expect(beat.status).toBe('down')
    expect(beat.important).toBe(true)
    expect(beat.msg).toMatch(/^1\/3 probes succeeded \(2 required\) — Amsterdam, NL, EU/)
    expect(beat.msg).toContain(
      'Frankfurt, DE, EU, Net Frankfurt (AS24940): ✗ Status code 502 Bad Gateway not accepted',
    )
    expect(beat.ping).toBe(120)
    const probes = beat.probes as unknown as ProbeResult[]
    expect(probes).toHaveLength(3)
    expect(probes.map((p) => [p.location.split(',')[0], p.ok, p.latency])).toEqual([
      ['Amsterdam', true, 120],
      ['Frankfurt', false, 80],
      ['Paris', false, 95],
    ])

    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))
    expect(body).toMatchObject({
      type: 'http',
      target: 'example.com',
      limit: 3,
      locations: [{ magic: 'Europe' }],
    })
    expect((await reload(monitor.id)).status?.lastStatus).toBe('down')
  })

  it('uses the instance token when present and is UP when the majority succeeds', async () => {
    await setToken('gp-instance-token')
    try {
      const fetchSpy = mockGlobalping([
        httpProbe('Amsterdam', 'NL', 1136, 200, 100),
        httpProbe('Frankfurt', 'DE', 24940, 200, 140),
        httpProbe('Paris', 'FR', 16276, 502, 95),
      ])
      const beat = await check(await createMonitor())
      expect(beat.status).toBe('up')
      expect(beat.ping).toBe(120)
      expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
      for (const [, init] of fetchSpy.mock.calls) {
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          'Bearer gp-instance-token',
        )
      }
    } finally {
      await setToken(null)
    }
  })

  it('leaves the monitor PENDING with a clear message on 429, never DOWN', async () => {
    const events: HeartbeatEvent[] = []
    registerHeartbeatListener((event) => {
      events.push(event)
    })
    mockGlobalping([
      httpProbe('Amsterdam', 'NL', 1136, 200, 100),
      httpProbe('Frankfurt', 'DE', 24940, 200, 140),
      httpProbe('Paris', 'FR', 16276, 200, 95),
    ])
    const monitor = await createMonitor({ maxRetries: 0 })
    expect((await check(monitor)).status).toBe('up')
    vi.restoreAllMocks()

    const limited = mockRateLimit(90)
    const held = await check(monitor)
    expect(held.status).toBe('pending')
    expect(held.important).toBe(false)
    expect(held.msg).toMatch(/Globalping rate limit reached \(429\)/)
    expect(held.msg).toMatch(/API token in the instance settings/)
    expect(held.msg).toMatch(/Checks resume in 90 s; the monitor stays pending/)
    expect(events.at(-1)).toMatchObject({ deferred: true, notify: false })

    // The cached state is kept, so the next real verdict is judged against UP.
    const after = await reload(monitor.id)
    expect(after.status?.lastStatus).toBe('up')
    expect(after.status?.retries).toBe(0)
    expect(after.status?.lastMsg).toMatch(/rate limit/)

    // While backing off, the API is not called again and the monitor still does not go DOWN.
    const again = await check(monitor)
    expect(again.status).toBe('pending')
    expect(limited).toHaveBeenCalledTimes(1)
  })

  it('never turns a first check that hits the rate limit into DOWN', async () => {
    mockRateLimit()
    const monitor = await createMonitor()
    const beat = await check(monitor)
    expect(beat.status).toBe('pending')
    expect((await reload(monitor.id)).status?.lastStatus ?? null).toBeNull()
  })
})

describe('globalping import from Uptime Kuma', () => {
  it('maps a Kuma Globalping monitor onto the Marmot fields', () => {
    const plan = parseUptimeKumaBackup({
      version: '2.0.0',
      notificationList: [],
      monitorList: [
        {
          id: 1,
          name: 'Kuma GP',
          type: 'globalping',
          subtype: 'ping',
          hostname: 'example.com',
          location: 'Europe',
          ping_count: 4,
          protocol: 'icmp',
          ipFamily: 'ipv4',
          interval: 20,
          retryInterval: 20,
          maxretries: 0,
          accepted_statuscodes: ['200-299'],
        },
      ],
    })
    expect(plan.skipped.monitors).toEqual([])
    expect(plan.monitors[0].data).toMatchObject({
      type: 'globalping',
      hostname: 'example.com',
      interval: 60,
      globalpingMeasurement: 'ping',
      globalpingLocations: 'Europe',
      globalpingProbes: 1,
      globalpingPackets: 4,
      globalpingProtocol: 'ICMP',
      globalpingIpVersion: '4',
    })
  })
})
