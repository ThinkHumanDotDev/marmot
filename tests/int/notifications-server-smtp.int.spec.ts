import { Redis } from 'ioredis'
import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { POST as createRoute } from '@/app/api/orgs/[orgId]/notifications/route'
import { PATCH as updateRoute } from '@/app/api/orgs/[orgId]/notifications/[id]/route'
import { POST as testRoute } from '@/app/api/orgs/[orgId]/notifications/test/route'
import { resetEnvCache } from '@/env'
import type { Heartbeat, Monitor, Notification, Organization, User } from '@/payload-types'
import { setSmtpTransportFactory } from '@/server/notification-providers/smtp'
import { processNotificationJob, sendNotification } from '@/server/notifications'
import { SERVER_SMTP_MAX_RECIPIENTS, ServerSmtpSendError } from '@/server/notifications/server-smtp'
import { closeRateLimitStore, RATE_LIMIT_PREFIX } from '@/server/security/rate-limit'

/**
 * NOTIFICATIONS_SERVER_SMTP / NOTIFICATIONS_SERVER_SMTP_RATE: who may send notification mail
 * through the instance's SMTP_* settings, how often, and to how many recipients.
 */

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `srv-smtp-${name}+${run}@marmot.test`
const PASSWORD = 'password-123'
const SERVER_HOST = 'smtp.server.test'

let org: Organization
let rateOrg: Organization
let root: User
let orgAdmin: User

type RequestUser = User & { collection: 'users' }

const ENV_KEYS = ['SMTP_HOST', 'NOTIFICATIONS_SERVER_SMTP', 'NOTIFICATIONS_SERVER_SMTP_RATE']
const savedEnv: Record<string, string | undefined> = {}

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetEnvCache()
}

const setPolicy = (policy: 'all' | 'superadmin' | 'off') =>
  setEnv({ NOTIFICATIONS_SERVER_SMTP: policy })

async function as(user: { id: User['id'] }): Promise<RequestUser> {
  const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
  return { ...fresh, collection: 'users' }
}

async function authHeaders(user: User): Promise<Record<string, string>> {
  const { token } = await payload.login({
    collection: 'users',
    data: { email: user.email, password: PASSWORD },
  })
  return { Authorization: `JWT ${token}`, 'Content-Type': 'application/json' }
}

/** Captured mails; the transport never talks to a server. */
let sent: { options: Record<string, unknown>; mail: Record<string, unknown> }[]
let transportsCreated: number

beforeEach(() => {
  sent = []
  transportsCreated = 0
  setSmtpTransportFactory((options) => {
    transportsCreated += 1
    return {
      sendMail: async (mail: Record<string, unknown>) => {
        sent.push({ options, mail })
        return {}
      },
    } as never
  })
})

const serverConfig = (extra: Record<string, unknown> = {}) => ({
  useServerSmtp: true,
  to: 'ops@example.com',
  ...extra,
})

const ownConfig = (extra: Record<string, unknown> = {}) => ({
  host: 'smtp.own.test',
  from: 'Alerts <alerts@own.test>',
  to: 'ops@example.com',
  ...extra,
})

const recipients = (count: number, domain = 'example.com') =>
  Array.from({ length: count }, (_, i) => `user${i}@${domain}`).join(', ')

async function createAs(
  user: User | null,
  data: {
    name: string
    config: Record<string, unknown>
    organization?: Organization['id']
    events?: Notification['events']
  },
): Promise<Notification> {
  return (await payload.create({
    collection: 'notifications',
    depth: 0,
    data: { type: 'smtp', organization: org.id, ...data } as never,
    ...(user ? { user: await as(user), overrideAccess: false } : { overrideAccess: true }),
  })) as Notification
}

async function updateAs(user: User, id: Notification['id'], data: Partial<Notification>) {
  return payload.update({
    collection: 'notifications',
    id,
    depth: 0,
    data,
    user: await as(user),
    overrideAccess: false,
  })
}

/** Payload error → `{ status, message }` (APIError / ValidationError). */
async function failure(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise
  } catch (error) {
    const err = error as {
      status?: number
      message?: string
      data?: { errors?: { message: string }[] }
    }
    return {
      status: err.status ?? 0,
      message: [err.message, ...(err.data?.errors ?? []).map((e) => e.message)].join(' | '),
    }
  }
  throw new Error('expected the operation to be refused')
}

