import { Redis } from 'ioredis'
import { getPayload, type Payload } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import type { Role } from '@/access/permissions'
import { POST as createRoute, GET as listRoute } from '@/app/api/orgs/[orgId]/notifications/route'
import { POST as testRoute } from '@/app/api/orgs/[orgId]/notifications/test/route'
import type { Heartbeat, Monitor, Notification, Organization, User } from '@/payload-types'
import { createQueue, QUEUE_NAMES } from '@/server/engine'
import {
  enqueueNotificationsForHeartbeat,
  notificationJobId,
  processNotificationJob,
  startNotificationWorker,
  type NotificationsQueue,
} from '@/server/notifications'

let payload: Payload

/** Unique per run so tests can share a database with other runs. */
const run = Date.now().toString(36)
const email = (name: string) => `notif-${name}+${run}@marmot.test`
const PASSWORD = 'password-123'

let org: Organization
let otherOrg: Organization
let admin: User
let member: User
let outsider: User

type RequestUser = User & { collection: 'users' }

async function as(user: { id: User['id'] }): Promise<RequestUser> {
  const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
  return { ...fresh, collection: 'users' }
}

async function createUser(name: string): Promise<User> {
  return payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name },
  })
}

async function addMembership(user: User, target: Organization, role: Role): Promise<void> {
  const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
  const rows = (fresh.organizations ?? []).map((row) => ({
    id: row.id,
    organization: typeof row.organization === 'object' ? row.organization.id : row.organization,
    role: row.role,
  }))
  await payload.update({
    collection: 'users',
    id: user.id,
    data: { organizations: [...rows, { organization: target.id, role }] },
    depth: 0,
  })
}

async function authHeaders(user: User): Promise<Record<string, string>> {
  const { token } = await payload.login({
    collection: 'users',
    data: { email: user.email, password: PASSWORD },
  })
  return { Authorization: `JWT ${token}` }
}

const MONITOR_DEFAULTS = {
  type: 'http' as const,
  url: 'https://example.com',
  active: false,
  interval: 60,
  retryInterval: 60,
  maxRetries: 0,
  resendInterval: 0,
  timeout: 48,
}

async function createMonitor(data: Partial<Monitor> & { name: string }): Promise<Monitor> {
  return (await payload.create({
    collection: 'monitors',
    depth: 0,
    overrideAccess: true,
    data: { ...MONITOR_DEFAULTS, organization: org.id, ...data } as never,
  })) as Monitor
}

async function createChannel(
  data: Partial<Notification> & { name: string },
  options: { user?: RequestUser } = {},
): Promise<Notification> {
  return (await payload.create({
    collection: 'notifications',
    depth: 0,
    data: {
      type: 'discord',
      config: { webhookUrl: 'https://discord.com/api/webhooks/1/test' },
      organization: org.id,
      ...data,
    } as never,
    ...(options.user ? { user: options.user, overrideAccess: false } : { overrideAccess: true }),
  })) as Notification
}

async function createHeartbeat(monitor: Monitor, status: Heartbeat['status'], msg: string) {
  return (await payload.create({
    collection: 'heartbeats',
    depth: 0,
    overrideAccess: true,
    data: {
      monitor: monitor.id,
      organization: org.id,
      status,
      msg,
      ping: status === 'up' ? 42 : null,
      important: true,
      time: new Date().toISOString(),
    } as never,
  })) as Heartbeat
}

const monitorNotificationIds = (monitor: Monitor) =>
  (monitor.notifications ?? []).map((n) => String(typeof n === 'object' ? n.id : n))

type FetchCall = { url: string; body: unknown }
let fetchCalls: FetchCall[]

function stubFetch(status = 200) {
  fetchCalls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      let body: unknown = init?.body
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body)
        } catch {
          body = init.body
        }
      }
      fetchCalls.push({ url, body })
      return new Response(status === 200 ? '{"ok":true}' : '{"message":"Invalid Webhook Token"}', {
        status,
      })
    }),
  )
}

let redisAvailable = false
const prefix = `marmot-test-${Math.random().toString(36).slice(2, 10)}`
let queue: NotificationsQueue | undefined

