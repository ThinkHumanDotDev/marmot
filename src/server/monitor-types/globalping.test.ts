import type { Payload } from 'payload'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Monitor } from '@/payload-types'
import { resetInstanceSettingsCache } from '@/server/settings'

import {
  buildMeasurementRequest,
  evaluateMeasurement,
  formatApiError,
  formatProbeLocation,
  GLOBALPING_API_URL,
  rateLimitResetSeconds,
  resetGlobalpingRateLimit,
  type GlobalpingMeasurementResponse,
  type GlobalpingProbe,
  type GlobalpingResult,
} from './globalping'
import { makeMonitor, runCheck } from './test-helpers'
import { isCheckDeferredError } from './types'
import './index'

/** Mocked Globalping API fixtures: no request leaves the process. */
const probe = (city: string, country: string, asn: number): GlobalpingProbe => ({
  continent: 'EU',
  region: 'Western Europe',
  country,
  state: null,
  city,
  asn,
  network: `Net ${city}`,
  tags: [`datacenter-network`, `aws-eu-${city.toLowerCase()}-1`],
})
const AMS = probe('Amsterdam', 'NL', 1136)
const FRA = probe('Frankfurt', 'DE', 24940)
const PAR = probe('Paris', 'FR', 16276)

const httpResult = (statusCode: number, total: number): GlobalpingResult => ({
  status: 'finished',
  rawOutput: `HTTP/1.1 ${statusCode}`,
  statusCode,
  statusCodeName: statusCode === 200 ? 'OK' : 'Service Unavailable',
  timings: { total },
  tls: { authorized: true },
})

const finished = (
  results: { probe: GlobalpingProbe; result: GlobalpingResult }[],
): GlobalpingMeasurementResponse => ({ id: 'm-1', status: 'finished', results })

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })

/** Payload stub exposing only what `getInstanceSettings` reads. */
const payloadWithToken = (globalpingApiToken: string | null): Partial<Payload> =>
  ({
    findGlobal: vi.fn(async () => ({ globalpingApiToken })),
    logger: { warn: vi.fn() },
  }) as unknown as Partial<Payload>

const httpMonitor = (over: Partial<Monitor> = {}) =>
  makeMonitor({
    type: 'globalping',
    url: 'https://example.com/health?full=1',
    method: 'GET',
    acceptedStatusCodes: ['200-299'],
    globalpingMeasurement: 'http',
    globalpingLocations: 'Europe',
    globalpingProbes: 3,
    globalpingSuccessRule: 'atLeast',
    globalpingMinSuccess: 2,
    timeout: 5,
    ...over,
  })

/** Answers POST with a measurement id and GET with `measurement` (after `pending` in-progress polls). */
function mockApi(measurement: GlobalpingMeasurementResponse, pending = 0) {
  let polls = 0
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (init?.method === 'POST') return json({ id: 'm-1', probesCount: 3 }, { status: 202 })
    expect(url).toBe(`${GLOBALPING_API_URL}/measurements/m-1`)
    if (polls++ < pending) return json({ ...measurement, status: 'in-progress', results: [] })
    return json(measurement)
  })
}

