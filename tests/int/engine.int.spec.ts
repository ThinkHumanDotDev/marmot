import dgram from 'node:dgram'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { Redis } from 'ioredis'
import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import type { Monitor } from '@/payload-types'
import {
  clearHeartbeatListeners,
  createQueue,
  monitorSchedulerId,
  processCheckJob,
  QUEUE_NAMES,
  registerHeartbeatListener,
  removeMonitorSchedule,
  resyncAll,
  startCheckWorker,
  syncMonitor,
  type ChecksQueue,
  type HeartbeatEvent,
} from '@/server/engine'
import { getMonitorType, listMonitorTypes } from '@/server/monitor-types'
import { checkStatusCode } from '@/server/monitor-types/http-request'
import { evaluateJsonQuery } from '@/server/monitor-types/json-query'
import { parsePingTime } from '@/server/monitor-types/ping'

let payload: Payload
let httpServer: http.Server
let httpPort: number
let tcpServer: net.Server
let tcpPort: number
let dnsServer: dgram.Socket
let dnsPort: number

/** Queue stub so the DB tests never touch Redis; records scheduler calls for assertions. */
function fakeQueue() {
  const upserts: { key: string; every: number }[] = []
  const removals: string[] = []
  const queue = {
    upsertJobScheduler: vi.fn(async (key: string, opts: { every?: number }) => {
      upserts.push({ key, every: opts.every ?? 0 })
    }),
    removeJobScheduler: vi.fn(async (key: string) => {
      removals.push(key)
      return true
    }),
  } as unknown as ChecksQueue
  return { queue, upserts, removals }
}

type MonitorInput = RequiredDataFromCollectionSlug<'monitors'>

async function createMonitor(data: Partial<Monitor> & { name: string; type: Monitor['type'] }) {
  return (await payload.create({
    collection: 'monitors',
    overrideAccess: true,
    depth: 0,
    data: {
      interval: 60,
      retryInterval: 20,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 5,
      ...data,
    } as MonitorInput,
  })) as Monitor
}

/** Default stub so no DB test ever touches the shared `marmot:` Redis namespace. */
const defaultQueue = fakeQueue().queue

const run = (monitorId: string | number, queue: ChecksQueue = defaultQueue) =>
  processCheckJob(payload, { data: { monitorId: String(monitorId) } }, { queue })

/** Minimal DNS responder: answers every A question with 127.0.0.1. */
function startDnsServer(): Promise<dgram.Socket> {
  const socket = dgram.createSocket('udp4')
  socket.on('message', (msg, rinfo) => {
    const qdcount = msg.readUInt16BE(4)
    // Parse the question name to find its end.
    let offset = 12
    while (msg[offset] !== 0) offset += msg[offset] + 1
    const qend = offset + 1 + 4 // null byte + QTYPE + QCLASS
    const question = msg.subarray(12, qend)

    const header = Buffer.alloc(12)
    msg.copy(header, 0, 0, 2) // id
    header.writeUInt16BE(0x8180, 2) // standard response, recursion available
    header.writeUInt16BE(qdcount, 4)
    header.writeUInt16BE(1, 6) // ANCOUNT
    header.writeUInt16BE(0, 8)
    header.writeUInt16BE(0, 10)

    const answer = Buffer.alloc(16)
    answer.writeUInt16BE(0xc00c, 0) // pointer to the question name
    answer.writeUInt16BE(1, 2) // TYPE A
    answer.writeUInt16BE(1, 4) // CLASS IN
    answer.writeUInt32BE(60, 6) // TTL
    answer.writeUInt16BE(4, 10) // RDLENGTH
    Buffer.from([127, 0, 0, 1]).copy(answer, 12)

    socket.send(Buffer.concat([header, question, answer]), rinfo.port, rinfo.address)
  })
  return new Promise((resolve) => socket.bind(0, '127.0.0.1', () => resolve(socket)))
}