const routeParams = (target: Organization = org) => ({
  params: Promise.resolve({ orgId: String(target.id) }),
})

async function postCreate(user: User, body: unknown) {
  return createRoute(
    new Request(`http://localhost/api/orgs/${org.id}/notifications`, {
      method: 'POST',
      headers: await authHeaders(user),
      body: JSON.stringify(body),
    }),
    routeParams(),
  )
}

async function patchUpdate(user: User, id: Notification['id'], body: unknown) {
  return updateRoute(
    new Request(`http://localhost/api/orgs/${org.id}/notifications/${id}`, {
      method: 'PATCH',
      headers: await authHeaders(user),
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ orgId: String(org.id), id: String(id) }) },
  )
}

async function postTest(user: User, body: unknown, target: Organization = org) {
  return testRoute(
    new Request(`http://localhost/api/orgs/${target.id}/notifications/test`, {
      method: 'POST',
      headers: await authHeaders(user),
      body: JSON.stringify(body),
    }),
    routeParams(target),
  )
}

async function createMonitorAndHeartbeat(
  target: Organization,
  notification: Notification,
): Promise<{ monitor: Monitor; heartbeat: Heartbeat }> {
  const monitor = (await payload.create({
    collection: 'monitors',
    depth: 0,
    overrideAccess: true,
    data: {
      name: `mon-${notification.id}`,
      type: 'http',
      url: 'https://example.com',
      active: false,
      interval: 60,
      retryInterval: 60,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 48,
      organization: target.id,
      notifications: [notification.id],
    } as never,
  })) as Monitor
  const heartbeat = (await payload.create({
    collection: 'heartbeats',
    depth: 0,
    overrideAccess: true,
    data: {
      monitor: monitor.id,
      organization: target.id,
      status: 'down',
      msg: 'HTTP 503',
      important: true,
      time: new Date().toISOString(),
    } as never,
  })) as Heartbeat
  return { monitor, heartbeat }
}

let redis: Redis | undefined

async function clearRateBucket(target: Organization) {
  await redis?.del(`${RATE_LIMIT_PREFIX}:server-smtp:${String(target.id)}`)
}

beforeAll(async () => {
  payload = await getPayload({ config })
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  // After Payload booted, so the instance email adapter keeps logging to the console.
  setEnv({ SMTP_HOST: SERVER_HOST, NOTIFICATIONS_SERVER_SMTP_RATE: undefined })

  root = await payload.create({
    collection: 'users',
    data: { email: email('root'), password: PASSWORD, name: 'root', superadmin: true },
  })
  orgAdmin = await payload.create({
    collection: 'users',
    data: { email: email('admin'), password: PASSWORD, name: 'admin' },
  })
  // The creator becomes the organization's owner.
  org = await payload.create({
    collection: 'organizations',
    data: { name: 'Mail Co', slug: `mail-co-${run}` },
    user: await as(orgAdmin),
    overrideAccess: false,
  })
  rateOrg = await payload.create({
    collection: 'organizations',
    data: { name: 'Rate Co', slug: `rate-co-${run}` },
    user: await as(orgAdmin),
    overrideAccess: false,
  })

  const probe = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    lazyConnect: true,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  })
  try {
    await probe.connect()
    await probe.ping()
    redis = probe
  } catch {
    probe.disconnect()
  }
  await clearRateBucket(org)
  await clearRateBucket(rateOrg)
})

afterAll(async () => {
  setSmtpTransportFactory(null)
  setEnv(savedEnv)
  if (redis) {
    await clearRateBucket(org)
    await clearRateBucket(rateOrg)
    redis.disconnect()
  }
  await closeRateLimitStore()
  const orgIds = [org?.id, rateOrg?.id].filter(Boolean)
  if (orgIds.length) {
    await payload.delete({ collection: 'heartbeats', where: { organization: { in: orgIds } } })
    await payload.delete({ collection: 'monitors', where: { organization: { in: orgIds } } })
    await payload.delete({ collection: 'notifications', where: { organization: { in: orgIds } } })
    await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
  }
  await payload.delete({ collection: 'users', where: { email: { like: `+${run}@marmot.test` } } })
})

