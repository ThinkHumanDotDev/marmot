/**
 * Self connectivity check (#148) end to end against the database: a simulated worker whose uplink
 * is cut (every probe target fails) must hold external checks as PENDING "checker offline" beats,
 * send exactly one "checker offline" notice, keep the offline window out of the uptime stats and
 * resume normally once connectivity returns.
 */
import net from 'node:net'
import type { AddressInfo } from 'node:net'

import { Redis } from 'ioredis'
import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { resetEnvCache } from '@/env'
import { parseConnectivityTargets } from '@/lib/connectivity-targets'
import type { Monitor } from '@/payload-types'
import {
  CHECKER_OFFLINE_MSG,
  clearHeartbeatListeners,
  getConnectivityMonitor,
  monitorNeedsInternet,
  processCheckJob,
  registerHeartbeatListener,
  type ChecksQueue,
  type HeartbeatEvent,
} from '@/server/engine'
import {
  deliverCheckerNotice,
  startConnectivityCheck,
  type CheckerNotice,
  type ConnectivityCheckHandle,
} from '@/server/engine/connectivity-runtime'
import { getCheckerSummary, publishCheckerState } from '@/server/engine/connectivity-state'
import { configureEmitter, closeEmitter } from '@/server/realtime/emitter'
import { createStatsListener, getUptime } from '@/server/stats'

let payload: Payload
let organizationId: string | number
let redis: Redis
let tcpServer: net.Server
let tcpPort: number

const run = Date.now().toString(36)
const statePrefix = `marmot:test:${run}:connectivity:status:`
const claimPrefix = `marmot:test:${run}:connectivity:notice:`

/** Scheduler stub: the DB tests never touch the shared checks queue. */
const schedulerQueue = {
  upsertJobScheduler: vi.fn(async () => undefined),
  removeJobScheduler: vi.fn(async () => true),
} as unknown as ChecksQueue

const check = (monitorId: string | number) =>
  processCheckJob(payload, { data: { monitorId: String(monitorId) } }, { queue: schedulerQueue })

const findMonitor = async (id: string | number) =>
  (await payload.findByID({
    collection: 'monitors',
    id,
    depth: 0,
    overrideAccess: true,
  })) as Monitor

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
      timeout: 2,
      ...data,
    } as RequiredDataFromCollectionSlug<'monitors'>,
  })) as Monitor
}

/** Make the push monitor's last push recent (UP) or long gone (DOWN). */
async function setLastPush(id: string | number, agoSeconds: number) {
  const monitor = await findMonitor(id)
  await payload.update({
    collection: 'monitors',
    id,
    overrideAccess: true,
    context: { skipEngineSync: true },
    data: {
      status: {
        ...monitor.status,
        lastPushAt: new Date(Date.now() - agoSeconds * 1000).toISOString(),
      },
    },
  })
}

beforeAll(async () => {
  payload = await getPayload({ config })
  const org = await payload.create({
    collection: 'organizations',
    data: { name: 'connectivity-int', slug: `connectivity-int-${run}` },
  })
  organizationId = org.id
  redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: 1,
  })
  // Realtime broadcasts go to a recorder instead of Redis.
  await configureEmitter({
    key: `connectivity-int-${run}`,
    redis: { publish: vi.fn(async () => 1) } as unknown as Redis,
  })
  tcpServer = net.createServer((socket) => socket.end())
  await new Promise<void>((r) => tcpServer.listen(0, '127.0.0.1', r))
  tcpPort = (tcpServer.address() as AddressInfo).port
})

afterAll(async () => {
  const keys = await redis.keys(`marmot:test:${run}:*`)
  if (keys.length) await redis.del(...keys)
  await redis.quit()
  await configureEmitter()
  await closeEmitter()
  await new Promise((r) => tcpServer.close(r))
})

afterEach(() => clearHeartbeatListeners())