beforeAll(async () => {
  payload = await getPayload({ config })
  await payload.delete({ collection: 'heartbeats', where: {}, overrideAccess: true })
  await payload.delete({ collection: 'monitors', where: {}, overrideAccess: true })

  httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    switch (url.pathname) {
      case '/':
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html><body>hello marmot</body></html>')
        return
      case '/json':
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', data: { count: 3 } }))
        return
      case '/redirect':
        res.writeHead(302, { location: '/' })
        res.end()
        return
      case '/auth':
        res.writeHead(req.headers.authorization ? 200 : 401)
        res.end(req.headers.authorization ?? 'nope')
        return
      case '/echo':
        res.writeHead(200, { 'content-type': 'text/plain' })
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => res.end(`${req.method} ${req.headers['content-type']} ${body}`))
        return
      case '/slow':
        return // never answers
      default:
        res.writeHead(500)
        res.end('server error')
    }
  })
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r))
  httpPort = (httpServer.address() as AddressInfo).port

  tcpServer = net.createServer((socket) => socket.end())
  await new Promise<void>((r) => tcpServer.listen(0, '127.0.0.1', r))
  tcpPort = (tcpServer.address() as AddressInfo).port

  dnsServer = await startDnsServer()
  dnsPort = dnsServer.address().port
})

afterAll(async () => {
  httpServer?.closeAllConnections()
  await new Promise((r) => httpServer?.close(r))
  await new Promise((r) => tcpServer?.close(r))
  dnsServer?.close()
})

afterEach(() => clearHeartbeatListeners())

describe('monitor type registry', () => {
  it('registers the built-in types', () => {
    const names = listMonitorTypes()
      .map((t) => t.name)
      .sort()
    expect(names).toEqual(
      ['dns', 'group', 'http', 'json-query', 'keyword', 'manual', 'ping', 'port', 'push'].sort(),
    )
    expect(getMonitorType('http')?.label).toBe('HTTP(s)')
  })
})

describe('helpers', () => {
  it('checkStatusCode handles ranges and single codes', () => {
    expect(checkStatusCode(204, ['200-299'])).toBe(true)
    expect(checkStatusCode(304, ['200-299', '304'])).toBe(true)
    expect(checkStatusCode(500, ['200-299'])).toBe(false)
    expect(checkStatusCode(200, [])).toBe(false)
    expect(checkStatusCode(200, null)).toBe(false)
  })

  it('evaluateJsonQuery compares with every operator', async () => {
    const body = JSON.stringify({ status: 'ok', n: 3, items: [1, 2] })
    expect((await evaluateJsonQuery(body, 'status', '==', 'ok')).status).toBe(true)
    expect((await evaluateJsonQuery(body, 'status', '!=', 'ok')).status).toBe(false)
    expect((await evaluateJsonQuery(body, 'n', '>', '2')).status).toBe(true)
    expect((await evaluateJsonQuery(body, 'n', '<=', '2')).status).toBe(false)
    expect((await evaluateJsonQuery(body, 'status', 'contains', 'o')).status).toBe(true)
    expect((await evaluateJsonQuery(body, '$count(items)', '==', '2')).status).toBe(true)
    await expect(evaluateJsonQuery(body, 'items', '==', '1')).rejects.toThrow(/returned the array/)
    await expect(evaluateJsonQuery(body, 'missing', '==', '1')).rejects.toThrow(
      /Empty or undefined/,
    )
  })

  it('parsePingTime extracts the round trip time', () => {
    expect(parsePingTime('64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.045 ms')).toBe(0)
    expect(parsePingTime('64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.6 ms')).toBe(13)
    expect(parsePingTime('Request timeout')).toBeNull()
  })
})