describe('NOTIFICATIONS_SERVER_SMTP=superadmin (default)', () => {
  beforeAll(() => setEnv({ NOTIFICATIONS_SERVER_SMTP: undefined }))

  it('refuses an org admin’s create and switch-on, accepts a superadmin’s', async () => {
    // Local API on behalf of the org admin.
    const created = await failure(
      createAs(orgAdmin, { name: 'admin-server', config: serverConfig() }),
    )
    expect(created.status).toBe(403)
    expect(created.message).toMatch(/Only an instance superadmin/)

    // REST route handler.
    const viaRoute = await postCreate(orgAdmin, {
      name: 'admin-server-route',
      type: 'smtp',
      config: serverConfig(),
    })
    expect(viaRoute.status).toBe(403)
    expect((await viaRoute.json()).error).toMatch(/Only an instance superadmin/)

    // Switching an own-SMTP channel to the server settings.
    const own = await createAs(orgAdmin, { name: 'admin-own', config: ownConfig() })
    const switched = await failure(updateAs(orgAdmin, own.id, { config: serverConfig() }))
    expect(switched.status).toBe(403)
    const switchedRoute = await patchUpdate(orgAdmin, own.id, { config: serverConfig() })
    expect(switchedRoute.status).toBe(403)
    expect((await switchedRoute.json()).error).toMatch(/Only an instance superadmin/)

    // Unsaved test with the server settings is the same as creating it.
    const test = await postTest(orgAdmin, { type: 'smtp', config: serverConfig() })
    expect(test.status).toBe(403)
    expect(transportsCreated).toBe(0)

    // Superadmins may.
    const byRoot = await createAs(root, { name: 'root-server', config: serverConfig() })
    expect((byRoot.config as { useServerSmtp: boolean }).useServerSmtp).toBe(true)
    const rootSwitched = await updateAs(root, own.id, { config: serverConfig() })
    expect((rootSwitched.config as { useServerSmtp: boolean }).useServerSmtp).toBe(true)
    const rootRoute = await postCreate(root, {
      name: 'root-server-route',
      type: 'smtp',
      config: serverConfig(),
    })
    expect(rootRoute.status).toBe(201)

    // Trusted server code (overrideAccess) is not a user request.
    await expect(
      createAs(null, { name: 'system-server', config: serverConfig() }),
    ).resolves.toBeDefined()
  })

  it('keeps existing channels sending; org admins may rename or turn the option off but not retarget', async () => {
    const existing = await createAs(null, {
      name: 'grandfathered',
      config: serverConfig(),
      events: ['down'], // one Test sample per press
    })

    // Test button on the saved channel goes through the server transport.
    const tested = await postTest(orgAdmin, { notificationId: existing.id })
    expect(tested.status).toBe(200)
    expect(sent).toHaveLength(1)
    expect(sent[0].options).toMatchObject({ host: SERVER_HOST })

    // The edit form re-submits the unchanged config (without defaults) and tests it.
    const unchanged = { useServerSmtp: true, to: 'ops@example.com' }
    expect(
      (await postTest(orgAdmin, { notificationId: existing.id, config: unchanged })).status,
    ).toBe(200)
    const renamed = await patchUpdate(orgAdmin, existing.id, { name: 'renamed', config: unchanged })
    expect(renamed.status).toBe(200)

    // A new recipient is a new use of the server settings.
    const retarget = serverConfig({ to: 'someone@elsewhere.test' })
    expect((await patchUpdate(orgAdmin, existing.id, { config: retarget })).status).toBe(403)
    expect(
      (await postTest(orgAdmin, { notificationId: existing.id, config: retarget })).status,
    ).toBe(403)

    // Turning it off is always allowed.
    const off = await patchUpdate(orgAdmin, existing.id, { config: ownConfig() })
    expect(off.status).toBe(200)
  })
})

