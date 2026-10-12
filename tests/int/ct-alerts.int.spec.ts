/**
 * Certificate transparency alerts (#143): the `ct-alerts` job takes a baseline, announces each new
 * certificate of a watched hostname exactly once through the channels that accept the
 * `certificate` event, flags unexpected issuers and backs off when the source fails. The CT source
 * (crt.sh) is a stub; nothing leaves the test.
 */
import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import config from '@payload-config'
import type { Monitor, Notification, Organization } from '@/payload-types'
import {
  createCtFetcher,
  CT_BACKOFF_BASE_MS,
  runCtAlerts,
  type CtRunOptions,
  type CtSourceHealth,
} from '@/server/jobs/ct-alerts'
import { createPayloadSentHistory } from '@/server/jobs/expiry-history'
import { registerNotificationProvider } from '@/server/notification-providers'
import type { NotificationSendContext } from '@/server/notification-providers/types'

let payload: Payload
let org: Organization

const run = Date.now().toString(36)
const SOURCE = 'https://crt.test/?q={query}&output=json'
const INTERVAL_MINUTES = 60
const T0 = new Date('2026-10-01T12:00:00.000Z')
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000)
/** crt.sh prints UTC timestamps without a zone. */
const crtTime = (date: Date) => date.toISOString().replace('Z', '')

const captured: NotificationSendContext[] = []
const CAPTURE = `ct-capture-${run}`
registerNotificationProvider({
  name: CAPTURE,
  label: 'Capture',
  group: 'generic',
  configSchema: z.object({}),
  async send(ctx) {
    captured.push(ctx)
    return 'ok'
  },
})

/** What the stub CT source knows, per crt.sh identity (`example.com`, `%.example.com`). */
let logs: Map<string, Record<string, unknown>[]>
let sourceCalls: string[]
let sourceAnswer: (() => Response) | null

const fetchImpl = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === 'string' ? input : input.toString())
  sourceCalls.push(url.toString())
  if (sourceAnswer) return sourceAnswer()
  return Response.json(logs.get(url.searchParams.get('q') ?? '') ?? [])
}) as unknown as typeof fetch

let serial = 0
function logCertificate(
  identity: string,
  names: string[],
  loggedAt: Date,
  issuer = "C=US, O=Let's Encrypt, CN=R11",
) {
  serial += 1
  const entry = {
    issuer_ca_id: 1,
    issuer_name: issuer,
    common_name: names[0],
    name_value: names.join('\n'),
    id: 1_000 + serial,
    entry_timestamp: crtTime(loggedAt),
    not_before: crtTime(new Date(loggedAt.getTime() - 3_600_000)),
    not_after: crtTime(new Date(loggedAt.getTime() + 90 * 86_400_000)),
    serial_number: `0abc${serial.toString(16)}`,
  }
  logs.set(identity, [...(logs.get(identity) ?? []), entry])
  return entry
}

let health: CtSourceHealth
const sleep = vi.fn(async () => undefined)

const ctRun = (now: Date, options: Partial<CtRunOptions> = {}) =>
  runCtAlerts(payload, {
    now,
    sourceUrl: SOURCE,
    intervalMinutes: INTERVAL_MINUTES,
    health,
    fetcher: createCtFetcher({ fetchImpl, requestsPerMinute: 6, sleep }),
    ...options,
  })

async function channel(name: string, data: Partial<Notification> = {}): Promise<Notification> {
  return (await payload.create({
    collection: 'notifications',
    overrideAccess: true,
    depth: 0,
    data: {
      organization: org.id,
      name: `${name}-${run}`,
      type: CAPTURE,
      config: {},
      active: true,
      ...data,
    } as never,
  })) as Notification
}

const created: (string | number)[] = []

async function createMonitor(data: Partial<Monitor> & { name: string }): Promise<Monitor> {
  const monitor = (await payload.create({
    collection: 'monitors',
    overrideAccess: true,
    depth: 0,
    context: { skipEngineSync: true, explicitNotifications: true },
    data: {
      organization: org.id,
      type: 'http',
      interval: 60,
      ctAlerts: true,
      ...data,
    } as RequiredDataFromCollectionSlug<'monitors'>,
  })) as Monitor
  created.push(monitor.id)
  return monitor
}

const reload = async (id: string | number) =>
  (await payload.findByID({
    collection: 'monitors',
    id,
    depth: 0,
    overrideAccess: true,
  })) as Monitor

