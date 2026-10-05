import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createAdapter } from '@socket.io/redis-adapter'
import type { Redis } from 'ioredis'
import { getPayload, type Payload } from 'payload'
import { io as connect, type Socket } from 'socket.io-client'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { env } from '@/env'
import type { Monitor, Organization, User } from '@/payload-types'
import { createRedis } from '@/server/redis'
import {
  closeEmitter,
  configureEmitter,
  emitHeartbeat,
  emitMonitorDeleted,
  emitMonitorUpdated,
  emitUptime,
} from '@/server/realtime/emitter'
import {
  RealtimeEvents,
  type ClientToServerEvents,
  type JoinOrgAck,
  type RealtimePayloads,
  type ServerToClientEvents,
} from '@/server/realtime/events'
import { canJoinOrg, createRealtimeServer, type RealtimeServer } from '@/server/realtime/server'
import { recordHeartbeat } from '@/server/stats/uptime-calculator'

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>

/** Unique per run so parallel suites can share Redis and the database. */
const run = `${Date.now().toString(36)}-${process.pid}`
const email = (name: string) => `realtime-${name}-${run}@marmot.test`
const PASSWORD = 'realtime-password-123'

let payload: Payload
let httpServer: HttpServer
let io: RealtimeServer
let pub: Redis
let sub: Redis
let url: string

let org: Organization
let otherOrg: Organization
let member: User
let superadmin: User
let monitor: Monitor
let pausedMonitor: Monitor
let otherMonitor: Monitor
let memberToken: string
let superadminToken: string

const clients: ClientSocket[] = []

const MONITOR_DEFAULTS = {
  type: 'manual' as const,
  interval: 60,
  retryInterval: 60,
  maxRetries: 0,
  resendInterval: 0,
  timeout: 48,
}

/**
 * Open a client the way a browser would: the session cookie plus the `Origin` of the web app,
 * which Payload checks against its CSRF allowlist before it accepts a cookie token.
 */
function open(cookie?: string, origin: string = env.NEXT_PUBLIC_SERVER_URL): ClientSocket {
  const socket: ClientSocket = connect(url, {
    path: '/socket.io',
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    autoConnect: false,
    extraHeaders: cookie ? { Cookie: cookie, Origin: origin } : { Origin: origin },
  })
  clients.push(socket)
  return socket
}

/** Resolve with the first `event` payload matching `predicate` (default: any) within `ms`. */
function waitFor<E extends keyof RealtimePayloads>(
  socket: ClientSocket,
  event: E,
  predicate: (payload: RealtimePayloads[E]) => boolean = () => true,
  ms = 10_000,
): Promise<RealtimePayloads[E]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler as never)
      reject(new Error(`timed out waiting for "${event}"`))
    }, ms)
    const handler = (payload: RealtimePayloads[E]) => {
      if (!predicate(payload)) return
      clearTimeout(timer)
      socket.off(event, handler as never)
      resolve(payload)
    }
    socket.on(event, handler as never)
  })
}

/** Collect every `event` payload for `ms` milliseconds. */
function collect<E extends keyof RealtimePayloads>(
  socket: ClientSocket,
  event: E,
  ms: number,
): Promise<RealtimePayloads[E][]> {
  return new Promise((resolve) => {
    const seen: RealtimePayloads[E][] = []
    const handler = (payload: RealtimePayloads[E]) => {
      seen.push(payload)
    }
    socket.on(event, handler as never)
    setTimeout(() => {
      socket.off(event, handler as never)
      resolve(seen)
    }, ms)
  })
}

function connected(socket: ClientSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('connect_error', (err) => reject(err))
    socket.connect()
  })
}

function joinOrg(socket: ClientSocket, organizationId: string): Promise<JoinOrgAck> {
  return new Promise((resolve) => {
    socket.emit('joinOrg', organizationId, (ack) => resolve(ack))
  })
}

async function createUser(name: string, superadminFlag = false): Promise<User> {
  return payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name, superadmin: superadminFlag },
  })
}

async function login(user: User): Promise<string> {
  const result = await payload.login({
    collection: 'users',
    data: { email: user.email, password: PASSWORD },
  })
  if (!result.token) throw new Error('login returned no token')
  return result.token
}