describe('NOTIFICATIONS_SERVER_SMTP=off', () => {
  afterAll(() => setPolicy('superadmin'))

  it('refuses the option on save for everyone', async () => {
    setPolicy('off')
    for (const user of [orgAdmin, root]) {
      const refused = await failure(createAs(user, { name: 'off-create', config: serverConfig() }))
      expect(refused.status).toBe(403)
      expect(refused.message).toMatch(/turned off/)
    }
    const own = await createAs(root, { name: 'off-own', config: ownConfig() })
    expect((await failure(updateAs(root, own.id, { config: serverConfig() }))).status).toBe(403)
    expect((await postTest(root, { type: 'smtp', config: serverConfig() })).status).toBe(403)
  })

  it('fails the delivery of an existing channel without touching the server transport', async () => {
    setPolicy('all')
    const existing = await createAs(orgAdmin, { name: 'off-existing', config: serverConfig() })
    const { monitor, heartbeat } = await createMonitorAndHeartbeat(org, existing)
    setPolicy('off')

    await expect(
      processNotificationJob(payload, {
        data: {
          notificationId: String(existing.id),
          monitorId: String(monitor.id),
          heartbeatId: String(heartbeat.id),
          organizationId: String(org.id),
        },
      }),
    ).rejects.toThrow(/turned off/)
    expect(transportsCreated).toBe(0)
    expect(sent).toHaveLength(0)

    const after = (await payload.findByID({
      collection: 'notifications',
      id: existing.id,
      depth: 0,
    })) as Notification
    expect(after.lastError).toMatch(/server SMTP settings is turned off/)

    const tested = await postTest(root, { notificationId: existing.id })
    expect(tested.status).toBe(400)
    expect((await tested.json()).error).toMatch(/turned off/)
    expect(transportsCreated).toBe(0)

    // Channels with their own SMTP settings are unaffected.
    const own = await createAs(orgAdmin, { name: 'off-own-send', config: ownConfig() })
    expect((await postTest(orgAdmin, { notificationId: own.id })).status).toBe(200)
    expect(sent[0].options).toMatchObject({ host: 'smtp.own.test' })
  })
})

describe('NOTIFICATIONS_SERVER_SMTP=all', () => {
  afterAll(() => setPolicy('superadmin'))

  it('lets org admins create, switch to and test the server settings', async () => {
    setPolicy('all')
    const created = await createAs(orgAdmin, { name: 'all-create', config: serverConfig() })
    expect((created.config as { useServerSmtp: boolean }).useServerSmtp).toBe(true)

    const viaRoute = await postCreate(orgAdmin, {
      name: 'all-route',
      type: 'smtp',
      config: serverConfig(),
    })
    expect(viaRoute.status).toBe(201)

    const own = await createAs(orgAdmin, { name: 'all-own', config: ownConfig() })
    expect((await patchUpdate(orgAdmin, own.id, { config: serverConfig() })).status).toBe(200)

    const tested = await postTest(orgAdmin, { type: 'smtp', config: serverConfig() })
    expect(tested.status).toBe(200)
    expect(sent[0].options).toMatchObject({ host: SERVER_HOST })
    expect(sent[0].mail).toMatchObject({ to: 'ops@example.com' })
  })
})

describe('recipient cap', () => {
  it(`refuses more than ${SERVER_SMTP_MAX_RECIPIENTS} recipients through the server settings`, async () => {
    const tooMany = serverConfig({
      to: recipients(5),
      cc: recipients(3, 'cc.example.com'),
      bcc: recipients(3, 'bcc.example.com'),
    })

    const refused = await failure(createAs(root, { name: 'too-many', config: tooMany }))
    expect(refused.status).toBe(400)
    expect(refused.message).toMatch(/at most 10 recipients/)

    const viaRoute = await postTest(root, { type: 'smtp', config: tooMany })
    expect(viaRoute.status).toBe(400)
    expect((await viaRoute.json()).error).toMatch(/at most 10 recipients/)

    // Send-time check (e.g. a channel saved before the cap existed).
    await expect(
      sendNotification(
        payload,
        { type: 'smtp', config: tooMany, organization: org.id },
        { monitor: null, heartbeat: null, message: 'x' },
      ),
    ).rejects.toBeInstanceOf(ServerSmtpSendError)
    expect(transportsCreated).toBe(0)

    // Exactly ten is fine; own SMTP settings have no cap.
    const ten = serverConfig({ to: recipients(5), cc: recipients(5, 'cc.example.com') })
    await expect(createAs(root, { name: 'ten', config: ten })).resolves.toBeDefined()
    await expect(
      createAs(orgAdmin, { name: 'own-many', config: ownConfig({ to: recipients(20) }) }),
    ).resolves.toBeDefined()
  })
})

