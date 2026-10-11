/**
 * Protocol monitors (#141) through the engine: the TLS handshake, IMAP and POP3 types record the
 * server certificate in `monitors.certInfo` (the certificate panel) and feed the expiry
 * notifications like the HTTP types do. The servers run in-process.
 */
import { X509Certificate } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import tls from 'node:tls'
import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import type { Monitor, Notification } from '@/payload-types'
import { clearHeartbeatListeners, processCheckJob, type ChecksQueue } from '@/server/engine'
import { isTlsInfo, type TlsInfo } from '@/server/engine/tls'
import { registerExpiryNotificationListener } from '@/server/jobs/expiry-notifications'
import { startLineServer, tlsFixture } from '@/server/monitor-types/test-helpers'
import { resetInstanceSettingsCache } from '@/server/settings'

const { cert, key } = tlsFixture()
const fixture = new X509Certificate(cert)
const run = Date.now().toString(36)

let payload: Payload
let organizationId: string | number
let tlsServer: tls.Server
let tlsPort: number
let pop3: Awaited<ReturnType<typeof startLineServer>>

/** The engine never touches Redis in these tests. */
const queue = {
  upsertJobScheduler: vi.fn(async () => undefined),
  removeJobScheduler: vi.fn(async () => true),
} as unknown as ChecksQueue

const runCheck = (monitorId: string | number) =>
  processCheckJob(payload, { data: { monitorId: String(monitorId) } }, { queue })

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
      hostname: '127.0.0.1',
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

beforeAll(async () => {
  payload = await getPayload({ config })
  const org = await payload.create({
    collection: 'organizations',
    data: { name: 'protocol-monitors-org', slug: `protocol-monitors-${run}` },
  })
  organizationId = org.id

  tlsServer = tls.createServer({ cert, key }, (socket) => socket.end())
  await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', resolve))
  tlsPort = (tlsServer.address() as AddressInfo).port

  pop3 = await startLineServer({
    onConnect: (conn) => conn.send('+OK ready'),
    onLine: (conn, line) => {
      if (line === 'CAPA') {
        conn.send('+OK')
        if (!conn.secure) conn.send('STLS')
        conn.send('.')
      } else if (line === 'STLS') {
        conn.send('+OK go ahead')
        conn.startTls()
      } else if (line === 'QUIT') {
        conn.send('+OK bye')
        conn.close()
      } else conn.send('-ERR')
    },
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => tlsServer?.close(() => resolve()))
  await pop3?.close()
  await payload.updateGlobal({
    slug: 'instance-settings',
    data: { tlsExpiryNotifyDays: [7, 14, 21] },
    overrideAccess: true,
  })
  resetInstanceSettingsCache()
  for (const collection of [
    'notification-sent-history',
    'heartbeats',
    'monitors',
    'notifications',
  ] as const) {
    await payload.delete({
      collection,
      where: { organization: { equals: organizationId } },
      overrideAccess: true,
    })
  }
  await payload.delete({ collection: 'organizations', where: { id: { equals: organizationId } } })
})

afterEach(() => {
  clearHeartbeatListeners()
  vi.unstubAllGlobals()
})

describe('certificate capture of the protocol monitors', () => {
  it('stores the certificate of a TLS handshake monitor, UP or DOWN', async () => {
    const up = await createMonitor({ name: 'tls-up', type: 'tls', port: tlsPort, ignoreTls: true })
    const result = await runCheck(up.id)
    expect(result.heartbeat?.status).toBe('up')
    const stored = await reload(up.id)
    expect(isTlsInfo(stored.certInfo)).toBe(true)
    expect((stored.certInfo as unknown as TlsInfo).certInfo?.fingerprint256).toBe(
      fixture.fingerprint256,
    )

    const down = await createMonitor({ name: 'tls-down', type: 'tls', port: tlsPort })
    const failed = await runCheck(down.id)
    expect(failed.heartbeat?.status).toBe('down')
    expect(failed.next?.msg).toMatch(/^TLS certificate is not trusted: self-signed certificate/)
    expect((await reload(down.id)).certInfo).toMatchObject({ valid: false })
  })

  it('stores the certificate a POP3 server presents after STLS', async () => {
    const monitor = await createMonitor({
      name: 'pop3-stls',
      type: 'pop3',
      port: pop3.port,
      smtpSecurity: 'starttls',
      ignoreTls: true,
    })
    const result = await runCheck(monitor.id)
    expect(result.heartbeat?.status).toBe('up')
    expect(result.next?.msg).toBe('+OK ready, STLS')
    const stored = (await reload(monitor.id)).certInfo as unknown as TlsInfo
    expect(stored.certInfo?.subjectCN).toBe('localhost')
  })
})

describe('certificate expiry notifications of the protocol monitors', () => {
  it('warns through the channels of a TLS monitor, naming host:port', async () => {
    const channel = (await payload.create({
      collection: 'notifications',
      depth: 0,
      overrideAccess: true,
      data: {
        name: `tls-expiry-${run}`,
        type: 'webhook',
        organization: organizationId,
        config: {
          url: `https://hooks.example.test/tls-${run}`,
          method: 'POST',
          contentType: 'json',
        },
      } as never,
    })) as Notification
    const monitor = await createMonitor({
      name: 'tls-expiry',
      type: 'tls',
      port: tlsPort,
      // ignoreTls suppresses expiry warnings, so the self-signed check is DOWN but still warns.
      ignoreTls: false,
      expiryNotification: true,
      notifications: [channel.id] as Monitor['notifications'],
    })
    // The fixture is valid for ~100 years: use a threshold inside its lifetime.
    await payload.updateGlobal({
      slug: 'instance-settings',
      data: { tlsExpiryNotifyDays: [40_000] },
      overrideAccess: true,
    })
    resetInstanceSettingsCache()
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        calls.push(
          typeof init?.body === 'string' ? (JSON.parse(init.body) as { msg: string }).msg : '',
        )
        return new Response('{"ok":true}', { status: 200 })
      }),
    )
    registerExpiryNotificationListener(payload)

    await runCheck(monitor.id)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatch(
      new RegExp(
        `^\\[tls-expiry\\]\\[127\\.0\\.0\\.1:${tlsPort}\\] self-signed certificate localhost will expire in \\d+ days$`,
      ),
    )
  })
})
