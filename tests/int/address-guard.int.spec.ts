import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { resetEnvCache } from '@/env'
import type { Monitor } from '@/payload-types'
import { processCheckJob, type ChecksQueue } from '@/server/engine'
import { sendNotification } from '@/server/notifications/send'
import {
  guardedFetch,
  literalTargetDenial,
  resolveGuardedTarget,
} from '@/server/security/outbound-guard'

/**
 * Outbound address guard (`MONITOR_DENY_PRIVATE_ADDRESSES`, `MONITOR_DENY_CIDRS`,
 * `MONITOR_ALLOW_CIDRS`): checks and notifications to denied addresses are refused at connect time,
 * after DNS resolution, including redirect hops; host-local types are refused on save.
 */

const GUARD_VARS = [
  'MONITOR_DENY_PRIVATE_ADDRESSES',
  'MONITOR_DENY_CIDRS',
  'MONITOR_ALLOW_CIDRS',
] as const
const saved = Object.fromEntries(GUARD_VARS.map((key) => [key, process.env[key]]))

function setGuard(vars: Partial<Record<(typeof GUARD_VARS)[number], string>>) {
  for (const key of GUARD_VARS) {
    if (vars[key] === undefined) delete process.env[key]
    else process.env[key] = vars[key]
  }
  resetEnvCache()
}

let payload: Payload
let organizationId: string | number
let server: http.Server
let port: number
const hits: string[] = []

const queue = {
  upsertJobScheduler: vi.fn(async () => undefined),
  removeJobScheduler: vi.fn(async () => true),
} as unknown as ChecksQueue

/** The field messages of a rejected Payload operation (ValidationError keeps them in `data`). */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    const errors = (err as { data?: { errors?: { message: string }[] } }).data?.errors
    return errors?.map((e) => e.message).join('; ') ?? (err as Error).message
  }
  throw new Error('expected the operation to be rejected')
}

const run = (id: string | number) =>
  processCheckJob(payload, { data: { monitorId: String(id) } }, { queue })

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
      timeout: 5,
      ...data,
    } as RequiredDataFromCollectionSlug<'monitors'>,
  })) as Monitor
}

beforeAll(async () => {
  payload = await getPayload({ config })
  const org = await payload.create({
    collection: 'organizations',
    data: { name: 'address-guard-org', slug: `address-guard-${Date.now().toString(36)}` },
  })
  organizationId = org.id

  // Listens on every interface so 127.0.0.2 reaches it too (Linux routes 127/8 to loopback).
  server = http.createServer((req, res) => {
    hits.push(`${req.headers.host}${req.url}`)
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: `http://127.0.0.2:${port}/` })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
  port = (server.address() as AddressInfo).port
})

afterEach(() => {
  setGuard({})
  hits.length = 0
})