describe('connectivity check with a simulated offline worker', () => {
  let handle: ConnectivityCheckHandle
  let uplink = true
  let clock = Date.now()
  const notices: CheckerNotice[] = []
  const rechecks: string[] = []
  const events: HeartbeatEvent[] = []

  beforeAll(async () => {
    handle = (await startConnectivityCheck(payload, {
      config: {
        targets: parseConnectivityTargets('192.0.2.1:53, https://connectivity.invalid/'),
        mode: 'any',
        intervalMs: 60_000,
        timeoutMs: 100,
      },
      prober: async (target) => {
        if (!uplink) throw new Error(`connect ENETUNREACH ${target.label}`)
      },
      deliver: async (_payload, notice) => {
        notices.push(notice)
      },
      redis,
      statePrefix,
      claimPrefix,
      worker: 'int-worker',
      now: () => new Date(clock),
      queue: {
        add: vi.fn(async (_name: string, data: { monitorId: string }) => {
          rechecks.push(data.monitorId)
          return {} as never
        }),
      } as unknown as Pick<ChecksQueue, 'add'>,
    }))!
  })

  afterAll(async () => {
    await handle?.stop()
  })

  /** Simulate the probe timer firing. */
  const tick = async (advanceMs = 60_000) => {
    clock += advanceMs
    await handle.monitor.refresh({ maxAgeMs: 0 })
    await handle.outbox.flush()
  }

  it('holds external checks, notifies once and resumes normally', async () => {
    expect(getConnectivityMonitor()).toBe(handle.monitor)
    expect(handle.monitor.snapshot().status).toBe('online')

    registerHeartbeatListener(createStatsListener(payload))
    registerHeartbeatListener((event) => {
      events.push(event)
    })

    const push = await createMonitor({ name: 'push external', type: 'push', pushToken: `t${run}` })
    const http = await createMonitor({
      name: 'http external',
      type: 'http',
      url: 'http://marmot-connectivity-test.invalid/',
    })
    const local = await createMonitor({
      name: 'port local',
      type: 'port',
      hostname: '127.0.0.1',
      port: tcpPort,
    })

    // Before the outage: the push monitor is UP.
    await setLastPush(push.id, 1)
    expect((await check(push.id)).next?.status).toBe('up')

    // The uplink goes away; no pushes arrive any more either.
    uplink = false
    await tick()
    expect(handle.monitor.snapshot().status).toBe('offline')
    await setLastPush(push.id, 600)

    for (let i = 0; i < 3; i++) {
      const held = await check(push.id)
      expect(held.heartbeat?.status).toBe('pending')
      expect(held.heartbeat?.msg).toBe(CHECKER_OFFLINE_MSG)
      expect(held.heartbeat?.important).toBe(false)
      expect(held.next?.notify).toBe(false)
    }
    // The cached status is left as it was before the outage.
    const during = await findMonitor(push.id)
    expect(during.status?.lastStatus).toBe('up')
    expect(during.status?.lastMsg).toBe(CHECKER_OFFLINE_MSG)

    // A never-checked external monitor is held too; a local one keeps running.
    expect((await check(http.id)).heartbeat?.msg).toBe(CHECKER_OFFLINE_MSG)
    const localBeat = await check(local.id)
    expect(localBeat.heartbeat?.status).toBe('up')

    // More probes while offline: still exactly one notice.
    await tick()
    await tick()
    expect(notices.map((n) => n.kind)).toEqual(['offline'])
    expect(events.some((e) => e.notify)).toBe(false)
    expect(events.filter((e) => e.checkerOffline)).toHaveLength(4)

    // Stats: the offline window is neither up nor down.
    expect(await getUptime(payload, push.id, '24h')).toBe(1)
    const { docs: buckets } = await payload.find({
      collection: 'stat-minutely',
      where: { monitor: { equals: push.id } },
      overrideAccess: true,
    })
    expect(buckets.reduce((sum, b) => sum + (b.down ?? 0), 0)).toBe(0)
    expect(buckets.reduce((sum, b) => sum + (b.up ?? 0), 0)).toBe(1)

    // Connectivity returns: one "back online" notice, the held monitors are re-checked.
    uplink = true
    await tick()
    expect(notices.map((n) => n.kind)).toEqual(['offline', 'online'])
    expect(notices[1].offlineSince).toBe(notices[0].at)
    expect(rechecks.sort()).toEqual([String(push.id), String(http.id)].sort())

    // Pushes arrive again: UP → UP, nothing to announce.
    await setLastPush(push.id, 1)
    const resumed = await check(push.id)
    expect(resumed.next?.status).toBe('up')
    expect(resumed.next?.notify).toBe(false)

    // A real outage of the target while the worker is online still goes DOWN and notifies.
    await setLastPush(push.id, 600)
    const down = await check(push.id)
    expect(down.next?.status).toBe('down')
    expect(down.next?.notify).toBe(true)
  })

  it('re-probes when a check fails, catching an uplink lost between two probes', async () => {
    const push = await createMonitor({ name: 'push between', type: 'push', pushToken: `b${run}` })
    await setLastPush(push.id, 1)
    expect((await check(push.id)).next?.status).toBe('up')

    // The timer has not noticed yet: the verdict is still "online", but older than the re-check age.
    uplink = false
    clock += 15_000
    await setLastPush(push.id, 600)
    const held = await check(push.id)
    expect(held.heartbeat?.msg).toBe(CHECKER_OFFLINE_MSG)
    expect(held.next?.notify).toBe(false)
    expect(handle.monitor.snapshot().status).toBe('offline')
    await handle.outbox.flush()
    expect(notices.filter((n) => n.kind === 'offline')).toHaveLength(2)

    uplink = true
    await tick()
  })

  it('holds a late cron push monitor (#216) and keeps its push state', async () => {
    const cron = await createMonitor({
      name: 'push cron',
      type: 'push',
      pushToken: `c${run}`,
      pushSchedule: 'cron',
      pushCron: '* * * * *',
      pushGrace: 60,
    })
    await setLastPush(cron.id, 1)
    expect((await check(cron.id)).next?.status).toBe('up')

    uplink = false
    await tick()
    await setLastPush(cron.id, 3600)
    const pushedAt = (await findMonitor(cron.id)).status?.lastPushAt
    const held = await check(cron.id)
    expect(held.heartbeat?.status).toBe('pending')
    expect(held.heartbeat?.msg).toBe(CHECKER_OFFLINE_MSG)
    expect(held.next).toMatchObject({ notify: false, notificationEvent: null })
    const during = await findMonitor(cron.id)
    expect(during.status?.lastStatus).toBe('up')
    expect(during.status?.lastPushAt).toBe(pushedAt)

    uplink = true
    await tick()
    // Back online, the missed push is a real verdict again.
    const down = await check(cron.id)
    expect(down.next).toMatchObject({ status: 'down', notify: true })
  })

  it('publishes the verdict for the health endpoint and metrics', async () => {
    process.env.CONNECTIVITY_CHECK_ENABLED = '1'
    resetEnvCache()
    try {
      const summary = await getCheckerSummary({ redis, prefix: statePrefix })
      expect(summary.status).toBe('online')
      expect(summary.locations).toEqual([
        expect.objectContaining({ location: 'default', status: 'online' }),
      ])

      // A second worker of the location that is offline makes the location offline.
      await publishCheckerState(
        {
          location: 'default',
          status: 'offline',
          since: '2026-10-07T10:00:00.000Z',
          checkedAt: '2026-10-07T10:01:00.000Z',
          results: [],
        },
        'other-worker',
        60,
        { redis, prefix: statePrefix },
      )
      const offline = await getCheckerSummary({ redis, prefix: statePrefix })
      expect(offline).toMatchObject({ status: 'offline', since: '2026-10-07T10:00:00.000Z' })
    } finally {
      delete process.env.CONNECTIVITY_CHECK_ENABLED
      resetEnvCache()
    }
    expect((await getCheckerSummary()).status).toBe('disabled')
  })
})