beforeAll(async () => {
  payload = await getPayload({ config })

  admin = await createUser('admin')
  member = await createUser('member')
  outsider = await createUser('outsider')

  org = await payload.create({
    collection: 'organizations',
    data: { name: 'Notify Co', slug: `notify-co-${run}` },
    user: await as(admin),
    overrideAccess: false,
  })
  otherOrg = await payload.create({
    collection: 'organizations',
    data: { name: 'Other Co', slug: `other-co-${run}` },
    user: await as(outsider),
    overrideAccess: false,
  })
  await addMembership(member, org, 'member')

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
  if (redisAvailable) queue = createQueue(QUEUE_NAMES.notifications, { prefix })
})

afterAll(async () => {
  if (queue) {
    await queue.obliterate({ force: true })
    await queue.close()
  }
  const orgIds = [org?.id, otherOrg?.id].filter(Boolean)
  if (orgIds.length) {
    await payload.delete({ collection: 'heartbeats', where: { organization: { in: orgIds } } })
    await payload.delete({ collection: 'monitors', where: { organization: { in: orgIds } } })
    await payload.delete({ collection: 'notifications', where: { organization: { in: orgIds } } })
    await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
  }
  await payload.delete({ collection: 'users', where: { email: { like: `+${run}@marmot.test` } } })
})

afterEach(() => vi.unstubAllGlobals())

describe('notifications collection', () => {
  it('validates the provider type and config against the schema', async () => {
    const fieldErrors = async (promise: Promise<unknown>) => {
      try {
        await promise
      } catch (error) {
        return (error as { data?: { errors?: { path: string; message: string }[] } }).data?.errors
      }
      throw new Error('expected the create to fail')
    }

    expect(await fieldErrors(createChannel({ name: 'bad-type', type: 'carrier-pigeon' }))).toEqual([
      { path: 'type', message: 'Unknown notification type "carrier-pigeon".' },
    ])
    const configErrors = await fieldErrors(
      createChannel({ name: 'bad-config', config: { webhookUrl: 'nope' } }),
    )
    expect(configErrors?.[0]).toMatchObject({ path: 'config.webhookUrl' })

    const ok = await createChannel({
      name: 'ntfy-defaults',
      type: 'ntfy',
      config: { topic: 'marmot' },
    })
    // Schema defaults are applied on save.
    expect(ok.config).toMatchObject({ topic: 'marmot', serverUrl: 'https://ntfy.sh', priority: 4 })
  })

  it('is org-scoped: admins write, members read, outsiders see nothing', async () => {
    const channel = await createChannel({ name: 'scoped' }, { user: await as(admin) })

    const asMember = await payload.find({
      collection: 'notifications',
      where: { id: { equals: channel.id } },
      user: await as(member),
      overrideAccess: false,
      depth: 0,
    })
    expect(asMember.docs.map((d) => d.id)).toEqual([channel.id])

    await expect(
      createChannel({ name: 'member-write' }, { user: await as(member) }),
    ).rejects.toThrow()

    const asOutsider = await payload.find({
      collection: 'notifications',
      where: { id: { equals: channel.id } },
      user: await as(outsider),
      overrideAccess: false,
      disableErrors: true,
      depth: 0,
    })
    expect(asOutsider.docs).toHaveLength(0)
  })

  it('auto-attaches the organization’s default channels to new monitors', async () => {
    const def = await createChannel({ name: 'default-1', isDefault: true })
    const inactiveDefault = await createChannel({
      name: 'default-inactive',
      isDefault: true,
      active: false,
    })
    await createChannel({ name: 'not-default' })

    const monitor = await createMonitor({ name: 'auto-attach' })
    expect(monitorNotificationIds(monitor)).toEqual([String(def.id)])
    expect(monitorNotificationIds(monitor)).not.toContain(String(inactiveDefault.id))

    // Explicit channels win over defaults.
    const explicit = await createChannel({ name: 'explicit' })
    const chosen = await createMonitor({
      name: 'explicit-attach',
      notifications: [explicit.id] as never,
    })
    expect(monitorNotificationIds(chosen)).toEqual([String(explicit.id)])

    // Monitors of other organizations are untouched.
    const foreign = (await payload.create({
      collection: 'monitors',
      depth: 0,
      overrideAccess: true,
      data: { ...MONITOR_DEFAULTS, name: 'foreign', organization: otherOrg.id } as never,
    })) as Monitor
    expect(monitorNotificationIds(foreign)).toEqual([])

    await payload.update({
      collection: 'notifications',
      id: def.id,
      data: { isDefault: false },
      overrideAccess: true,
    })
  })

  it('applyExisting attaches the channel to every monitor of the organization once', async () => {
    const a = await createMonitor({ name: 'existing-a' })
    const b = await createMonitor({ name: 'existing-b' })
    const channel = await createChannel({ name: 'apply-existing', applyExisting: true })

    for (const m of [a, b]) {
      const fresh = (await payload.findByID({
        collection: 'monitors',
        id: m.id,
        depth: 0,
      })) as Monitor
      expect(monitorNotificationIds(fresh)).toContain(String(channel.id))
    }

    // Saving again with the flag does not duplicate the relation.
    await payload.update({
      collection: 'notifications',
      id: channel.id,
      data: { applyExisting: true },
      overrideAccess: true,
    })
    const fresh = (await payload.findByID({
      collection: 'monitors',
      id: a.id,
      depth: 0,
    })) as Monitor
    expect(monitorNotificationIds(fresh).filter((id) => id === String(channel.id))).toHaveLength(1)

    // The virtual flag is never persisted.
    const stored = await payload.findByID({ collection: 'notifications', id: channel.id, depth: 0 })
    expect(stored.applyExisting).toBeFalsy()
  })
})