afterAll(async () => {
  for (const key of GUARD_VARS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  resetEnvCache()
  server?.closeAllConnections()
  await new Promise((resolve) => server?.close(resolve))
  await payload?.delete({
    collection: 'monitors',
    where: { organization: { equals: organizationId } },
    overrideAccess: true,
  })
})

describe('monitor checks', () => {
  it('reaches 127.0.0.1 with the guard off and is blocked (DOWN) with it on', async () => {
    const monitor = await createMonitor({
      name: 'loopback-http',
      type: 'http',
      url: `http://127.0.0.1:${port}/`,
    })

    expect((await run(monitor.id)).heartbeat).toMatchObject({ status: 'up', msg: '200 - OK' })

    setGuard({ MONITOR_DENY_PRIVATE_ADDRESSES: 'true' })
    hits.length = 0
    const blocked = await run(monitor.id)
    expect(blocked.heartbeat).toMatchObject({
      status: 'down',
      msg: 'Blocked: 127.0.0.1 resolves to a private address (MONITOR_DENY_PRIVATE_ADDRESSES)',
    })
    expect(hits).toEqual([])
  })

  it('blocks names that resolve to a private address after DNS resolution', async () => {
    const monitor = await createMonitor({
      name: 'localhost-http',
      type: 'keyword',
      url: `http://localhost:${port}/`,
      keyword: 'ok',
    })
    setGuard({ MONITOR_DENY_PRIVATE_ADDRESSES: '1' })
    const result = await run(monitor.id)
    expect(result.heartbeat?.status).toBe('down')
    expect(result.heartbeat?.msg).toBe(
      'Blocked: localhost resolves to a private address (MONITOR_DENY_PRIVATE_ADDRESSES)',
    )
    expect(hits).toEqual([])
  })

  it('blocks a redirect from an allowed first hop to a denied address', async () => {
    const monitor = await createMonitor({
      name: 'redirect-to-private',
      type: 'http',
      url: `http://127.0.0.1:${port}/redirect`,
      maxRedirects: 5,
    })

    // 127.0.0.1 plays the "public" first hop; 127.0.0.2 stays denied.
    setGuard({ MONITOR_DENY_PRIVATE_ADDRESSES: 'true', MONITOR_ALLOW_CIDRS: '127.0.0.1/32' })
    const blocked = await run(monitor.id)
    expect(blocked.heartbeat?.status).toBe('down')
    expect(blocked.heartbeat?.msg).toBe(
      'Blocked: 127.0.0.2 resolves to a private address (MONITOR_DENY_PRIVATE_ADDRESSES)',
    )
    expect(hits).toEqual([`127.0.0.1:${port}/redirect`])

    // Control: with both hops allowed the same redirect chain succeeds.
    hits.length = 0
    setGuard({ MONITOR_DENY_PRIVATE_ADDRESSES: 'true', MONITOR_ALLOW_CIDRS: '127.0.0.0/8' })
    expect((await run(monitor.id)).heartbeat).toMatchObject({ status: 'up' })
    expect(hits).toEqual([`127.0.0.1:${port}/redirect`, `127.0.0.2:${port}/`])
  })

  it('checks the address of the proxy a monitor goes through', async () => {
    const proxy = await payload.create({
      collection: 'proxies',
      overrideAccess: true,
      data: {
        organization: organizationId,
        protocol: 'http',
        host: 'localhost',
        port,
      } as RequiredDataFromCollectionSlug<'proxies'>,
    })
    const monitor = await createMonitor({
      name: 'via-local-proxy',
      type: 'http',
      url: 'http://example.com/',
      proxy: proxy.id,
    })
    setGuard({ MONITOR_DENY_PRIVATE_ADDRESSES: 'true' })
    expect((await run(monitor.id)).heartbeat).toMatchObject({
      status: 'down',
      msg: 'Blocked: localhost resolves to a private address (MONITOR_DENY_PRIVATE_ADDRESSES)',
    })
    expect(hits).toEqual([])
  })

  it('applies MONITOR_DENY_CIDRS without the private set', async () => {
    const monitor = await createMonitor({
      name: 'deny-cidr',
      type: 'http',
      url: `http://127.0.0.1:${port}/`,
    })
    setGuard({ MONITOR_DENY_CIDRS: '127.0.0.0/8' })
    expect((await run(monitor.id)).heartbeat).toMatchObject({
      status: 'down',
      msg: 'Blocked: 127.0.0.1 resolves to a denied address (MONITOR_DENY_CIDRS)',
    })
  })

  it('normalises odd IPv4 literals like the OS resolver and blocks TCP port checks', async () => {
    const tcp = net.createServer((socket) => socket.end())
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve))
    const tcpPort = (tcp.address() as AddressInfo).port
    try {
      const monitor = await createMonitor({
        name: 'decimal-literal',
        type: 'port',
        hostname: '2130706433',
        port: tcpPort,
      })
      expect((await run(monitor.id)).heartbeat?.status).toBe('up')

      setGuard({ MONITOR_DENY_PRIVATE_ADDRESSES: 'true' })
      expect((await run(monitor.id)).heartbeat).toMatchObject({
        status: 'down',
        msg: 'Blocked: 2130706433 resolves to a private address (MONITOR_DENY_PRIVATE_ADDRESSES)',
      })
      for (const host of ['2130706433', '0x7f.1', '127.1', '017700000001', '[::ffff:127.0.0.1]']) {
        await expect(resolveGuardedTarget(host)).rejects.toThrow(/^Blocked: /)
        expect(literalTargetDenial(host)).toMatch(/^Blocked: /)
      }
    } finally {
      await new Promise((resolve) => tcp.close(resolve))
    }
  })

  it('reports a blocked check as DOWN even with retries and upside-down mode', async () => {
    const monitor = await createMonitor({
      name: 'blocked-upside-down',
      type: 'http',
      url: `http://127.0.0.1:${port}/`,
      upsideDown: true,
      maxRetries: 3,
    })
    setGuard({ MONITOR_DENY_PRIVATE_ADDRESSES: 'true' })
    expect((await run(monitor.id)).heartbeat).toMatchObject({ status: 'down' })
  })
})