describe('check pipeline (processCheckJob with a fake job)', () => {
  it('http: writes an UP heartbeat and refreshes the status cache', async () => {
    const monitor = await createMonitor({
      name: 'http-up',
      type: 'http',
      url: `http://127.0.0.1:${httpPort}/`,
    })
    const events: HeartbeatEvent[] = []
    registerHeartbeatListener((e) => {
      events.push(e)
    })

    const result = await run(monitor.id)
    expect(result.outcome).toBe('processed')
    expect(result.heartbeat).toMatchObject({
      status: 'up',
      msg: '200 - OK',
      important: true,
      retries: 0,
    })
    expect(result.heartbeat?.ping).toBeGreaterThanOrEqual(0)
    expect(String(result.heartbeat?.monitor)).toBe(String(monitor.id))

    const stored = await payload.find({
      collection: 'heartbeats',
      where: { monitor: { equals: monitor.id } },
      overrideAccess: true,
    })
    expect(stored.totalDocs).toBe(1)

    const refreshed = (await payload.findByID({
      collection: 'monitors',
      id: monitor.id,
      depth: 0,
      overrideAccess: true,
    })) as Monitor
    expect(refreshed.status).toMatchObject({
      lastStatus: 'up',
      lastMsg: '200 - OK',
      retries: 0,
      downCount: 0,
    })
    expect(refreshed.status?.lastCheckAt).toBeTruthy()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ isFirstBeat: true, notify: false })
    expect(events[0].previousStatus ?? null).toBeNull()
    expect(events[0].heartbeat.id).toBe(result.heartbeat?.id)
    expect(events[0].monitor.status?.lastStatus).toBe('up')
  })

  it('http: unexpected status goes DOWN, listener errors are swallowed', async () => {
    const monitor = await createMonitor({
      name: 'http-500',
      type: 'http',
      url: `http://127.0.0.1:${httpPort}/boom`,
    })
    registerHeartbeatListener(() => {
      throw new Error('listener exploded')
    })
    const result = await run(monitor.id)
    expect(result.heartbeat).toMatchObject({
      status: 'down',
      msg: '500 - Internal Server Error',
      important: true,
    })
    expect(result.next?.notify).toBe(true)
  })

  it('http: follows redirects, honours maxRedirects, accepted codes, auth and body', async () => {
    const follow = await createMonitor({
      name: 'http-redirect',
      type: 'http',
      url: `http://127.0.0.1:${httpPort}/redirect`,
    })
    expect((await run(follow.id)).heartbeat?.status).toBe('up')

    const noFollow = await createMonitor({
      name: 'http-no-redirect',
      type: 'http',
      url: `http://127.0.0.1:${httpPort}/redirect`,
      maxRedirects: 0,
      acceptedStatusCodes: ['300-399'],
    })
    expect((await run(noFollow.id)).heartbeat).toMatchObject({ status: 'up', msg: '302 - Found' })

    const basic = await createMonitor({
      name: 'http-basic',
      type: 'http',
      url: `http://127.0.0.1:${httpPort}/auth`,
      authMethod: 'basic',
      basicAuthUser: 'u',
      basicAuthPass: 'p',
    })
    expect((await run(basic.id)).heartbeat?.status).toBe('up')

    const bearer = await createMonitor({
      name: 'http-bearer',
      type: 'keyword',
      url: `http://127.0.0.1:${httpPort}/auth`,
      authMethod: 'bearer',
      bearerToken: 'tok',
      keyword: 'Bearer tok',
    })
    expect((await run(bearer.id)).heartbeat?.status).toBe('up')

    const post = await createMonitor({
      name: 'http-post',
      type: 'keyword',
      url: `http://127.0.0.1:${httpPort}/echo`,
      method: 'POST',
      body: '{"a":1}',
      httpBodyEncoding: 'json',
      headers: '{"X-Test": "1"}',
      keyword: 'POST application/json {"a":1}',
    })
    expect((await run(post.id)).heartbeat?.status).toBe('up')
  })

  it('http: the timeout aborts a hanging request', async () => {
    const monitor = await createMonitor({
      name: 'http-slow',
      type: 'http',
      url: `http://127.0.0.1:${httpPort}/slow`,
      timeout: 1,
    })
    const result = await run(monitor.id)
    expect(result.heartbeat).toMatchObject({ status: 'down', msg: 'timeout by AbortSignal (1s)' })
  })

  it('keyword: found / inverted / missing', async () => {
    const found = await createMonitor({
      name: 'kw-found',
      type: 'keyword',
      url: `http://127.0.0.1:${httpPort}/`,
      keyword: 'marmot',
    })
    expect((await run(found.id)).heartbeat).toMatchObject({
      status: 'up',
      msg: '200 - OK, keyword is found',
    })

    const inverted = await createMonitor({
      name: 'kw-inverted',
      type: 'keyword',
      url: `http://127.0.0.1:${httpPort}/`,
      keyword: 'marmot',
      invertKeyword: true,
    })
    const inv = await run(inverted.id)
    expect(inv.heartbeat?.status).toBe('down')
    expect(inv.heartbeat?.msg).toMatch(/keyword is present in \[hello marmot\]/)

    const missing = await createMonitor({
      name: 'kw-missing',
      type: 'keyword',
      url: `http://127.0.0.1:${httpPort}/`,
      keyword: 'badger',
    })
    const miss = await run(missing.id)
    expect(miss.heartbeat?.status).toBe('down')
    expect(miss.heartbeat?.msg).toMatch(/keyword is not in/)
  })

  it('json-query: passes and fails', async () => {
    const pass = await createMonitor({
      name: 'jq-pass',
      type: 'json-query',
      url: `http://127.0.0.1:${httpPort}/json`,
      jsonPath: 'data.count',
      jsonPathOperator: '>=',
      expectedValue: '3',
    })
    expect((await run(pass.id)).heartbeat).toMatchObject({
      status: 'up',
      msg: 'JSON query passes (comparing 3 >= 3)',
    })

    const failing = await createMonitor({
      name: 'jq-fail',
      type: 'json-query',
      url: `http://127.0.0.1:${httpPort}/json`,
      jsonPath: 'status',
      jsonPathOperator: '==',
      expectedValue: 'down',
    })
    expect((await run(failing.id)).heartbeat).toMatchObject({
      status: 'down',
      msg: 'JSON query does not pass (comparing ok == down)',
    })
  })

  it('port: open and closed TCP ports', async () => {
    const open = await createMonitor({
      name: 'port-open',
      type: 'port',
      hostname: '127.0.0.1',
      port: tcpPort,
    })
    const up = await run(open.id)
    expect(up.heartbeat?.status).toBe('up')
    expect(up.heartbeat?.msg).toMatch(/^\d+ ms$/)

    const closedServer = net.createServer()
    await new Promise<void>((r) => closedServer.listen(0, '127.0.0.1', r))
    const closedPort = (closedServer.address() as AddressInfo).port
    await new Promise((r) => closedServer.close(r))

    const closed = await createMonitor({
      name: 'port-closed',
      type: 'port',
      hostname: '127.0.0.1',
      port: closedPort,
    })
    const down = await run(closed.id)
    expect(down.heartbeat?.status).toBe('down')
    expect(down.heartbeat?.msg).toMatch(/^Connection failed/)
  })

  it('dns: resolves against a local resolver', async () => {
    const monitor = await createMonitor({
      name: 'dns-local',
      type: 'dns',
      hostname: 'marmot.test',
      dnsResolveServer: '127.0.0.1',
      dnsResolveType: 'A',
      port: dnsPort,
    })
    const result = await run(monitor.id)
    expect(result.heartbeat).toMatchObject({ status: 'up', msg: 'Records: 127.0.0.1' })
  })

  it('ping: reports a clear error when the binary is missing, or succeeds against localhost', async () => {
    const monitor = await createMonitor({
      name: 'ping-localhost',
      type: 'ping',
      hostname: '127.0.0.1',
      timeout: 2,
    })
    const result = await run(monitor.id)
    if (result.heartbeat?.status === 'down') {
      expect(result.heartbeat.msg).toMatch(/ping/i)
    } else {
      expect(result.heartbeat?.status).toBe('up')
      expect(result.heartbeat?.ping).toBeGreaterThanOrEqual(0)
    }
  })

  it('push: DOWN without a push, UP after a recent push, DOWN once it is stale', async () => {
    const monitor = await createMonitor({ name: 'push', type: 'push', interval: 60 })
    expect(monitor.pushToken).toMatch(/^[0-9a-f]{32}$/)

    const none = await run(monitor.id)
    expect(none.heartbeat).toMatchObject({
      status: 'down',
      msg: 'No heartbeat in the time window',
      duration: 60,
    })

    await payload.update({
      collection: 'monitors',
      id: monitor.id,
      overrideAccess: true,
      context: { skipEngineSync: true },
      data: { status: { lastPushAt: new Date().toISOString() } },
    })
    const fresh = await run(monitor.id)
    expect(fresh.heartbeat?.status).toBe('up')
    expect(fresh.next?.important).toBe(true) // down -> up

    await payload.update({
      collection: 'monitors',
      id: monitor.id,
      overrideAccess: true,
      context: { skipEngineSync: true },
      data: { status: { lastPushAt: new Date(Date.now() - 5 * 60_000).toISOString() } },
    })
    const stale = await run(monitor.id)
    expect(stale.heartbeat?.status).toBe('down')
    expect(stale.heartbeat?.duration).toBeGreaterThanOrEqual(300)
  })

  it('group: aggregates children; manual: uses manualStatus', async () => {
    const group = await createMonitor({ name: 'group', type: 'group' })
    expect((await run(group.id)).heartbeat).toMatchObject({ status: 'pending', msg: 'Group empty' })

    const childUp = await createMonitor({
      name: 'child-up',
      type: 'manual',
      manualStatus: 'up',
      parent: group.id,
    })
    const childDown = await createMonitor({
      name: 'child-down',
      type: 'manual',
      manualStatus: 'down',
      parent: group.id,
    })
    const paused = await createMonitor({
      name: 'child-paused',
      type: 'manual',
      manualStatus: 'down',
      parent: group.id,
      active: false,
    })

    expect((await run(childUp.id)).heartbeat).toMatchObject({ status: 'up', msg: 'Up' })
    expect((await run(childDown.id)).heartbeat).toMatchObject({ status: 'down', msg: 'Down' })
    const skipped = await run(paused.id)
    expect(skipped).toMatchObject({ outcome: 'skipped', reason: 'inactive' })

    const agg = await run(group.id)
    expect(agg.heartbeat).toMatchObject({ status: 'down', msg: 'Child monitors down: child-down' })

    await payload.update({
      collection: 'monitors',
      id: childDown.id,
      overrideAccess: true,
      data: { manualStatus: 'up' },
    })
    await run(childDown.id)
    expect((await run(group.id)).heartbeat).toMatchObject({
      status: 'up',
      msg: 'All children up and running',
    })
  })

  it('retries: PENDING switches the scheduler to retryInterval and back', async () => {
    const monitor = await createMonitor({
      name: 'retry',
      type: 'port',
      hostname: '127.0.0.1',
      port: 1, // closed
      interval: 60,
      retryInterval: 20,
      maxRetries: 1,
    })
    const { queue, upserts } = fakeQueue()

    // first beat ever: important (first beat) but not notified (pending)
    const b1 = await run(monitor.id, queue)
    expect(b1.heartbeat).toMatchObject({ status: 'pending', retries: 1, important: true })
    expect(b1.next?.notify).toBe(false)
    expect(upserts).toEqual([{ key: monitorSchedulerId(monitor.id), every: 20_000 }])

    const b2 = await run(monitor.id, queue)
    expect(b2.heartbeat).toMatchObject({ status: 'down', retries: 2, important: true })
    expect(b2.next?.notify).toBe(true)
    expect(upserts).toHaveLength(2)
    expect(upserts[1]).toEqual({ key: monitorSchedulerId(monitor.id), every: 60_000 })

    const b3 = await run(monitor.id, queue)
    expect(b3.heartbeat).toMatchObject({ status: 'down', retries: 3, important: false })
    expect(upserts).toHaveLength(2) // cadence unchanged
    expect(b3.heartbeat?.duration).toBeGreaterThanOrEqual(0)
  })

  it('unknown monitor removes its scheduler', async () => {
    const { queue, removals } = fakeQueue()
    const result = await processCheckJob(payload, { data: { monitorId: '999999' } }, { queue })
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'not-found' })
    expect(removals).toEqual([monitorSchedulerId('999999')])
  })
})

