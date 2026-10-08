/**
 * Simulated checks for demo mode (#159). A demo instance never connects to a monitor's target: the
 * worker (and the simulated probe locations) ask this module instead, and the history back-fill
 * uses the very same function, so live beats continue the seeded charts seamlessly.
 *
 * Outcomes are a pure function of the monitor key, the location and the minute: deterministic
 * (the same dataset after every reset, stable tests) yet noisy enough for percentiles (#95),
 * request timing (#94) and per-location latency (#92) to look like a real service. Response times
 * are log-normal around the profile's latency with a business-hours swell; outages and slow
 * periods recur on the profile's schedule, offset per monitor so they do not line up.
 *
 * Kept free of Payload and the database: it runs in the check path.
 */
import type { RequestTiming } from '@/lib/request-timing'
import type { Monitor } from '@/payload-types'
import type { CheckResult } from '@/server/engine/beat'

import { DEFAULT_PROFILE, DEMO_LOCATIONS, demoProfileFor, type DemoProfile } from './dataset'

/** Types that never leave the instance anyway: they keep running their real check. */
const INTERNAL_TYPES = new Set<string>(['push', 'manual', 'group'])

/** Whether demo mode replaces this type's check with a simulated one. */
export const isSimulatedType = (type: string | null | undefined): boolean =>
  Boolean(type) && !INTERNAL_TYPES.has(type as string)

const HTTP_TYPES = new Set<string>(['http', 'keyword', 'json-query', 'websocket-upgrade'])

/** FNV-1a: a small, stable string hash. */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32 seeded with `seed`: uniform floats in [0, 1). */
function random(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const inWindow = (minute: number, offset: number, every: number, length: number) =>
  (((minute + offset) % every) + every) % every < length

export interface SimulatedOutcome {
  ok: boolean
  /** Response time in ms (successful checks only). */
  ping: number | null
  msg: string
  /** Request timing phases of HTTP checks (#94). */
  timing: RequestTiming | null
  /** HTTP status code of HTTP checks. */
  statusCode: number | null
}

export interface SimulateInput {
  /** Monitor key (seeded monitors) or any stable identifier (`monitor:<id>`). */
  key: string
  type: string
  profile: DemoProfile
  time: Date
  /** Location slug (probe locations add their network latency). */
  location?: string | null
  /** The URL starts with https:// (adds a TLS phase). */
  secure?: boolean
}

/** One simulated check at `time`. */
export function simulateOutcome({
  key,
  type,
  profile,
  time,
  location = null,
  secure = true,
}: SimulateInput): SimulatedOutcome {
  const minute = Math.floor(time.getTime() / 60_000)
  const rand = random(hash(`${key}|${location ?? 'local'}|${minute}`))
  const offset = hash(key) % 1440
  const http = HTTP_TYPES.has(type)

  if (
    profile.outage &&
    inWindow(minute, offset, profile.outage.everyMinutes, profile.outage.forMinutes)
  ) {
    return { ok: false, ping: null, msg: profile.outage.message, timing: null, statusCode: null }
  }
  if (rand() < profile.errorRate) {
    const msg = profile.failure ?? DEFAULT_PROFILE.failure ?? 'Check failed'
    return { ok: false, ping: null, msg, timing: null, statusCode: null }
  }

  // Box-Muller: a standard normal sample for the log-normal response time.
  const u1 = Math.max(rand(), 1e-9)
  const u2 = rand()
  const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  const hourOfDay = (time.getUTCHours() + time.getUTCMinutes() / 60) % 24
  const businessHours = 1 + 0.25 * Math.max(0, Math.sin(((hourOfDay - 6) / 14) * Math.PI))
  const slow =
    profile.slowdown &&
    inWindow(minute, offset, profile.slowdown.everyMinutes, profile.slowdown.forMinutes)
      ? profile.slowdown.factor
      : 1
  // Rare spikes give the p99 a tail.
  const spike = rand() < 0.015 ? 2.5 + rand() * 3 : 1
  const network = DEMO_LOCATIONS.find((l) => l.slug === location)?.latency ?? 0
  const ping = Math.max(
    1,
    Math.round(
      (profile.latency * Math.exp(profile.spread * normal) * businessHours * slow * spike +
        network) *
        10,
    ) / 10,
  )

  if (!http) {
    return { ok: true, ping, msg: okMessage(type), timing: null, statusCode: null }
  }

  // Split the response time into request phases (#94), leaving the server's share to the TTFB.
  const share = (min: number, spread: number) => min + rand() * spread
  const round = (value: number) => Math.round(value * 10) / 10
  const dns = round(ping * share(0.02, 0.06))
  const connect = round(ping * share(0.06, 0.08) + network * 0.3)
  const tls = secure ? round(ping * share(0.1, 0.1) + network * 0.3) : null
  const transfer = round(ping * share(0.02, 0.05))
  const ttfb = round(Math.max(0.1, ping - dns - connect - (tls ?? 0) - transfer))
  return {
    ok: true,
    ping,
    msg: '200 - OK',
    timing: { dns, connect, tls, ttfb, transfer },
    statusCode: 200,
  }
}

function okMessage(type: string): string {
  switch (type) {
    case 'postgres':
    case 'mysql':
    case 'sqlserver':
    case 'mongodb':
    case 'redis':
      return 'Query OK'
    case 'dns':
      return 'Records: 192.0.2.10'
    case 'smtp':
      return '250 OK'
    default:
      return 'OK'
  }
}

/** Monitor fields the simulator reads. */
export type SimulatedMonitor = Pick<Monitor, 'id' | 'key' | 'type' | 'url'>

const monitorKey = (monitor: SimulatedMonitor) => monitor.key || `monitor:${String(monitor.id)}`

/**
 * The simulated check of `monitor` as the state machine's `CheckResult`. Monitors visitors add get
 * the default profile and a message that says the check was simulated.
 */
export function simulateCheck(
  monitor: SimulatedMonitor,
  time: Date = new Date(),
  location: string | null = null,
): CheckResult {
  const seeded = demoProfileFor(monitor.key)
  const outcome = simulateOutcome({
    key: monitorKey(monitor),
    type: monitor.type,
    profile: seeded ?? DEFAULT_PROFILE,
    time,
    location,
    secure: !monitor.url || /^(https|wss):/i.test(monitor.url),
  })
  const msg = seeded ? outcome.msg : `${outcome.msg} (simulated: demo instances never connect)`
  if (!outcome.ok) return { ok: false, msg, ping: null, timing: null }
  return {
    ok: true,
    status: 'up',
    msg,
    ping: outcome.ping,
    timing: outcome.timing,
    response: outcome.statusCode
      ? {
          statusCode: outcome.statusCode,
          headers: { 'content-type': 'application/json' },
          headersTruncated: false,
          body: null,
          bodyTruncated: false,
        }
      : null,
    details: outcome.statusCode ? { statusCode: outcome.statusCode } : {},
  }
}