describe('database and broker drivers', () => {
  // The test databases of this run (Postgres, Redis and, when configured, MongoDB on localhost).
  const pgUrl = process.env.DATABASE_ADAPTER === 'postgres' ? process.env.DATABASE_URL : undefined
  const mongoUrl = process.env.DATABASE_ADAPTER === 'mongodb' ? process.env.DATABASE_URL : undefined
  const redisUrl = process.env.REDIS_URL

  const cases = [
    { type: 'postgres' as const, url: pgUrl },
    { type: 'mongodb' as const, url: mongoUrl },
    { type: 'redis' as const, url: redisUrl },
  ]

  // Only the databases this run talks to (the other adapter's server is not configured).
  const local = cases.filter((c): c is { type: (typeof c)['type']; url: string } =>
    Boolean(c.url && /localhost|127\.0\.0\.1/.test(c.url)),
  )
  for (const { type, url } of local) {
    it(`${type}: connects with the guard off and is blocked at connect time with it on`, async () => {
      const monitor = await createMonitor({
        name: `${type}-local`,
        type,
        databaseConnectionString: url,
        timeout: 10,
      })
      expect((await run(monitor.id)).heartbeat?.status).toBe('up')

      setGuard({ MONITOR_DENY_PRIVATE_ADDRESSES: 'true' })
      const blocked = await run(monitor.id)
      expect(blocked.heartbeat?.status).toBe('down')
      expect(blocked.heartbeat?.msg).toMatch(
        /^Blocked: (localhost|127\.0\.0\.1) resolves to a private address \(MONITOR_DENY_PRIVATE_ADDRESSES\)$/,
      )

      // Allow-listed, the same check runs through the guarded connection and succeeds.
      setGuard({
        MONITOR_DENY_PRIVATE_ADDRESSES: 'true',
        MONITOR_ALLOW_CIDRS: '127.0.0.0/8, ::1/128',
      })
      expect((await run(monitor.id)).heartbeat?.status).toBe('up')
    })
  }
})