describe('NOTIFICATIONS_SERVER_SMTP_RATE', () => {
  afterAll(() => setEnv({ NOTIFICATIONS_SERVER_SMTP_RATE: undefined }))

  it('refuses the N+1th message per organization and hour; the Test endpoint answers 429', async (ctx) => {
    if (!redis) ctx.skip()
    setEnv({ NOTIFICATIONS_SERVER_SMTP_RATE: '3' })
    await clearRateBucket(rateOrg)

    // One event, so each Test press sends one sample (#126).
    const channel = await createAs(root, {
      name: 'rate-limited',
      config: serverConfig(),
      organization: rateOrg.id,
      events: ['down'],
    })
    const { monitor, heartbeat } = await createMonitorAndHeartbeat(rateOrg, channel)

    // Test button and real deliveries share the budget.
    expect((await postTest(root, { notificationId: channel.id }, rateOrg)).status).toBe(200)
    expect((await postTest(root, { notificationId: channel.id }, rateOrg)).status).toBe(200)
    await expect(
      processNotificationJob(payload, {
        data: {
          notificationId: String(channel.id),
          monitorId: String(monitor.id),
          heartbeatId: String(heartbeat.id),
          organizationId: String(rateOrg.id),
        },
      }),
    ).resolves.toMatchObject({ outcome: 'sent' })
    expect(sent).toHaveLength(3)

    const limited = await postTest(root, { notificationId: channel.id }, rateOrg)
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect((await limited.json()).error).toMatch(/limit of 3 messages per hour/)

    await expect(
      processNotificationJob(payload, {
        data: {
          notificationId: String(channel.id),
          monitorId: String(monitor.id),
          heartbeatId: String(heartbeat.id),
          organizationId: String(rateOrg.id),
        },
      }),
    ).rejects.toThrow(/limit of 3 messages per hour/)
    const after = (await payload.findByID({
      collection: 'notifications',
      id: channel.id,
      depth: 0,
    })) as Notification
    expect(after.lastError).toMatch(/limit of 3 messages per hour/)
    expect(sent).toHaveLength(3)

    // Other organizations and channels with their own SMTP settings are not affected.
    expect((await postTest(root, { notificationId: channel.id }, org)).status).toBe(404)
    const own = await createAs(root, {
      name: 'rate-own',
      config: ownConfig(),
      organization: rateOrg.id,
    })
    expect((await postTest(root, { notificationId: own.id }, rateOrg)).status).toBe(200)
  })

  it('0 means unlimited', async () => {
    setEnv({ NOTIFICATIONS_SERVER_SMTP_RATE: '0' })
    for (let i = 0; i < 5; i++) {
      await expect(
        sendNotification(
          payload,
          { type: 'smtp', config: serverConfig(), organization: rateOrg.id },
          { monitor: null, heartbeat: null, message: 'x' },
        ),
      ).resolves.toBeDefined()
    }
    expect(sent).toHaveLength(5)
  })
})

describe('finding channels that use the server settings', () => {
  it('the documented query lists them on this database adapter', async () => {
    const { docs } = await payload.find({
      collection: 'notifications',
      where: {
        and: [
          { organization: { equals: org.id } },
          { type: { equals: 'smtp' } },
          { 'config.useServerSmtp': { equals: true } },
        ],
      },
      depth: 0,
      limit: 0,
      pagination: false,
    })
    expect(docs.length).toBeGreaterThan(0)
    for (const doc of docs) {
      expect((doc.config as { useServerSmtp?: boolean }).useServerSmtp).toBe(true)
    }
    expect(docs.map((d) => d.name)).toContain('root-server')
    expect(docs.map((d) => d.name)).not.toContain('off-own-send')
  })
})