describe('globalping monitor', () => {
  beforeEach(() => {
    resetInstanceSettingsCache()
    resetGlobalpingRateLimit()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    resetInstanceSettingsCache()
    resetGlobalpingRateLimit()
  })

  it('formats probe locations and API errors like Uptime Kuma', () => {
    expect(formatProbeLocation(AMS)).toBe(
      'Amsterdam, NL, EU, Net Amsterdam (AS1136), (aws-eu-amsterdam-1)',
    )
    expect(
      formatApiError(
        {
          type: 'validation_error',
          message: 'Parameter validation failed',
          params: { target: 'bad' },
        },
        400,
      ),
    ).toBe('validation_error Parameter validation failed. target: bad')
    expect(formatApiError(undefined, 502)).toBe('HTTP 502')
  })

  it('reads the reset time of a 429 from Retry-After or X-RateLimit-Reset', () => {
    expect(rateLimitResetSeconds(new Headers({ 'retry-after': '42' }))).toBe(42)
    expect(rateLimitResetSeconds(new Headers({ 'x-ratelimit-reset': '7.2' }))).toBe(8)
    expect(rateLimitResetSeconds(new Headers({ 'x-ratelimit-reset': '999999' }))).toBe(3600)
    expect(rateLimitResetSeconds(new Headers())).toBe(60)
  })

  it('builds the measurement request for each measurement type', () => {
    expect(buildMeasurementRequest(httpMonitor({ headers: '{"X-Probe":"1"}' }))).toEqual({
      type: 'http',
      target: 'example.com',
      inProgressUpdates: false,
      limit: 3,
      locations: [{ magic: 'Europe' }],
      measurementOptions: {
        request: {
          host: 'example.com',
          path: '/health',
          query: 'full=1',
          method: 'GET',
          headers: { 'X-Probe': '1' },
        },
        protocol: 'HTTPS',
      },
    })
    const ping = buildMeasurementRequest(
      makeMonitor({
        type: 'globalping',
        hostname: 'example.com',
        port: 443,
        globalpingMeasurement: 'ping',
        globalpingLocations: 'US+AWS, AS13335',
        globalpingProbes: 2,
        globalpingProtocol: 'TCP',
        globalpingPackets: 5,
        globalpingIpVersion: '6',
      }),
    )
    expect(ping).toMatchObject({
      type: 'ping',
      target: 'example.com',
      limit: 2,
      locations: [{ magic: 'US+AWS' }, { magic: 'AS13335' }],
      measurementOptions: { packets: 5, protocol: 'TCP', port: 443, ipVersion: 6 },
    })
    const dns = buildMeasurementRequest(
      makeMonitor({
        type: 'globalping',
        hostname: 'example.com',
        globalpingMeasurement: 'dns',
        dnsResolveType: 'MX',
        dnsResolveServer: '9.9.9.9, 1.1.1.1',
      }),
    )
    expect(dns).not.toHaveProperty('locations')
    expect(dns.measurementOptions).toEqual({ query: { type: 'MX' }, resolver: '9.9.9.9' })
    const trace = buildMeasurementRequest(
      makeMonitor({
        type: 'globalping',
        hostname: 'example.com',
        port: 80,
        globalpingMeasurement: 'traceroute',
        globalpingProtocol: 'ICMP',
      }),
    )
    expect(trace.measurementOptions).toEqual({ protocol: 'ICMP' })
  })

  it('applies the status rule and reports each probe with its latency', () => {
    const measurement = finished([
      { probe: AMS, result: httpResult(200, 120) },
      { probe: FRA, result: httpResult(503, 80) },
      { probe: PAR, result: httpResult(200, 140) },
    ])
    const atLeastTwo = evaluateMeasurement(httpMonitor(), measurement)
    expect(atLeastTwo.up).toBe(true)
    expect(atLeastTwo.ping).toBe(130)
    expect(atLeastTwo.msg).toMatch(/^2\/3 probes succeeded \(2 required\) — Amsterdam/)
    expect(atLeastTwo.probes).toEqual([
      expect.objectContaining({ ok: true, latency: 120, msg: '200 OK, 120 ms' }),
      expect.objectContaining({
        ok: false,
        latency: 80,
        msg: 'Status code 503 Service Unavailable not accepted',
      }),
      expect.objectContaining({ ok: true, latency: 140 }),
    ])
    expect(evaluateMeasurement(httpMonitor({ globalpingSuccessRule: 'all' }), measurement).up).toBe(
      false,
    )
    expect(evaluateMeasurement(httpMonitor({ globalpingSuccessRule: 'any' }), measurement).up).toBe(
      true,
    )
    expect(evaluateMeasurement(httpMonitor(), finished([])).msg).toMatch(/No Globalping probe/)
  })

  it('judges ping, DNS and traceroute probes', () => {
    const ping = makeMonitor({ type: 'globalping', globalpingMeasurement: 'ping' })
    const pingVerdict = evaluateMeasurement(
      ping,
      finished([
        {
          probe: AMS,
          result: { status: 'finished', stats: { avg: 12.34, loss: 0, rcv: 3 } },
        },
        { probe: FRA, result: { status: 'finished', stats: { avg: null, loss: 100, rcv: 0 } } },
        { probe: PAR, result: { status: 'offline' } },
      ]),
    )
    expect(pingVerdict.probes.map((p) => [p.ok, p.msg])).toEqual([
      [true, '12.3 ms, 0% loss'],
      [false, '100% packet loss'],
      [false, 'Probe went offline'],
    ])
    expect(pingVerdict.up).toBe(false)

    const dns = makeMonitor({ type: 'globalping', globalpingMeasurement: 'dns' })
    const dnsVerdict = evaluateMeasurement(
      dns,
      finished([
        {
          probe: AMS,
          result: {
            status: 'finished',
            answers: [{ value: '93.184.215.14' }],
            timings: { total: 15 },
          },
        },
        {
          probe: FRA,
          result: {
            status: 'finished',
            answers: [],
            statusCodeName: 'NXDOMAIN',
            timings: { total: 9 },
          },
        },
      ]),
    )
    expect(dnsVerdict.probes.map((p) => p.msg)).toEqual([
      '93.184.215.14',
      'No records found (NXDOMAIN)',
    ])

    const trace = makeMonitor({ type: 'globalping', globalpingMeasurement: 'traceroute' })
    const traceVerdict = evaluateMeasurement(
      trace,
      finished([
        {
          probe: AMS,
          result: {
            status: 'finished',
            resolvedAddress: '93.184.215.14',
            hops: [
              { resolvedAddress: '10.0.0.1', timings: [{ rtt: 1 }] },
              { resolvedAddress: '93.184.215.14', timings: [{ rtt: 20 }, { rtt: 22 }] },
            ],
          },
        },
        {
          probe: FRA,
          result: {
            status: 'finished',
            resolvedAddress: '93.184.215.14',
            hops: [{ resolvedAddress: '10.0.0.1', timings: [{ rtt: 1 }] }, { timings: [] }],
          },
        },
      ]),
    )
    expect(traceVerdict.probes.map((p) => [p.ok, p.msg])).toEqual([
      [true, '2 hops, 21 ms'],
      [false, 'Destination not reached after 2 hops'],
    ])
  })

  it('goes DOWN when the configured majority of three European probes fails', async () => {
    mockApi(
      finished([
        { probe: AMS, result: httpResult(200, 120) },
        { probe: FRA, result: httpResult(503, 80) },
        { probe: PAR, result: httpResult(503, 90) },
      ]),
      1,
    )
    await expect(runCheck(httpMonitor(), { payload: payloadWithToken(null) })).rejects.toThrow(
      /^1\/3 probes succeeded \(2 required\)/,
    )
  })

  it('is UP with the average latency and the measurement id, sending the instance token', async () => {
    const fetchSpy = mockApi(
      finished([
        { probe: AMS, result: httpResult(200, 100) },
        { probe: FRA, result: httpResult(200, 200) },
        { probe: PAR, result: httpResult(503, 90) },
      ]),
    )
    const beat = await runCheck(httpMonitor(), { payload: payloadWithToken('gp-token') })
    expect(beat.status).toBe('up')
    expect(beat.ping).toBe(150)
    expect(beat.globalpingMeasurementId).toBe('m-1')
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe(`${GLOBALPING_API_URL}/measurements`)
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer gp-token')
    expect(JSON.parse(String(init?.body))).toMatchObject({ type: 'http', limit: 3 })
  })

  it('calls the API anonymously without a token', async () => {
    const fetchSpy = mockApi(finished([{ probe: AMS, result: httpResult(200, 100) }]))
    await runCheck(httpMonitor({ globalpingSuccessRule: 'all' }), {
      payload: payloadWithToken(null),
    })
    for (const [, init] of fetchSpy.mock.calls) {
      expect(init?.headers as Record<string, string>).not.toHaveProperty('Authorization')
    }
  })

  it('defers on 429 and backs off without calling the API until the reset', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        json(
          { error: { type: 'too_many_requests', message: 'Too many requests' } },
          { status: 429, headers: { 'retry-after': '120' } },
        ),
      )
    const first = runCheck(httpMonitor(), { payload: payloadWithToken(null) })
    await expect(first).rejects.toSatisfy(isCheckDeferredError)
    await expect(first).rejects.toThrow(/rate limit reached \(429\).*Checks resume in 120 s/)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    await expect(runCheck(httpMonitor(), { payload: payloadWithToken(null) })).rejects.toThrow(
      /Checks resume in 1[12]\d s/,
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // A token has its own limit: the anonymous back-off does not apply to it.
    resetInstanceSettingsCache()
    await expect(
      runCheck(httpMonitor(), { payload: payloadWithToken('gp-token') }),
    ).rejects.toThrow(/API token has run out of credits/)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('retries a 500 once and defers when the API stays unavailable', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => json({}, { status: 500 }))
    await expect(runCheck(httpMonitor(), { payload: payloadWithToken(null) })).rejects.toSatisfy(
      isCheckDeferredError,
    )
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('fails (not deferred) on validation errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(
        {
          error: {
            type: 'no_probes_found',
            message: 'No suitable probes supporting IPv6 found',
          },
        },
        { status: 422 },
      ),
    )
    const check = runCheck(httpMonitor(), { payload: payloadWithToken(null) })
    await expect(check).rejects.toThrow(
      'Globalping create measurement failed: no_probes_found No suitable probes supporting IPv6 found.',
    )
    await expect(check).rejects.not.toSatisfy(isCheckDeferredError)
  })
})