const ctRows = async (monitorId: string | number) =>
  (
    await payload.find({
      collection: 'notification-sent-history',
      where: { and: [{ monitor: { equals: monitorId } }, { type: { equals: 'ct' } }] },
      depth: 0,
      overrideAccess: true,
    })
  ).docs

const outcomeOf = (result: Awaited<ReturnType<typeof ctRun>>, monitor: Monitor) =>
  result.monitors.find((m) => m.monitorId === String(monitor.id))

beforeAll(async () => {
  payload = await getPayload({ config })
  org = await payload.create({
    collection: 'organizations',
    data: { name: 'CT alerts', slug: `ct-alerts-${run}` },
  })
})

beforeEach(() => {
  logs = new Map()
  sourceCalls = []
  sourceAnswer = null
  health = { failures: 0, pausedUntil: 0 }
  captured.length = 0
  sleep.mockClear()
})

afterEach(async () => {
  for (const id of created.splice(0)) {
    await payload.delete({ collection: 'monitors', id, overrideAccess: true })
  }
})

describe('certificate transparency alerts', () => {
  it('announces a newly issued certificate exactly once', async () => {
    const host = `shop-${run}.example.com`
    const ch = await channel('ct-once')
    const monitor = await createMonitor({
      name: 'Shop',
      url: `https://${host}/`,
      notifications: [ch.id],
    })
    logCertificate(host, [host], at(-60 * 24 * 30)) // an old certificate

    // First run: baseline only, nothing is announced and the source is not even asked.
    const first = await ctRun(T0)
    expect(outcomeOf(first, monitor)).toEqual({ monitorId: String(monitor.id), result: 'baseline' })
    expect(sourceCalls).toEqual([])
    const baseline = await reload(monitor.id)
    expect(baseline.ctState).toMatchObject({
      host,
      subdomains: false,
      since: T0.toISOString(),
      nextCheckAt: at(INTERVAL_MINUTES).toISOString(),
      failures: 0,
    })

    // Not due yet.
    await ctRun(at(30))
    expect(sourceCalls).toEqual([])

    // A certificate is issued after the baseline, plus one for an unrelated name.
    const entry = logCertificate(host, [host, `www.${host}`], at(20))
    logCertificate(host, [`other-${host}`], at(25))
    const second = await ctRun(at(INTERVAL_MINUTES))
    expect(sourceCalls).toEqual([`https://crt.test/?q=${host}&output=json`])
    const outcome = outcomeOf(second, monitor)
    expect(outcome?.result).toBe('checked')
    expect(outcome && 'alerts' in outcome ? outcome.alerts : []).toHaveLength(1)
    expect(captured).toHaveLength(1)
    expect(captured[0].event).toBe('certificate')
    expect(captured[0].message).toContain(`[Shop] New certificate for ${host}`)
    expect(captured[0].message).toContain("Let's Encrypt")
    expect(captured[0].message).toContain(`www.${host}`)
    expect(captured[0].message).toContain(`https://crt.sh/?id=${entry.id}`)
    expect(await ctRows(monitor.id)).toHaveLength(1)

    // Re-runs (and the precertificate showing up separately) never repeat it.
    logs.set(host, [...(logs.get(host) ?? []), { ...entry, id: Number(entry.id) + 500 }])
    await ctRun(at(INTERVAL_MINUTES * 2))
    await ctRun(at(INTERVAL_MINUTES * 3))
    expect(captured).toHaveLength(1)
    expect(await ctRows(monitor.id)).toHaveLength(1)
    expect((await reload(monitor.id)).ctState).toMatchObject({
      lastCheckedAt: at(INTERVAL_MINUTES * 3).toISOString(),
      failures: 0,
      error: null,
    })
  })

  it('flags certificates from issuers outside the allow-list and watches subdomains', async () => {
    const host = `api-${run}.example.org`
    const ch = await channel('ct-issuers')
    const monitor = await createMonitor({
      name: 'API',
      type: 'port',
      hostname: host,
      port: 443,
      ctIncludeSubdomains: true,
      ctExpectedIssuers: ["Let's Encrypt"],
      notifications: [ch.id],
    })
    await ctRun(T0)
    logCertificate(host, [host], at(5))
    logCertificate(`%.${host}`, [`evil.${host}`], at(10), 'C=XX, O=Shady CA, CN=Shady Issuing CA')

    const result = await ctRun(at(INTERVAL_MINUTES))
    expect(sourceCalls).toEqual([
      `https://crt.test/?q=${host}&output=json`,
      `https://crt.test/?q=%25.${host}&output=json`,
    ])
    // Requests are spaced by the rate limit (6 per minute).
    expect(sleep).toHaveBeenCalled()
    const outcome = outcomeOf(result, monitor)
    const alerts = outcome && 'alerts' in outcome ? outcome.alerts : []
    expect(alerts.map((a) => a.unexpected)).toEqual([false, true])
    expect(captured).toHaveLength(2)
    expect(captured[0].message).not.toContain('Unexpected issuer')
    expect(captured[1].message).toContain('Unexpected issuer')
    expect(captured[1].message).toContain('Shady CA')
    expect(captured[1].message).toContain(`evil.${host}`)
  })

  it('respects the channel event filters and still records the certificate', async () => {
    const host = `filtered-${run}.example.net`
    const downOnly = await channel('ct-down-only', { events: ['down'] } as Partial<Notification>)
    const monitor = await createMonitor({
      name: 'Filtered',
      url: `https://${host}/`,
      notifications: [downOnly.id],
    })
    await ctRun(T0)
    logCertificate(host, [host], at(1))
    await ctRun(at(INTERVAL_MINUTES))
    expect(captured).toHaveLength(0)
    expect(await ctRows(monitor.id)).toHaveLength(1)
  })

  it('backs off on source errors and honours Retry-After', async () => {
    const host = `flaky-${run}.example.com`
    const monitor = await createMonitor({ name: 'Flaky', url: `https://${host}/` })
    await ctRun(T0)

    sourceAnswer = () =>
      new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '1800' } })
    const failed = await ctRun(at(INTERVAL_MINUTES))
    expect(failed.stopped).toBe('error')
    expect(sourceCalls).toHaveLength(1)
    expect(health.failures).toBe(1)
    expect(health.pausedUntil).toBe(at(INTERVAL_MINUTES + 30).getTime())
    const state = (await reload(monitor.id)).ctState as Record<string, unknown>
    expect(state).toMatchObject({
      failures: 1,
      error: 'CT source answered 429',
      nextCheckAt: at(INTERVAL_MINUTES + 30).toISOString(),
    })

    // While the source is paused nothing is asked.
    const paused = await ctRun(at(INTERVAL_MINUTES + 10))
    expect(paused.stopped).toBe('paused')
    expect(sourceCalls).toHaveLength(1)

    // Server errors back off exponentially.
    sourceAnswer = () => new Response('oops', { status: 502 })
    await ctRun(at(INTERVAL_MINUTES + 30))
    expect(health.failures).toBe(2)
    expect(health.pausedUntil).toBe(at(INTERVAL_MINUTES + 30).getTime() + 2 * CT_BACKOFF_BASE_MS)
    expect((await reload(monitor.id)).ctState).toMatchObject({ failures: 2 })

    // Recovery resets both.
    sourceAnswer = null
    const ok = await ctRun(at(INTERVAL_MINUTES + 60))
    expect(ok.stopped).toBeNull()
    expect(health.failures).toBe(0)
    expect((await reload(monitor.id)).ctState).toMatchObject({ failures: 0, error: null })
  })

  it('looks each hostname up once per run and forgets the baseline when turned off', async () => {
    const host = `shared-${run}.example.com`
    const a = await createMonitor({ name: 'A', url: `https://${host}/a` })
    const b = await createMonitor({ name: 'B', url: `https://${host}/b` })
    await ctRun(T0)
    await ctRun(at(INTERVAL_MINUTES))
    expect(sourceCalls).toEqual([`https://crt.test/?q=${host}&output=json`])

    await payload.update({
      collection: 'monitors',
      id: a.id,
      overrideAccess: true,
      context: { skipEngineSync: true },
      data: { ctAlerts: false },
    })
    expect((await reload(a.id)).ctState).toBeNull()
    expect((await reload(b.id)).ctState).not.toBeNull()
  })

  it('keeps the expiry warnings deduplicated next to the CT rows', async () => {
    const monitor = await createMonitor({ name: 'Expiry', url: `https://expiry-${run}.test/` })
    const history = createPayloadSentHistory(payload, org.id)
    await history.markSent('certificate', monitor.id, 14)
    await history.markSent('certificate', monitor.id, 14)
    expect(await history.wasSent('certificate', monitor.id, 21)).toBe(true)
    expect(await history.wasSent('certificate', monitor.id, 7)).toBe(false)
    const rows = await payload.find({
      collection: 'notification-sent-history',
      where: { monitor: { equals: monitor.id } },
      depth: 0,
      overrideAccess: true,
    })
    expect(rows.docs.map((r) => [r.type, r.days, r.fingerprint])).toEqual([['certificate', 14, '']])
  })
})