describe('notification pipeline', () => {
  it('marking a monitor down sends a Discord embed and records lastSentAt', async () => {
    stubFetch()
    const channel = await createChannel({
      name: 'discord-down',
      config: { webhookUrl: 'https://discord.com/api/webhooks/42/token', username: 'Marmot' },
    })
    const monitor = await createMonitor({
      name: 'Payments API',
      url: 'https://pay.example.com/health',
      notifications: [channel.id] as never,
    })
    const heartbeat = await createHeartbeat(monitor, 'down', 'Request failed with status code 503')

    const result = await processNotificationJob(payload, {
      data: {
        notificationId: String(channel.id),
        monitorId: String(monitor.id),
        heartbeatId: String(heartbeat.id),
        organizationId: String(org.id),
      },
    })
    expect(result.outcome).toBe('sent')

    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('https://discord.com/api/webhooks/42/token')
    const body = fetchCalls[0].body as {
      username: string
      embeds: { title: string; color: number; fields: { name: string; value: string }[] }[]
    }
    expect(body.username).toBe('Marmot')
    expect(body.embeds[0].color).toBe(16711680)
    expect(body.embeds[0].title).toBe('❌ Your service Payments API went down. ❌')
    expect(body.embeds[0].fields).toEqual(
      expect.arrayContaining([
        { name: 'Service Name', value: 'Payments API' },
        { name: 'Service URL', value: 'https://pay.example.com/health' },
        { name: 'Error', value: 'Request failed with status code 503' },
      ]),
    )

    const stored = await payload.findByID({ collection: 'notifications', id: channel.id, depth: 0 })
    expect(stored.lastSentAt).toBeTruthy()
    expect(stored.lastError).toBeFalsy()
  })

  it('stores the provider error on failure and rethrows so BullMQ retries', async () => {
    stubFetch(401)
    const channel = await createChannel({ name: 'discord-failing' })
    const monitor = await createMonitor({ name: 'failing', notifications: [channel.id] as never })
    const heartbeat = await createHeartbeat(monitor, 'down', 'boom')

    await expect(
      processNotificationJob(payload, {
        data: {
          notificationId: String(channel.id),
          monitorId: String(monitor.id),
          heartbeatId: String(heartbeat.id),
          organizationId: String(org.id),
        },
      }),
    ).rejects.toThrow(/HTTP 401/)

    const stored = await payload.findByID({ collection: 'notifications', id: channel.id, depth: 0 })
    expect(stored.lastError).toMatch(/HTTP 401/)

    // Inactive channels and missing documents are skipped without touching the network.
    fetchCalls = []
    await payload.update({
      collection: 'notifications',
      id: channel.id,
      data: { active: false },
      overrideAccess: true,
    })
    const skipped = await processNotificationJob(payload, {
      data: {
        notificationId: String(channel.id),
        monitorId: String(monitor.id),
        heartbeatId: String(heartbeat.id),
        organizationId: null,
      },
    })
    expect(skipped).toEqual({ outcome: 'skipped', reason: 'inactive' })
    expect(fetchCalls).toHaveLength(0)
  })

  it('enqueues one job per active channel and dedupes the same heartbeat', async (ctx) => {
    if (!queue) return ctx.skip()
    await queue.drain(true)
    const a = await createChannel({ name: 'queue-a' })
    const b = await createChannel({ name: 'queue-b' })
    const paused = await createChannel({ name: 'queue-paused', active: false })
    const monitor = await createMonitor({
      name: 'queued',
      notifications: [a.id, b.id, paused.id] as never,
    })
    const heartbeat = await createHeartbeat(monitor, 'down', 'offline')
    const event = { payload, monitor, heartbeat, organizationId: org.id }

    const first = await enqueueNotificationsForHeartbeat(event, { queue })
    expect(first).toEqual({ channels: 2, enqueued: 2 })

    const second = await enqueueNotificationsForHeartbeat(event, { queue })
    expect(second.channels).toBe(2)
    expect(second.enqueued).toBe(0)

    const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized', 'active', 'completed'])
    const mine = jobs.filter((job) => job.data.heartbeatId === String(heartbeat.id))
    expect(mine.map((job) => job.id).sort()).toEqual(
      [notificationJobId(a.id, heartbeat.id), notificationJobId(b.id, heartbeat.id)].sort(),
    )
    expect(mine[0].opts.attempts).toBe(3)
    expect(mine[0].opts.backoff).toEqual({ type: 'exponential', delay: 5_000 })
    expect(mine[0].data).toEqual({
      notificationId: String(a.id),
      monitorId: String(monitor.id),
      heartbeatId: String(heartbeat.id),
      organizationId: String(org.id),
    })

    await Promise.all(mine.map((job) => job.remove()))
  })

  it('a live worker consumes the queue and delivers through the provider', async (ctx) => {
    if (!queue) return ctx.skip()
    await queue.drain(true)
    stubFetch()
    const channel = await createChannel({
      name: 'live-worker',
      config: { webhookUrl: 'https://discord.com/api/webhooks/7/live' },
    })
    const monitor = await createMonitor({ name: 'live', notifications: [channel.id] as never })
    const heartbeat = await createHeartbeat(monitor, 'up', '200 - OK')

    const worker = startNotificationWorker(payload, { prefix, concurrency: 1 })
    try {
      await worker.waitUntilReady()
      const completed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('job did not complete')), 15_000)
        worker.on('completed', (job) => {
          if (job.data.heartbeatId === String(heartbeat.id)) {
            clearTimeout(timer)
            resolve()
          }
        })
        worker.on('failed', (_job, err) => {
          clearTimeout(timer)
          reject(err)
        })
      })
      await enqueueNotificationsForHeartbeat(
        { payload, monitor, heartbeat, organizationId: org.id },
        { queue },
      )
      await completed
    } finally {
      await worker.close()
    }

    expect(fetchCalls.map((c) => c.url)).toEqual(['https://discord.com/api/webhooks/7/live'])
    expect((fetchCalls[0].body as { embeds: { color: number }[] }).embeds[0].color).toBe(65280)
    const stored = await payload.findByID({ collection: 'notifications', id: channel.id, depth: 0 })
    expect(stored.lastSentAt).toBeTruthy()
  })
})