describe('which monitors keep running while offline', () => {
  it('runs private and local targets, holds everything else', async () => {
    const monitor = (data: Partial<Monitor>) => ({ id: 1, ...data }) as Monitor
    const needs = (data: Partial<Monitor>) => monitorNeedsInternet(payload, monitor(data))

    expect(await needs({ type: 'http', url: 'http://192.168.1.10:8080/' })).toBe(false)
    expect(await needs({ type: 'http', url: 'https://nas.local/' })).toBe(false)
    expect(await needs({ type: 'port', hostname: 'localhost' })).toBe(false)
    expect(await needs({ type: 'ping', hostname: '10.0.0.1' })).toBe(false)
    expect(await needs({ type: 'group' })).toBe(false)
    expect(
      await needs({ type: 'postgres', databaseConnectionString: 'postgres://u:p@db:5432/x' }),
    ).toBe(false)

    expect(await needs({ type: 'http', url: 'https://1.1.1.1/' })).toBe(true)
    expect(await needs({ type: 'http', url: 'https://marmot-connectivity.invalid/' })).toBe(true)
    expect(await needs({ type: 'push' })).toBe(true)
    expect(await needs({ type: 'port', hostname: '' })).toBe(true)
  })
})

describe('default notice delivery', () => {
  it('emails every superadmin in their language', async () => {
    const email = `checker-root-${run}@example.com`
    await payload.create({
      collection: 'users',
      data: { email, password: 'correct-horse-battery', name: 'root', superadmin: true },
      overrideAccess: true,
    })
    const sendEmail = vi.spyOn(payload, 'sendEmail').mockResolvedValue(undefined as never)
    try {
      await deliverCheckerNotice(payload, {
        kind: 'offline',
        location: 'default',
        at: '2026-10-07T10:00:00.000Z',
        results: [{ target: '1.1.1.1:53', ok: false, ms: null, error: 'ENETUNREACH' }],
      })
      const mine = sendEmail.mock.calls.find(([message]) => message.to === email)
      expect(mine?.[0]).toMatchObject({ subject: 'Marmot checker offline' })
      expect(String(mine?.[0].text)).toContain('1.1.1.1:53 failed (ENETUNREACH)')
    } finally {
      sendEmail.mockRestore()
    }
  })
})