describe('BullMQ job schedulers', () => {
  let redisAvailable = false
  let queue: ChecksQueue | undefined
  const prefix = `marmot-test-${Math.random().toString(36).slice(2, 10)}`

  beforeAll(async () => {
    const probe = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      lazyConnect: true,
      connectTimeout: 2000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    })
    try {
      await probe.connect()
      await probe.ping()
      redisAvailable = true
    } catch {
      redisAvailable = false
    } finally {
      probe.disconnect()
    }
    if (redisAvailable) {
      queue = createQueue(QUEUE_NAMES.checks, { prefix })
    }
  })

  afterAll(async () => {
    if (queue) {
      await queue.obliterate({ force: true })
      await queue.close()
    }
  })

  it('syncMonitor upserts a scheduler, removeMonitorSchedule drops it', async (ctx) => {
    if (!queue) return ctx.skip()
    const monitor = await createMonitor({
      name: 'bull-sync',
      type: 'http',
      url: `http://127.0.0.1:${httpPort}/`,
      interval: 60,
    })

    await syncMonitor(monitor, queue)
    let schedulers = await queue.getJobSchedulers()
    const mine = schedulers.find((s) => s.key === monitorSchedulerId(monitor.id))
    expect(mine).toBeDefined()
    expect(mine?.every).toBe(60_000)
    expect(mine?.name).toBe('check')
    expect(mine?.template?.data).toEqual({ monitorId: String(monitor.id) })

    // pending → retryInterval
    await syncMonitor({ ...monitor, status: { lastStatus: 'pending' } }, queue)
    schedulers = await queue.getJobSchedulers()
    expect(schedulers.find((s) => s.key === monitorSchedulerId(monitor.id))?.every).toBe(20_000)

    await removeMonitorSchedule(monitor.id, queue)
    schedulers = await queue.getJobSchedulers()
    expect(schedulers.find((s) => s.key === monitorSchedulerId(monitor.id))).toBeUndefined()
  })

  it('a live worker processes scheduled checks and writes heartbeats', async (ctx) => {
    if (!queue) return ctx.skip()
    const monitor = await createMonitor({
      name: 'bull-live',
      type: 'http',
      url: `http://127.0.0.1:${httpPort}/`,
      interval: 1,
      retryInterval: 1,
    })
    await syncMonitor(monitor, queue)
    const worker = startCheckWorker(payload, { prefix, concurrency: 2 })
    try {
      await worker.waitUntilReady()
      const deadline = Date.now() + 15_000
      let count = 0
      while (Date.now() < deadline) {
        const found = await payload.count({
          collection: 'heartbeats',
          where: { monitor: { equals: monitor.id } },
          overrideAccess: true,
        })
        count = found.totalDocs
        if (count >= 2) break
        await new Promise((r) => setTimeout(r, 250))
      }
      expect(count).toBeGreaterThanOrEqual(2)
    } finally {
      await worker.close()
      await removeMonitorSchedule(monitor.id, queue)
    }
  })

  it('resyncAll removes stale schedulers and upserts active monitors', async (ctx) => {
    if (!queue) return ctx.skip()
    await queue.upsertJobScheduler(
      'monitor:stale-1' as 'check',
      { every: 60_000 },
      { name: 'check' },
    )

    const active = await createMonitor({
      name: 'bull-active',
      type: 'http',
      url: `http://127.0.0.1:${httpPort}/`,
    })
    const paused = await createMonitor({
      name: 'bull-paused',
      type: 'http',
      url: `http://127.0.0.1:${httpPort}/`,
      active: false,
    })

    const summary = await resyncAll(payload, queue)
    expect(summary.removed).toBeGreaterThanOrEqual(1)
    expect(summary.upserted).toBeGreaterThanOrEqual(1)

    const keys = (await queue.getJobSchedulers()).map((s) => s.key)
    expect(keys).toContain(monitorSchedulerId(active.id))
    expect(keys).not.toContain(monitorSchedulerId(paused.id))
    expect(keys).not.toContain('monitor:stale-1')
  })
})