describe('notification endpoints', () => {
  const orgRoute = (user?: User, body?: unknown) =>
    (async () => {
      const headers: Record<string, string> = user ? await authHeaders(user) : {}
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      return new Request(`http://localhost/api/orgs/${org.id}/notifications`, {
        method: body !== undefined ? 'POST' : 'GET',
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    })()
  const params = { params: Promise.resolve({ orgId: String(org?.id) }) }
  const withParams = () => ({ params: Promise.resolve({ orgId: String(org.id) }) })

  it('POST /test requires notification:update', async () => {
    const body = { type: 'discord', config: { webhookUrl: 'https://discord.com/api/webhooks/1/t' } }
    const build = async (user?: User) =>
      new Request(`http://localhost/api/orgs/${org.id}/notifications/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(user ? await authHeaders(user) : {}) },
        body: JSON.stringify(body),
      })

    expect((await testRoute(await build(), withParams())).status).toBe(401)
    expect((await testRoute(await build(member), withParams())).status).toBe(403)
    expect((await testRoute(await build(outsider), withParams())).status).toBe(403)

    stubFetch()
    const ok = await testRoute(await build(admin), withParams())
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, result: 'Sent Successfully.' })
    expect(fetchCalls[0].url).toBe('https://discord.com/api/webhooks/1/t')
    expect((fetchCalls[0].body as { content: string }).content).toContain('[⚠️ Test]')

    stubFetch(401)
    const failed = await testRoute(await build(admin), withParams())
    expect(failed.status).toBe(400)
    expect(await failed.json()).toMatchObject({
      ok: false,
      error: expect.stringMatching(/HTTP 401/),
    })

    // Unknown provider / invalid config → 400 with a readable error, no network call.
    fetchCalls = []
    const bad = await testRoute(
      new Request(`http://localhost/api/orgs/${org.id}/notifications/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders(admin)) },
        body: JSON.stringify({ type: 'slack', config: {} }),
      }),
      withParams(),
    )
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toMatch(/webhookUrl/)
    expect(fetchCalls).toHaveLength(0)
  })

  it('POST /test with notificationId uses the saved channel of this organization', async () => {
    stubFetch()
    const saved = await createChannel({
      name: 'saved-test',
      config: { webhookUrl: 'https://discord.com/api/webhooks/9/saved' },
    })
    const res = await testRoute(
      new Request(`http://localhost/api/orgs/${org.id}/notifications/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders(admin)) },
        body: JSON.stringify({ notificationId: saved.id }),
      }),
      withParams(),
    )
    expect(res.status).toBe(200)
    expect(fetchCalls[0].url).toBe('https://discord.com/api/webhooks/9/saved')

    // A channel of another organization is not reachable through this org's URL.
    const foreign = (await payload.create({
      collection: 'notifications',
      depth: 0,
      overrideAccess: true,
      data: {
        name: 'foreign',
        type: 'discord',
        config: { webhookUrl: 'https://discord.com/api/webhooks/0/foreign' },
        organization: otherOrg.id,
      } as never,
    })) as Notification
    const missing = await testRoute(
      new Request(`http://localhost/api/orgs/${org.id}/notifications/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders(admin)) },
        body: JSON.stringify({ notificationId: foreign.id }),
      }),
      withParams(),
    )
    expect(missing.status).toBe(404)
  })

  it('GET lists channels for members (secrets masked) and POST creates for admins only', async () => {
    void params
    const channel = await createChannel({
      name: 'listed',
      config: { webhookUrl: 'https://discord.com/api/webhooks/5/secret' },
    })

    const anonymous = await listRoute(await orgRoute(), withParams())
    expect(anonymous.status).toBe(401)

    const asOutsider = await listRoute(await orgRoute(outsider), withParams())
    expect(asOutsider.status).toBe(403)

    const asMember = await listRoute(await orgRoute(member), withParams())
    expect(asMember.status).toBe(200)
    const memberDocs = (await asMember.json()).docs as Notification[]
    const seen = memberDocs.find((d) => String(d.id) === String(channel.id))!
    expect(seen).toBeDefined()
    expect((seen.config as { webhookUrl: string }).webhookUrl).not.toContain('secret')

    const asAdmin = await listRoute(await orgRoute(admin), withParams())
    const adminDocs = (await asAdmin.json()).docs as Notification[]
    expect(
      (adminDocs.find((d) => String(d.id) === String(channel.id))!.config as { webhookUrl: string })
        .webhookUrl,
    ).toBe('https://discord.com/api/webhooks/5/secret')

    const body = {
      name: 'created-via-api',
      type: 'slack',
      config: { webhookUrl: 'https://hooks.slack.com/services/x' },
      isDefault: true,
    }
    expect((await createRoute(await orgRoute(member, body), withParams())).status).toBe(403)
    const created = await createRoute(await orgRoute(admin, body), withParams())
    expect(created.status).toBe(201)
    const doc = (await created.json()).doc as Notification
    expect(doc.name).toBe('created-via-api')
    expect(
      String(typeof doc.organization === 'object' ? doc.organization.id : doc.organization),
    ).toBe(String(org.id))
    expect(doc.config).toMatchObject({ richMessage: true })

    const invalid = await createRoute(
      await orgRoute(admin, { name: 'broken', type: 'slack', config: { webhookUrl: 'nope' } }),
      withParams(),
    )
    expect(invalid.status).toBe(400)
    expect((await invalid.json()).error).toMatch(/webhookUrl/)

    await payload.update({
      collection: 'notifications',
      id: doc.id,
      data: { isDefault: false },
      overrideAccess: true,
    })
  })
})
