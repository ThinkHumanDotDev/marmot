/**
 * Globalping monitor (#142): runs a ping, HTTP, DNS or traceroute measurement from Globalping
 * community probes (https://globalping.io) in the configured locations and judges it with a status
 * rule (all, any or at least N probes must succeed). Each probe's location, outcome and latency go
 * into the heartbeat message and `heartbeats.probes`; the heartbeat's `ping` is the average latency
 * of the successful probes.
 *
 * The API is called directly (`POST /v1/measurements`, then `GET /v1/measurements/:id` until it is
 * finished) with the `globalpingApiToken` instance setting as bearer token when it is set, and
 * anonymously otherwise. Rate limits never flip a monitor DOWN: a 429 throws `CheckDeferredError`
 * (a held PENDING beat with the reason) and further checks with the same credentials are deferred
 * without calling the API until the reset time the API announced. The same applies when the API
 * itself is unavailable (5xx after one retry, network errors): that says nothing about the target.
 *
 * The request shapes, the retry after a 500, the API error and "out of credits" messages and the
 * probe location format are ported from Uptime Kuma 2.x `server/monitor-types/globalping.js` —
 * Copyright (c) 2021 Louis Lam, MIT License. See THIRD_PARTY_NOTICES.md. Multiple probes, the status
 * rule, traceroute and the rate-limit back-off are Marmot additions.
 */
import { createHash } from 'node:crypto'

import {
  GLOBALPING_DEFAULT_PACKETS,
  GLOBALPING_DEFAULT_PROBES,
  isGlobalpingMeasurement,
  parseGlobalpingLocations,
  requiredGlobalpingSuccesses,
  type GlobalpingMeasurement,
} from '@/lib/validation/globalping'
import { parseHeadersJson } from '@/lib/validation/monitor'
import type { Monitor } from '@/payload-types'
import { getInstanceSettings } from '@/server/settings'

import { checkStatusCode } from './http-request'
import { registerMonitorType } from './registry'
import { CheckDeferredError, type MonitorCheckContext, type ProbeResult } from './types'
import { errorMessage, requireHostname, responseExcerpt } from './util'

export const GLOBALPING_API_URL = 'https://api.globalping.io/v1'
export const GLOBALPING_CREDITS_URL = 'https://dash.globalping.io?view=add-credits'
const USER_AGENT = 'Marmot (+https://github.com/thinkhumandotdev/marmot)'

/** Delay between polls of an unfinished measurement (Globalping recommends 500 ms). */
export const GLOBALPING_POLL_INTERVAL_MS = 500
/** Back-off after a 429 that announced no reset time. */
export const GLOBALPING_DEFAULT_BACKOFF_SECONDS = 60
/** Longest back-off honoured, whatever the API announces. */
export const GLOBALPING_MAX_BACKOFF_SECONDS = 3600
/** Probes listed one by one in the heartbeat message; the rest are counted. */
const MESSAGE_PROBES = 10

// ---- Rate-limit back-off -------------------------------------------------------------------------

/** `Date.now()` until which checks with given credentials are deferred, per credentials key. */
const backoffUntil = new Map<string, number>()

/** Back-off key: the anonymous limit is per IP, a token's limit per token (never kept in clear). */
const credentialsKey = (token: string | null) =>
  token ? `token:${createHash('sha256').update(token).digest('hex').slice(0, 16)}` : 'anonymous'

/** Forget every back-off (tests). */
export function resetGlobalpingRateLimit(): void {
  backoffUntil.clear()
}

/** Seconds until the limit resets, from `Retry-After` or `X-RateLimit-Reset` (both in seconds). */
export function rateLimitResetSeconds(headers: Headers): number {
  for (const name of ['retry-after', 'x-ratelimit-reset']) {
    const value = Number(headers.get(name))
    if (headers.get(name) !== null && Number.isFinite(value) && value > 0) {
      return Math.min(Math.ceil(value), GLOBALPING_MAX_BACKOFF_SECONDS)
    }
  }
  return GLOBALPING_DEFAULT_BACKOFF_SECONDS
}

/** Port of `formatTooManyRequestsError`, plus when the checks resume. */
export function rateLimitMessage(hasToken: boolean, seconds: number): string {
  const advice = hasToken
    ? `The Globalping API token has run out of credits. Get higher limits by sponsoring Globalping or hosting probes: ${GLOBALPING_CREDITS_URL}.`
    : `Anonymous Globalping checks have run out of credits. Set a Globalping API token in the instance settings for higher limits: ${GLOBALPING_CREDITS_URL}.`
  return `Globalping rate limit reached (429). ${advice} Checks resume in ${seconds} s; the monitor stays pending meanwhile.`
}

// ---- API types (the parts Marmot reads) ----------------------------------------------------------

