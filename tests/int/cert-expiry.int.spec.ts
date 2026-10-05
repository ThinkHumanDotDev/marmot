import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import type { Monitor, Notification } from '@/payload-types'
import {
  clearHeartbeatListeners,
  processCheckJob,
  registerHeartbeatListener,
  type ChecksQueue,
  type HeartbeatEvent,
} from '@/server/engine'
import { isTlsInfo, type TlsInfo } from '@/server/engine/tls'
import type { DomainExpiryInfo } from '@/server/jobs/domain-expiry'
import { createPayloadSentHistory } from '@/server/jobs/expiry-history'
import {
  processCertExpiry,
  processDomainExpiry,
  registerExpiryNotificationListener,
} from '@/server/jobs/expiry-notifications'
import { resetInstanceSettingsCache } from '@/server/settings'

const FIXTURES = path.join(process.cwd(), 'tests/fixtures/tls')
const cert = readFileSync(path.join(FIXTURES, 'localhost.crt'), 'utf8')
const key = readFileSync(path.join(FIXTURES, 'localhost.key'), 'utf8')
const fixture = new X509Certificate(cert)

let payload: Payload
let server: https.Server
let port: number
let organizationId: string | number

const run = Date.now().toString(36)

type MonitorInput = RequiredDataFromCollectionSlug<'monitors'>

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
    } as MonitorInput,
  })) as Monitor
}

async function createWebhookChannel(name: string): Promise<Notification> {
  return (await payload.create({
    collection: 'notifications',
    depth: 0,
    overrideAccess: true,
    data: {
      name,
      type: 'webhook',
      organization: organizationId,
      config: { url: `https://hooks.example.test/${name}`, method: 'POST', contentType: 'json' },
    } as never,
  })) as Notification
}

const reload = async (id: string | number) =>
  (await payload.findByID({
    collection: 'monitors',
    id,
    depth: 0,
    overrideAccess: true,
  })) as Monitor

/** The engine never touches Redis in these tests. */
const queue = {
  upsertJobScheduler: vi.fn(async () => undefined),
  removeJobScheduler: vi.fn(async () => true),
} as unknown as ChecksQueue

const runCheck = (monitorId: string | number) =>
  processCheckJob(payload, { data: { monitorId: String(monitorId) } }, { queue })

const historyRows = async (monitorId: string | number) =>
  (
    await payload.find({
      collection: 'notification-sent-history',
      where: { monitor: { equals: monitorId } },
      depth: 0,
      overrideAccess: true,
      sort: 'days',
    })
  ).docs

type WebhookCall = { url: string; msg: string }
let webhookCalls: WebhookCall[]

function stubWebhookFetch() {
  webhookCalls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as { msg: string }) : { msg: '' }
      webhookCalls.push({ url, msg: body.msg })
      return new Response('{"ok":true}', { status: 200 })
    }),
  )
}