describe('saving monitors', () => {
  it('refuses a tailscale-ping monitor with the guard on and accepts it with the guard off', async () => {
    setGuard({ MONITOR_DENY_PRIVATE_ADDRESSES: 'true' })
    expect(
      await rejection(createMonitor({ name: 'tailnet', type: 'tailscale-ping', hostname: 'peer' })),
    ).toBe(
      'Blocked: The Tailscale Ping monitor is not allowed on this instance (MONITOR_DENY_PRIVATE_ADDRESSES)',
    )

    setGuard({})
    const ok = await createMonitor({ name: 'tailnet', type: 'tailscale-ping', hostname: 'peer' })
    expect(ok.id).toBeDefined()

    // Created before the guard was turned on: it is refused when it runs.
    setGuard({ MONITOR_DENY_PRIVATE_ADDRESSES: 'true' })
    expect((await run(ok.id)).heartbeat).toMatchObject({
      status: 'down',
      msg: 'Blocked: The Tailscale Ping monitor is not allowed on this instance (MONITOR_DENY_PRIVATE_ADDRESSES)',
    })
  })

  it('refuses the browser engine and literal private targets on save', async () => {
    setGuard({ MONITOR_DENY_PRIVATE_ADDRESSES: 'true' })
    expect(
      await rejection(
        createMonitor({
          name: 'browser',
          type: 'real-browser',
          url: 'https://example.com',
          remoteBrowser: 'ws://browserless:3000',
        }),
      ),
    ).toMatch(/Browser Engine monitor is not allowed/)
    expect(
      await rejection(
        createMonitor({ name: 'metadata', type: 'http', url: 'http://169.254.169.254/latest/' }),
      ),
    ).toBe(
      'Blocked: 169.254.169.254 resolves to a private address (MONITOR_DENY_PRIVATE_ADDRESSES)',
    )
    expect(
      await rejection(
        createMonitor({ name: 'mapped', type: 'port', hostname: '::ffff:10.0.0.1', port: 22 }),
      ),
    ).toMatch(/private address/)
    expect(
      await rejection(
        createMonitor({
          name: 'bundled-db',
          type: 'postgres',
          databaseConnectionString: 'postgres://marmot:marmot@127.0.0.1:5432/marmot',
        }),
      ),
    ).toMatch(/private address/)

    // Allowed subnets and names that only resolution can judge are accepted.
    setGuard({ MONITOR_DENY_PRIVATE_ADDRESSES: 'true', MONITOR_ALLOW_CIDRS: '10.0.0.0/8' })
    expect(
      (await createMonitor({ name: 'allowed', type: 'port', hostname: '10.1.2.3', port: 22 })).id,
    ).toBeDefined()
    expect(
      (await createMonitor({ name: 'named', type: 'http', url: 'https://example.com/' })).id,
    ).toBeDefined()
  })

  it('refuses Docker socket hosts with the guard on', async () => {
    setGuard({ MONITOR_DENY_PRIVATE_ADDRESSES: 'true' })
    expect(
      await rejection(
        payload.create({
          collection: 'docker-hosts',
          overrideAccess: true,
          data: {
            organization: organizationId,
            name: 'local',
            connectionType: 'socket',
            socketPath: '/var/run/docker.sock',
          } as RequiredDataFromCollectionSlug<'docker-hosts'>,
        }),
      ),
    ).toMatch(/Docker socket host is not allowed/)
  })
})

describe('notifications', () => {
  it('refuses a webhook to a denied address and delivers it with the guard off', async () => {
    const channel = {
      type: 'webhook',
      config: { url: `http://127.0.0.1:${port}/hook`, method: 'POST', contentType: 'json' },
    }

    setGuard({ MONITOR_DENY_PRIVATE_ADDRESSES: 'true' })
    await expect(
      sendNotification(payload, channel, { message: 'test', monitor: null, heartbeat: null }),
    ).rejects.toThrow(
      'Blocked: 127.0.0.1 resolves to a private address (MONITOR_DENY_PRIVATE_ADDRESSES)',
    )
    expect(hits).toEqual([])

    setGuard({})
    await expect(
      sendNotification(payload, channel, { message: 'test', monitor: null, heartbeat: null }),
    ).resolves.toBe('Sent Successfully.')
    expect(hits).toEqual([`127.0.0.1:${port}/hook`])
  })

  it('checks every redirect hop of guarded requests', async () => {
    setGuard({ MONITOR_DENY_PRIVATE_ADDRESSES: 'true', MONITOR_ALLOW_CIDRS: '127.0.0.1' })
    await expect(guardedFetch(`http://127.0.0.1:${port}/redirect`)).rejects.toThrow()
    expect(hits).toEqual([`127.0.0.1:${port}/redirect`])

    hits.length = 0
    setGuard({ MONITOR_DENY_PRIVATE_ADDRESSES: 'true', MONITOR_ALLOW_CIDRS: '127.0.0.0/8' })
    const res = await guardedFetch(`http://127.0.0.1:${port}/redirect`)
    expect(await res.text()).toBe('ok')
  })
})