export interface GlobalpingProbe {
  continent?: string
  region?: string
  country?: string
  state?: string | null
  city?: string
  asn?: number
  network?: string
  tags?: string[]
}

interface GlobalpingTimings {
  total?: number | null
}

export interface GlobalpingResult {
  status: 'in-progress' | 'finished' | 'failed' | 'offline'
  rawOutput?: string | null
  resolvedAddress?: string | null
  // ping
  stats?: {
    min?: number | null
    avg?: number | null
    max?: number | null
    loss?: number
    rcv?: number
  }
  // http
  statusCode?: number | null
  statusCodeName?: string | null
  tls?: { authorized?: boolean; error?: string } | null
  // http and dns
  timings?: GlobalpingTimings | { rtt?: number | null }[] | null
  // dns
  answers?: { value?: string; type?: string }[]
  // traceroute
  hops?: { resolvedAddress?: string | null; timings?: { rtt?: number | null }[] }[]
}

export interface GlobalpingMeasurementResponse {
  id: string
  status: 'in-progress' | 'finished'
  results?: { probe: GlobalpingProbe; result: GlobalpingResult }[]
}

interface GlobalpingApiError {
  type?: string
  message?: string
  params?: Record<string, unknown>
}

// ---- Formatting (ported) -------------------------------------------------------------------------

/** Port of `formatApiError`: `validation_error Parameter validation failed. target: …`. */
export function formatApiError(error: GlobalpingApiError | undefined, status: number): string {
  if (!error?.type && !error?.message) return `HTTP ${status}`
  let text = `${error.type ?? `HTTP ${status}`} ${error.message ?? ''}`.trim()
  if (!text.endsWith('.')) text += '.'
  for (const [key, value] of Object.entries(error.params ?? {})) text += ` ${key}: ${String(value)}`
  return text
}

/**
 * Port of `formatProbeLocation`: `Ashburn (VA), US, NA, Amazon.com (AS14618), (aws-us-east-1)`.
 * A tag ending in a digit is likely a cloud region and is shown.
 */
export function formatProbeLocation(probe: GlobalpingProbe): string {
  const tag = (probe.tags ?? []).find((t) => Number.isInteger(Number(t.slice(-1))))
  return `${probe.city ?? '?'}${probe.state ? ` (${probe.state})` : ''}, ${probe.country ?? '?'}, ${
    probe.continent ?? '?'
  }, ${probe.network ?? '?'} (AS${probe.asn ?? '?'})${tag ? `, (${tag})` : ''}`
}

const ms = (value: number) => `${Math.round(value * 10) / 10} ms`
const average = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length

// ---- Request -------------------------------------------------------------------------------------

/** Body of `POST /v1/measurements` for the monitor. */
export function buildMeasurementRequest(monitor: Monitor): Record<string, unknown> {
  const measurement: GlobalpingMeasurement = isGlobalpingMeasurement(monitor.globalpingMeasurement)
    ? monitor.globalpingMeasurement
    : 'http'
  const protocol = monitor.globalpingProtocol ?? undefined
  const ipVersion = monitor.globalpingIpVersion ? Number(monitor.globalpingIpVersion) : undefined
  const options: Record<string, unknown> = {}
  let target: string

  if (measurement === 'http') {
    if (!monitor.url) throw new Error('URL is required')
    let url: URL
    try {
      url = new URL(monitor.url)
    } catch {
      throw new Error(`Invalid URL: ${monitor.url}`)
    }
    target = url.hostname.replace(/^\[|\]$/g, '')
    const headers = parseHeadersJson(monitor.headers)
    options.request = {
      host: url.hostname,
      path: url.pathname,
      ...(url.search ? { query: url.search.slice(1) } : {}),
      method: monitor.method ?? 'GET',
      ...(headers ? { headers } : {}),
    }
    options.protocol = protocol ?? (url.protocol === 'https:' ? 'HTTPS' : 'HTTP')
    if (url.port) options.port = Number(url.port)
    const resolver = monitor.dnsResolveServer?.split(',')[0]?.trim()
    if (resolver) options.resolver = resolver
  } else {
    target = requireHostname(monitor)
    if (protocol) options.protocol = protocol
    if (measurement === 'ping') {
      options.packets = monitor.globalpingPackets ?? GLOBALPING_DEFAULT_PACKETS
      if (protocol === 'TCP' && monitor.port) options.port = monitor.port
    } else if (measurement === 'dns') {
      options.query = { type: monitor.dnsResolveType ?? 'A' }
      const resolver = monitor.dnsResolveServer?.split(',')[0]?.trim()
      if (resolver) options.resolver = resolver
      if (monitor.port) options.port = monitor.port
    } else if (measurement === 'traceroute') {
      if (protocol && protocol !== 'ICMP' && monitor.port) options.port = monitor.port
    }
  }
  if (ipVersion) options.ipVersion = ipVersion

  const locations = parseGlobalpingLocations(monitor.globalpingLocations)
  return {
    type: measurement,
    target,
    inProgressUpdates: false,
    limit: monitor.globalpingProbes ?? GLOBALPING_DEFAULT_PROBES,
    ...(locations.length ? { locations: locations.map((magic) => ({ magic })) } : {}),
    measurementOptions: options,
  }
}