describe('realtime: socket.io server + Redis emitter', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })

    // ---- Fixtures ------------------------------------------------------------------------------
    org = await payload.create({
      collection: 'organizations',
      data: { name: 'Realtime', slug: `realtime-${run}` },
    })
    otherOrg = await payload.create({
      collection: 'organizations',
      data: { name: 'Elsewhere', slug: `elsewhere-${run}` },
    })
    member = await createUser('member')
    superadmin = await createUser('superadmin', true)
    await payload.update({
      collection: 'users',
      id: member.id,
      data: { organizations: [{ organization: org.id, role: 'member' }] },
      depth: 0,
    })

    monitor = await payload.create({
      collection: 'monitors',
      data: { ...MONITOR_DEFAULTS, name: 'Realtime API', organization: org.id, active: true },
      depth: 0,
    })
    pausedMonitor = await payload.create({
      collection: 'monitors',
      data: { ...MONITOR_DEFAULTS, name: 'Realtime paused', organization: org.id, active: false },
      depth: 0,
    })
    otherMonitor = await payload.create({
      collection: 'monitors',
      data: { ...MONITOR_DEFAULTS, name: 'Other org', organization: otherOrg.id, active: true },
      depth: 0,
    })

    const now = Date.now()
    const beats = [
      { status: 'down' as const, ping: null, important: true, offset: 3 },
      { status: 'up' as const, ping: 120, important: true, offset: 2 },
      { status: 'up' as const, ping: 80, important: false, offset: 1 },
    ]
    for (const beat of beats) {
      await payload.create({
        collection: 'heartbeats',
        data: {
          monitor: monitor.id,
          organization: org.id,
          status: beat.status,
          ping: beat.ping,
          important: beat.important,
          msg: beat.status,
          time: new Date(now - beat.offset * 60_000).toISOString(),
        },
        depth: 0,
      })
    }
    await recordHeartbeat(payload, {
      monitorId: monitor.id,
      organizationId: org.id,
      status: 'up',
      ping: 100,
    })

    memberToken = await login(member)
    superadminToken = await login(superadmin)

    // ---- Realtime server on a random port with a namespaced Redis adapter ------------------------
    const key = `marmot-test-${run}`
    pub = createRedis()
    sub = pub.duplicate()
    httpServer = createServer()
    io = createRealtimeServer({
      payload,
      httpServer,
      adapter: createAdapter(pub, sub, { key }),
      version: 'test',
    })
    await configureEmitter({ key })
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`
  })

  afterEach(() => {
    for (const socket of clients.splice(0)) socket.disconnect()
  })

  afterAll(async () => {
    await io?.close()
    await closeEmitter()
    pub?.disconnect()
    sub?.disconnect()

    const monitorIds = [monitor?.id, pausedMonitor?.id, otherMonitor?.id].filter(Boolean)
    if (monitorIds.length) {
      for (const collection of [
        'heartbeats',
        'stat-minutely',
        'stat-hourly',
        'stat-daily',
      ] as const) {
        await payload.delete({ collection, where: { monitor: { in: monitorIds } } })
      }
      await payload.delete({ collection: 'monitors', where: { id: { in: monitorIds } } })
    }
    const orgIds = [org?.id, otherOrg?.id].filter(Boolean)
    if (orgIds.length) {
      await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
    }
    await payload.delete({ collection: 'users', where: { email: { like: `-${run}@marmot.test` } } })
  })

  it('rejects a connection without a Payload session cookie', async () => {
    const socket = open()
    await expect(connected(socket)).rejects.toThrow('unauthorized')
    expect(socket.connected).toBe(false)
  })

  it('rejects a forged cookie', async () => {
    const socket = open('payload-token=not-a-real-token')
    await expect(connected(socket)).rejects.toThrow('unauthorized')
  })

  it('rejects a valid cookie sent from a foreign origin (CSRF)', async () => {
    const socket = open(`payload-token=${memberToken}`, 'https://evil.example')
    await expect(connected(socket)).rejects.toThrow('unauthorized')
  })

  it('sends info, the monitor list, heartbeats and uptime of the member’s organization on connect', async () => {
    const socket = open(`payload-token=${memberToken}`)
    const info = waitFor(socket, RealtimeEvents.info)
    const monitorList = waitFor(socket, RealtimeEvents.monitorList)
    const heartbeatList = waitFor(
      socket,
      RealtimeEvents.heartbeatList,
      (p) => p.monitorId === String(monitor.id),
    )
    const importantList = waitFor(
      socket,
      RealtimeEvents.importantHeartbeatList,
      (p) => p.monitorId === String(monitor.id),
    )
    const uptime24h = waitFor(
      socket,
      RealtimeEvents.uptime,
      (p) => p.monitorId === String(monitor.id) && p.range === '24h',
    )
    const uptime30d = waitFor(
      socket,
      RealtimeEvents.uptime,
      (p) => p.monitorId === String(monitor.id) && p.range === '30d',
    )
    const avgPing = waitFor(
      socket,
      RealtimeEvents.avgPing,
      (p) => p.monitorId === String(monitor.id) && p.range === '24h',
    )
    await connected(socket)

    expect(await info).toMatchObject({ version: 'test' })
    expect(Date.parse((await info).serverTime)).not.toBeNaN()

    const list = await monitorList
    expect(list.organizationId).toBe(String(org.id))
    // Active and paused monitors of this org, nothing from the other org.
    expect(list.monitors.map((m) => m.id).sort()).toEqual(
      [String(monitor.id), String(pausedMonitor.id)].sort(),
    )
    expect(list.monitors.find((m) => m.id === String(monitor.id))).toMatchObject({
      name: 'Realtime API',
      type: 'manual',
      active: true,
      interval: 60,
      organization: String(org.id),
    })
    expect(list.monitors.find((m) => m.id === String(pausedMonitor.id))?.active).toBe(false)

    const beats = await heartbeatList
    expect(beats.organizationId).toBe(String(org.id))
    expect(beats.heartbeats.map((b) => b.status)).toEqual(['down', 'up', 'up'])
    expect(beats.heartbeats.map((b) => b.ping)).toEqual([null, 120, 80])
    expect(beats.heartbeats.every((b) => b.monitor === String(monitor.id))).toBe(true)
    // oldest → newest
    const times = beats.heartbeats.map((b) => Date.parse(b.time))
    expect([...times].sort((a, b) => a - b)).toEqual(times)

    expect((await importantList).heartbeats.map((b) => b.status)).toEqual(['down', 'up'])

    expect(await uptime24h).toMatchObject({ organizationId: String(org.id), value: 1 })
    expect((await uptime30d).value).toBe(1)
    expect((await avgPing).value).toBe(100)
  })

  it('delivers events published through the Redis emitter to the organization room', async () => {
    const socket = open(`payload-token=${memberToken}`)
    const ready = waitFor(socket, RealtimeEvents.monitorList)
    await connected(socket)
    await ready

    const heartbeat = waitFor(socket, RealtimeEvents.heartbeat)
    const time = new Date().toISOString()
    emitHeartbeat(org.id, {
      monitorId: monitor.id,
      heartbeat: {
        monitor: String(monitor.id),
        status: 'down',
        time,
        ping: null,
        msg: 'Connection refused',
        important: true,
      },
    })
    expect(await heartbeat).toEqual({
      organizationId: String(org.id),
      monitorId: String(monitor.id),
      heartbeat: {
        monitor: String(monitor.id),
        status: 'down',
        time,
        ping: null,
        msg: 'Connection refused',
        important: true,
      },
    })

    const updated = waitFor(socket, RealtimeEvents.updateMonitorIntoList)
    emitMonitorUpdated(org.id, { ...monitor, name: 'Renamed' })
    expect(await updated).toMatchObject({
      organizationId: String(org.id),
      monitor: { id: String(monitor.id), name: 'Renamed', type: 'manual' },
    })

    const uptime = waitFor(socket, RealtimeEvents.uptime, (p) => p.value === 0.5)
    emitUptime(org.id, monitor.id, '24h', 0.5)
    expect(await uptime).toMatchObject({ monitorId: String(monitor.id), range: '24h' })

    const deleted = waitFor(socket, RealtimeEvents.deleteMonitorFromList)
    emitMonitorDeleted(org.id, monitor.id)
    expect(await deleted).toEqual({
      organizationId: String(org.id),
      monitorId: String(monitor.id),
    })
  })

  it('does not leak events of organizations the user is not a member of', async () => {
    const socket = open(`payload-token=${memberToken}`)
    const lists = collect(socket, RealtimeEvents.monitorList, 1_500)
    const foreign = collect(socket, RealtimeEvents.heartbeat, 1_500)
    await connected(socket)
    emitHeartbeat(otherOrg.id, {
      monitorId: otherMonitor.id,
      heartbeat: { monitor: String(otherMonitor.id), status: 'up', time: new Date().toISOString() },
    })

    expect((await lists).map((l) => l.organizationId)).toEqual([String(org.id)])
    expect(await foreign).toEqual([])

    expect(await joinOrg(socket, String(otherOrg.id))).toEqual({ ok: false, error: 'forbidden' })
    expect(canJoinOrg(member, otherOrg.id)).toBe(false)
  })

  it('lets a superadmin join any organization and receive its state', async () => {
    const socket = open(`payload-token=${superadminToken}`)
    const nothing = collect(socket, RealtimeEvents.monitorList, 500)
    await connected(socket)
    // Superadmins have no memberships, so nothing is sent until they ask.
    expect(await nothing).toEqual([])

    const list = waitFor(socket, RealtimeEvents.monitorList)
    expect(await joinOrg(socket, String(otherOrg.id))).toEqual({ ok: true })
    expect(await list).toMatchObject({
      organizationId: String(otherOrg.id),
      monitors: [{ id: String(otherMonitor.id), name: 'Other org' }],
    })

    // Joining twice does not resend the state.
    const again = collect(socket, RealtimeEvents.monitorList, 500)
    expect(await joinOrg(socket, String(otherOrg.id))).toEqual({ ok: true })
    expect(await again).toEqual([])

    expect(await joinOrg(socket, '999999999')).toEqual({ ok: false, error: 'not found' })
  })
})