beforeAll(async () => {
  payload = await getPayload({ config })
  const org = await payload.create({
    collection: 'organizations',
    data: { name: 'cert-expiry-org', slug: `cert-expiry-org-${run}` },
  })
  organizationId = org.id

  server = https.createServer({ cert, key }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('secure hello')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  server?.closeAllConnections()
  await new Promise((resolve) => server?.close(resolve))
  await payload.updateGlobal({
    slug: 'instance-settings',
    data: { tlsExpiryNotifyDays: [7, 14, 21], domainExpiryNotifyDays: [7, 14, 21] },
    overrideAccess: true,
  })
  resetInstanceSettingsCache()
  await payload.delete({
    collection: 'notification-sent-history',
    where: { organization: { equals: organizationId } },
    overrideAccess: true,
  })
  await payload.delete({
    collection: 'heartbeats',
    where: { organization: { equals: organizationId } },
  })
  await payload.delete({
    collection: 'monitors',
    where: { organization: { equals: organizationId } },
  })
  await payload.delete({
    collection: 'notifications',
    where: { organization: { equals: organizationId } },
  })
  await payload.delete({ collection: 'organizations', where: { id: { equals: organizationId } } })
})

afterEach(() => {
  clearHeartbeatListeners()
  vi.unstubAllGlobals()
})

describe('certificate capture on HTTPS checks', () => {
  it('records certInfo on an UP beat and flags the first capture as a change', async () => {
    const monitor = await createMonitor({
      name: 'https-up',
      type: 'http',
      url: `https://127.0.0.1:${port}/`,
      ignoreTls: true,
    })
    const events: HeartbeatEvent[] = []
    registerHeartbeatListener((e) => {
      events.push(e)
    })

    const result = await runCheck(monitor.id)
    expect(result.outcome).toBe('processed')
    expect(result.heartbeat?.status).toBe('up')
    expect(result.next?.msg).toBe('200 - OK')

    const stored = await reload(monitor.id)
    expect(isTlsInfo(stored.certInfo)).toBe(true)
    const tls = stored.certInfo as unknown as TlsInfo
    expect(tls.valid).toBe(false)
    expect(tls.hostnameMatch).toBe(true)
    expect(tls.certInfo).toMatchObject({
      subjectCN: 'localhost',
      certType: 'self-signed',
      fingerprint256: fixture.fingerprint256,
      issuerCertificate: null,
    })
    expect(tls.certInfo!.daysRemaining).toBeGreaterThan(30_000)

    expect(events).toHaveLength(1)
    expect(events[0].tlsInfo?.certInfo?.fingerprint256).toBe(fixture.fingerprint256)
    expect(events[0].certChanged).toBe(true)
    expect(events[0].monitor.certInfo).toEqual(stored.certInfo)

    // Same certificate again: stored, but not a change.
    await runCheck(monitor.id)
    expect(events).toHaveLength(2)
    expect(events[1].certChanged).toBe(false)
  })

  it('records certInfo on a DOWN beat when the handshake is rejected', async () => {
    const monitor = await createMonitor({
      name: 'https-down',
      type: 'http',
      url: `https://127.0.0.1:${port}/`,
      ignoreTls: false,
    })
    const result = await runCheck(monitor.id)
    expect(result.heartbeat?.status).toBe('down')
    expect(result.next?.msg).toMatch(/self[- ]signed/i)

    const stored = await reload(monitor.id)
    const tls = stored.certInfo as unknown as TlsInfo
    expect(tls.valid).toBe(false)
    expect(tls.authorizationError).toMatch(/DEPTH_ZERO_SELF_SIGNED_CERT/)
    expect(tls.certInfo?.fingerprint256).toBe(fixture.fingerprint256)
  })

  it('leaves certInfo alone for plain http and non-HTTP types', async () => {
    const monitor = await createMonitor({ name: 'manual', type: 'manual', manualStatus: 'up' })
    await runCheck(monitor.id)
    expect((await reload(monitor.id)).certInfo ?? null).toBeNull()
  })
})

describe('notification-sent-history', () => {
  it('dedupes (type, monitor, days) with the compound unique index', async () => {
    const monitor = await createMonitor({ name: 'history', type: 'manual', manualStatus: 'up' })
    const row = { type: 'certificate', monitor: monitor.id, days: 14, organization: organizationId }
    await payload.create({
      collection: 'notification-sent-history',
      data: row as never,
      overrideAccess: true,
    })
    await expect(
      payload.create({
        collection: 'notification-sent-history',
        data: row as never,
        overrideAccess: true,
      }),
    ).rejects.toThrow()
    await payload.create({
      collection: 'notification-sent-history',
      data: { ...row, type: 'domain' } as never,
      overrideAccess: true,
    })
    expect(await historyRows(monitor.id)).toHaveLength(2)
  })

  it('payload-backed store: wasSent is "a threshold at or below", markSent is idempotent, clear is per type', async () => {
    const monitor = await createMonitor({ name: 'store', type: 'manual', manualStatus: 'up' })
    const history = createPayloadSentHistory(payload, organizationId)

    expect(await history.wasSent('certificate', monitor.id, 21)).toBe(false)
    await history.markSent('certificate', monitor.id, 14)
    await history.markSent('certificate', monitor.id, 14)
    await history.markSent('domain', monitor.id, 7)
    expect(await historyRows(monitor.id)).toHaveLength(2)

    expect(await history.wasSent('certificate', monitor.id, 21)).toBe(true)
    expect(await history.wasSent('certificate', monitor.id, 14)).toBe(true)
    expect(await history.wasSent('certificate', monitor.id, 7)).toBe(false)
    expect(await history.wasSent('domain', monitor.id, 14)).toBe(true)

    await history.clear('certificate', monitor.id)
    expect(await history.wasSent('certificate', monitor.id, 21)).toBe(false)
    expect(await history.wasSent('domain', monitor.id, 14)).toBe(true)
  })

  it('is deleted together with its monitor', async () => {
    const monitor = await createMonitor({ name: 'cascade', type: 'manual', manualStatus: 'up' })
    await createPayloadSentHistory(payload, organizationId).markSent('certificate', monitor.id, 7)
    expect(await historyRows(monitor.id)).toHaveLength(1)
    await payload.delete({ collection: 'monitors', id: monitor.id, overrideAccess: true })
    expect(await historyRows(monitor.id)).toHaveLength(0)
  })
})

describe('expiry notification listener', () => {
  it('sends the certificate warning once through the attached channels and resets on a new certificate', async () => {
    const channel = await createWebhookChannel(`cert-${run}`)
    const monitor = await createMonitor({
      name: 'cert-notify',
      type: 'http',
      url: `https://127.0.0.1:${port}/`,
      ignoreTls: false,
      expiryNotification: true,
      notifications: [channel.id] as Monitor['notifications'],
    })
    // The fixture is valid for ~100 years: use a threshold that is inside its lifetime.
    await payload.updateGlobal({
      slug: 'instance-settings',
      data: { tlsExpiryNotifyDays: [40_000] },
      overrideAccess: true,
    })
    resetInstanceSettingsCache()
    stubWebhookFetch()
    registerExpiryNotificationListener(payload)

    await runCheck(monitor.id)
    expect(webhookCalls).toHaveLength(1)
    expect(webhookCalls[0].url).toBe(`https://hooks.example.test/cert-${run}`)
    expect(webhookCalls[0].msg).toMatch(
      new RegExp(
        `^\\[cert-notify\\]\\[https://127\\.0\\.0\\.1:${port}/\\] self-signed certificate localhost will expire in \\d+ days$`,
      ),
    )
    expect((await historyRows(monitor.id)).map((r) => [r.type, r.days])).toEqual([
      ['certificate', 40_000],
    ])

    // Same certificate on the next beat: deduped.
    await runCheck(monitor.id)
    expect(webhookCalls).toHaveLength(1)

    // A different leaf certificate resets the history and warns again.
    const stored = await reload(monitor.id)
    const renewed = stored.certInfo as unknown as TlsInfo
    const notice = await processCertExpiry(payload, {
      monitor: stored,
      heartbeat: { status: 'up' } as HeartbeatEvent['heartbeat'],
      organizationId,
      tlsInfo: {
        ...renewed,
        certInfo: { ...renewed.certInfo!, fingerprint256: 'renewed-256' },
      },
      certChanged: true,
    })
    expect(notice).toHaveLength(1)
    expect(webhookCalls).toHaveLength(2)
    expect(await historyRows(monitor.id)).toHaveLength(1)
  })

  it('stays quiet with ignoreTls or without the opt-in', async () => {
    const channel = await createWebhookChannel(`quiet-${run}`)
    const ignored = await createMonitor({
      name: 'cert-ignored',
      type: 'http',
      url: `https://127.0.0.1:${port}/`,
      ignoreTls: true,
      expiryNotification: true,
      notifications: [channel.id] as Monitor['notifications'],
    })
    const optedOut = await createMonitor({
      name: 'cert-opt-out',
      type: 'http',
      url: `https://127.0.0.1:${port}/`,
      ignoreTls: false,
      expiryNotification: false,
      notifications: [channel.id] as Monitor['notifications'],
    })
    stubWebhookFetch()
    registerExpiryNotificationListener(payload)
    await runCheck(ignored.id)
    await runCheck(optedOut.id)
    expect(webhookCalls).toHaveLength(0)
    expect(await historyRows(ignored.id)).toHaveLength(0)
  })

  it('looks the domain up via RDAP once a day, caches it on the monitor and warns once', async () => {
    const channel = await createWebhookChannel(`domain-${run}`)
    const monitor = await createMonitor({
      name: 'domain-notify',
      type: 'http',
      url: 'https://www.example.com/',
      domainExpiryNotification: true,
      notifications: [channel.id] as Monitor['notifications'],
    })
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 10 * 86_400_000 + 3_600_000)
    const rdapCalls: string[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      rdapCalls.push(url)
      if (url.endsWith('/domain/www.example.com')) return new Response('{}', { status: 404 })
      return new Response(
        JSON.stringify({
          events: [{ eventAction: 'expiration', eventDate: expiresAt.toISOString() }],
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    stubWebhookFetch()

    const event = {
      monitor,
      heartbeat: { status: 'up' } as HeartbeatEvent['heartbeat'],
      organizationId,
    }
    const first = await processDomainExpiry(payload, event, { lookup: { fetchImpl }, now })
    expect(rdapCalls).toEqual([
      'https://rdap.org/domain/www.example.com',
      'https://rdap.org/domain/example.com',
    ])
    expect(first.info).toMatchObject({
      domain: 'example.com',
      expiresAt: expiresAt.toISOString(),
      daysRemaining: 10,
    })
    expect(first.notice).toMatchObject({ targetDays: 14, daysRemaining: 10 })
    expect(webhookCalls.map((c) => c.msg)).toEqual([
      '[domain-notify][https://www.example.com/] Domain name example.com will expire in 10 days',
    ])

    const stored = await reload(monitor.id)
    expect(stored.domainExpiry as unknown as DomainExpiryInfo).toMatchObject({
      host: 'www.example.com',
      domain: 'example.com',
    })
    expect((await historyRows(monitor.id)).map((r) => [r.type, r.days])).toEqual([['domain', 14]])

    // Next beat: the cache is fresh, so no RDAP call and no second warning.
    const second = await processDomainExpiry(
      payload,
      { ...event, monitor: stored },
      { lookup: { fetchImpl }, now },
    )
    expect(rdapCalls).toHaveLength(2)
    expect(second.notice).toBeNull()
    expect(webhookCalls).toHaveLength(1)

    // 25 hours later the lookup runs again; a renewal clears the history.
    const later = new Date(now.getTime() + 25 * 3_600_000)
    const renewedAt = new Date(later.getTime() + 400 * 86_400_000)
    const renewedFetch = (async () =>
      new Response(
        JSON.stringify({
          events: [{ eventAction: 'expiration', eventDate: renewedAt.toISOString() }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch
    const third = await processDomainExpiry(
      payload,
      { ...event, monitor: stored },
      { lookup: { fetchImpl: renewedFetch }, now: later },
    )
    expect(third.info?.expiresAt).toBe(renewedAt.toISOString())
    expect(third.notice).toBeNull()
    expect(await historyRows(monitor.id)).toHaveLength(0)
  })

  it('skips the domain lookup for IPs, maintenance beats and monitors without the opt-in', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const ip = await createMonitor({
      name: 'domain-ip',
      type: 'http',
      url: `https://127.0.0.1:${port}/`,
      domainExpiryNotification: true,
    })
    const optedOut = await createMonitor({
      name: 'domain-opt-out',
      type: 'http',
      url: 'https://www.example.com/',
      domainExpiryNotification: false,
    })
    const heartbeat = { status: 'up' } as HeartbeatEvent['heartbeat']
    expect(
      await processDomainExpiry(
        payload,
        { monitor: ip, heartbeat, organizationId },
        { lookup: { fetchImpl } },
      ),
    ).toEqual({ info: null, notice: null })
    expect(
      await processDomainExpiry(
        payload,
        { monitor: optedOut, heartbeat, organizationId },
        { lookup: { fetchImpl } },
      ),
    ).toEqual({ info: null, notice: null })
    const maintenance = { status: 'maintenance' } as HeartbeatEvent['heartbeat']
    expect(
      await processDomainExpiry(
        payload,
        {
          monitor: { ...optedOut, domainExpiryNotification: true },
          heartbeat: maintenance,
          organizationId,
        },
        { lookup: { fetchImpl } },
      ),
    ).toEqual({ info: null, notice: null })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