// ---- Evaluation ----------------------------------------------------------------------------------

/** Judges one probe's result for the measurement type. */
export function evaluateProbe(
  measurement: GlobalpingMeasurement,
  probe: GlobalpingProbe,
  result: GlobalpingResult,
  monitor: Pick<Monitor, 'acceptedStatusCodes' | 'ignoreTls'>,
): ProbeResult {
  const location = formatProbeLocation(probe)
  const fail = (msg: string, latency: number | null = null): ProbeResult => ({
    location,
    ok: false,
    latency,
    msg,
  })
  if (result.status === 'offline') return fail('Probe went offline')
  if (result.status !== 'finished') {
    return fail(`Failed: ${responseExcerpt((result.rawOutput ?? result.status).trim())}`)
  }
  const totalTime = (): number | null => {
    const timings = result.timings
    if (!timings || Array.isArray(timings)) return null
    return typeof timings.total === 'number' ? timings.total : null
  }

  switch (measurement) {
    case 'ping': {
      const stats = result.stats ?? {}
      if (!stats.rcv || stats.loss === 100 || typeof stats.avg !== 'number') {
        return fail('100% packet loss')
      }
      return {
        location,
        ok: true,
        latency: stats.avg,
        msg: `${ms(stats.avg)}, ${stats.loss ?? 0}% loss`,
      }
    }
    case 'http': {
      const latency = totalTime()
      const code = result.statusCode
      if (typeof code !== 'number') return fail('No response', latency)
      const status = `${code}${result.statusCodeName ? ` ${result.statusCodeName}` : ''}`
      if (!checkStatusCode(code, monitor.acceptedStatusCodes ?? ['200-299'])) {
        return fail(`Status code ${status} not accepted`, latency)
      }
      if (result.tls && result.tls.authorized === false && !monitor.ignoreTls) {
        return fail(
          `TLS certificate is not trusted: ${result.tls.error ?? 'unknown error'}`,
          latency,
        )
      }
      return {
        location,
        ok: true,
        latency,
        msg: latency === null ? status : `${status}, ${ms(latency)}`,
      }
    }
    case 'dns': {
      const latency = totalTime()
      const values = (result.answers ?? []).map((a) => a.value).filter(Boolean) as string[]
      if (values.length === 0) {
        return fail(
          `No records found${result.statusCodeName ? ` (${result.statusCodeName})` : ''}`,
          latency,
        )
      }
      return { location, ok: true, latency, msg: responseExcerpt(values.join(' | '), 100) }
    }
    case 'traceroute': {
      const hops = result.hops ?? []
      const last = hops.at(-1)
      const rtts = (last?.timings ?? [])
        .map((t) => t.rtt)
        .filter((v): v is number => typeof v === 'number')
      const reached =
        Boolean(last?.resolvedAddress) &&
        (!result.resolvedAddress || last?.resolvedAddress === result.resolvedAddress) &&
        rtts.length > 0
      if (!reached) return fail(`Destination not reached after ${hops.length} hops`)
      const latency = average(rtts)
      return { location, ok: true, latency, msg: `${hops.length} hops, ${ms(latency)}` }
    }
  }
}

export interface GlobalpingVerdict {
  up: boolean
  msg: string
  /** Average latency of the successful probes, or null. */
  ping: number | null
  probes: ProbeResult[]
}

/** Applies the status rule to a finished measurement. */
export function evaluateMeasurement(
  monitor: Monitor,
  measurement: GlobalpingMeasurementResponse,
): GlobalpingVerdict {
  const type: GlobalpingMeasurement = isGlobalpingMeasurement(monitor.globalpingMeasurement)
    ? monitor.globalpingMeasurement
    : 'http'
  const probes = (measurement.results ?? []).map(({ probe, result }) =>
    evaluateProbe(type, probe ?? {}, result ?? { status: 'failed' }, monitor),
  )
  if (probes.length === 0) {
    return {
      up: false,
      msg: 'No Globalping probe took part in the measurement; check the locations',
      ping: null,
      probes,
    }
  }
  const succeeded = probes.filter((p) => p.ok)
  const required = requiredGlobalpingSuccesses(
    monitor.globalpingSuccessRule,
    monitor.globalpingMinSuccess,
    probes.length,
  )
  const latencies = succeeded.map((p) => p.latency).filter((v): v is number => v !== null)
  const ping = latencies.length ? Math.round(average(latencies) * 10) / 10 : null
  const listed = probes
    .slice(0, MESSAGE_PROBES)
    .map((p) => `${p.location}: ${p.ok ? '' : '✗ '}${p.msg}`)
  if (probes.length > MESSAGE_PROBES) listed.push(`and ${probes.length - MESSAGE_PROBES} more`)
  const summary = `${succeeded.length}/${probes.length} probes succeeded${
    required === probes.length ? '' : ` (${required} required)`
  }`
  return {
    up: succeeded.length >= required,
    msg: `${summary} — ${listed.join('; ')}`,
    ping,
    probes,
  }
}

// ---- API calls -----------------------------------------------------------------------------------

const sleep = (msDelay: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, msDelay)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

interface ApiContext {
  token: string | null
  signal: AbortSignal
}

/** `fetch` against the API; network failures (not timeouts) defer the check. */
async function callApi(path: string, init: RequestInit, api: ApiContext): Promise<Response> {
  try {
    return await fetch(`${GLOBALPING_API_URL}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        ...(api.token ? { Authorization: `Bearer ${api.token}` } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: api.signal,
    })
  } catch (err) {
    if (api.signal.aborted) throw err
    const cause = (err as { cause?: unknown })?.cause
    throw new CheckDeferredError(
      `Globalping API unreachable (${cause instanceof Error ? cause.message : errorMessage(err)}); the check runs again at the next interval.`,
    )
  }
}

/** Turns a non-2xx answer into the right error: deferred for 429/5xx, a failure otherwise. */
async function apiFailure(res: Response, what: string, api: ApiContext): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: GlobalpingApiError }
  if (res.status === 429) {
    const seconds = rateLimitResetSeconds(res.headers)
    backoffUntil.set(credentialsKey(api.token), Date.now() + seconds * 1000)
    return new CheckDeferredError(rateLimitMessage(Boolean(api.token), seconds))
  }
  const detail = formatApiError(body.error, res.status)
  if (res.status >= 500) {
    return new CheckDeferredError(
      `Globalping API unavailable (${what}: ${detail}); the check runs again at the next interval.`,
    )
  }
  return new Error(`Globalping ${what} failed: ${detail}`)
}

/** Creates the measurement (retrying once after a 500, as Uptime Kuma does) and returns its id. */
export async function createMeasurement(
  body: Record<string, unknown>,
  api: ApiContext,
): Promise<string> {
  const post = () =>
    callApi(
      '/measurements',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      api,
    )
  let res = await post()
  if (res.status === 500) res = await post()
  if (!res.ok) throw await apiFailure(res, 'create measurement', api)
  const data = (await res.json().catch(() => ({}))) as { id?: string }
  if (!data.id) throw new Error('Globalping create measurement failed: no measurement id returned')
  return data.id
}

/** Polls the measurement until it is finished (or the check's signal aborts). */
export async function awaitMeasurement(
  id: string,
  api: ApiContext,
): Promise<GlobalpingMeasurementResponse> {
  for (;;) {
    const res = await callApi(`/measurements/${encodeURIComponent(id)}`, { method: 'GET' }, api)
    if (!res.ok) throw await apiFailure(res, `fetch measurement ${id}`, api)
    const data = (await res.json()) as GlobalpingMeasurementResponse
    if (data.status !== 'in-progress') return data
    await sleep(GLOBALPING_POLL_INTERVAL_MS, api.signal)
  }
}

async function check(ctx: MonitorCheckContext): Promise<void> {
  const { monitor } = ctx
  const body = buildMeasurementRequest(monitor)
  const { globalpingApiToken } = await getInstanceSettings(ctx.payload)
  const api: ApiContext = { token: globalpingApiToken, signal: ctx.signal }

  const until = backoffUntil.get(credentialsKey(api.token))
  if (until !== undefined) {
    const seconds = Math.ceil((until - Date.now()) / 1000)
    if (seconds > 0) throw new CheckDeferredError(rateLimitMessage(Boolean(api.token), seconds))
    backoffUntil.delete(credentialsKey(api.token))
  }

  const id = await createMeasurement(body, api)
  ctx.heartbeat.globalpingMeasurementId = id
  const measurement = await awaitMeasurement(id, api)
  const verdict = evaluateMeasurement(monitor, measurement)
  ctx.probes = verdict.probes
  ctx.heartbeat.ping = verdict.ping
  if (!verdict.up) throw new Error(verdict.msg)
  ctx.heartbeat.status = 'up'
  ctx.heartbeat.msg = verdict.msg
}

registerMonitorType({
  name: 'globalping',
  label: 'Globalping',
  group: 'general',
  check,
})
