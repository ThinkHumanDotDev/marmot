import { getPayload, type CollectionSlug, type EmailAdapter, type Payload } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { POST as twoFactorSetupRoute } from '@/app/api/account/2fa/setup/route'
import { POST as smtpTestRoute } from '@/app/api/instance/smtp-test/route'
import { POST as billingCheckoutRoute } from '@/app/api/orgs/[orgId]/billing/checkout/route'
import { POST as dockerTestRoute } from '@/app/api/orgs/[orgId]/docker-hosts/test/route'
import { POST as importRoute } from '@/app/api/orgs/[orgId]/import/route'
import { POST as setupRoute } from '@/app/api/setup/route'
import { env, resetEnvCache } from '@/env'
import type { Monitor, Organization, User } from '@/payload-types'
import { DEMO_ACCOUNT, DEMO_ORGANIZATION_SLUG } from '@/server/demo/config'
import {
  DEMO_INCIDENTS,
  DEMO_LOCATIONS,
  DEMO_MONITORS,
  DEMO_STATUS_PAGES,
  DEFAULT_PROFILE,
} from '@/server/demo/dataset'
import { runDemoProbes } from '@/server/demo/probes'
import {
  DemoDatabaseError,
  DEMO_RESET_JOB_NAME,
  nextScheduledReset,
  processDemoResetJob,
  refuseNonDemoDatabase,
  resetDemoData,
  wipeDatabase,
  wipeOrder,
  type ResetResult,
} from '@/server/demo/reset'
import { simulateCheck, simulateOutcome } from '@/server/demo/simulate'
import { getEmailAdapter } from '@/server/email/adapter'
import { createQueue } from '@/server/engine/queues'
import { runCheck } from '@/server/engine/run-check'
import { scheduleDemoJobs } from '@/server/maintenance/job'
import { sendNotification } from '@/server/notifications/send'
import { findBlockedMessage, guardedFetch } from '@/server/security/outbound-guard'
import { isEmailVerificationRequired, isSignupAllowed } from '@/server/settings'
import { runSetup, SetupError } from '@/server/setup'
import { postSubscriberWebhook } from '@/server/status-pages/subscribers/deliver'
import { postWebhook } from '@/server/webhooks/deliver'

/**
 * Demo mode (#159): the reset (wipe + seed, idempotent, batched deletes, refusal of real data), the
 * synthetic history and simulated checks, and the guard rails that keep anything from leaving the
 * instance. The reset wipes the whole test database, so this file leaves it empty behind it.
 */

type Id = string | number

let payload: Payload
const ENV_KEYS = ['DEMO_MODE', 'DEMO_MODE_FORCE', 'SMTP_HOST', 'BILLING_ENABLED'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetEnvCache()
}

const count = async (collection: CollectionSlug, where = {}) =>
  (await payload.count({ collection, where, overrideAccess: true })).totalDocs

/** A comparable picture of the dataset: names and counts, no ids or timestamps. */
async function snapshot() {
  const names = async (collection: CollectionSlug, field: string) =>
    (
      (await payload.find({
        collection,
        limit: 0,
        pagination: false,
        depth: 0,
        overrideAccess: true,
      })) as unknown as { docs: Record<string, unknown>[] }
    ).docs
      .map((doc) => String(doc[field]))
      .sort()
  return {
    users: await names('users', 'email'),
    organizations: await names('organizations', 'slug'),
    monitors: await names('monitors', 'key'),
    tags: await names('tags', 'name'),
    locations: await names('locations', 'slug'),
    notifications: await names('notifications', 'name'),
    statusPages: await names('status-pages', 'slug'),
    incidents: await names('incidents', 'title'),
    maintenance: await names('maintenance', 'title'),
    monitorIncidents: await count('monitor-incidents'),
    statDaily: await count('stat-daily'),
    statHourly: await count('stat-hourly'),
    statLocationHourly: await count('stat-location-hourly'),
  }
}

async function demoSession(): Promise<{ user: User & { collection: 'users' }; cookie: string }> {
  const { token, user } = await payload.login({
    collection: 'users',
    data: { email: DEMO_ACCOUNT.email, password: DEMO_ACCOUNT.password },
  })
  return { user: { ...(user as User), collection: 'users' }, cookie: `payload-token=${token}` }
}

function request(url: string, init: { method?: string; body?: unknown; cookie?: string } = {}) {
  return new Request(url, {
    method: init.method ?? 'POST',
    headers: {
      Origin: env.NEXT_PUBLIC_SERVER_URL,
      'content-type': 'application/json',
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
}

const demoOrg = async (): Promise<Organization> =>
  (
    await payload.find({
      collection: 'organizations',
      where: { slug: { equals: DEMO_ORGANIZATION_SLUG } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
  ).docs[0] as Organization

const orgParams = (orgId: Id) => ({ params: Promise.resolve({ orgId: String(orgId) }) })

let first: ResetResult

describe('demo mode', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    setEnv({ DEMO_MODE: 'true', DEMO_MODE_FORCE: undefined })
    // Earlier test files leave their rows behind: this first reset has to be forced.
    first = await resetDemoData(payload, { force: true })
  }, 180_000)

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    setEnv({ DEMO_MODE: undefined })
    await wipeDatabase(payload)
    setEnv(savedEnv)
  }, 120_000)

  describe('reset', () => {
    it('seeds the organization, members and the whole dataset', async () => {
      const org = await demoOrg()
      expect(org.name).toBe('Example Inc.')
      const users = await payload.find({
        collection: 'users',
        depth: 0,
        limit: 0,
        pagination: false,
        overrideAccess: true,
      })
      expect(users.docs).toHaveLength(4)
      const owner = users.docs.find((u) => u.email === DEMO_ACCOUNT.email)
      expect(owner?.organizations?.[0]?.role).toBe('owner')
      expect(owner?.superadmin).toBeFalsy()
      expect(users.docs.every((u) => u.emailVerified === true)).toBe(true)
      expect(await count('monitors')).toBe(DEMO_MONITORS.length)
      expect(new Set(DEMO_MONITORS.map((m) => m.type)).size).toBeGreaterThanOrEqual(10)
      expect(await count('status-pages')).toBe(DEMO_STATUS_PAGES.length)
      expect(await count('incidents')).toBe(DEMO_INCIDENTS.length)
      expect(await count('incidents', { active: { equals: true } })).toBe(1)
      expect(await count('locations', { status: { equals: 'online' } })).toBe(DEMO_LOCATIONS.length)
      expect(await count('notifications')).toBeGreaterThan(0)
      expect(await count('monitor-incidents', { status: { equals: 'resolved' } })).toBe(3)
      // The audit log stays empty: the seed is not somebody's action.
      expect(await count('audit-logs')).toBe(0)
    })

    it('starts the scheduled and the running maintenance windows', async () => {
      const { docs } = await payload.find({
        collection: 'maintenance',
        depth: 0,
        overrideAccess: true,
      })
      const status = Object.fromEntries(docs.map((d) => [d.title, d.status]))
      expect(status['Staging environment rebuild']).toBe('under-maintenance')
      expect(status['Database upgrade to PostgreSQL 17']).toBe('scheduled')
    })

    it('resolves incident components to the status page rows', async () => {
      const { docs } = await payload.find({
        collection: 'incidents',
        where: { active: { equals: true } },
        depth: 0,
        overrideAccess: true,
      })
      const active = docs[0]
      expect(active.status).toBe('identified')
      expect(active.updates).toHaveLength(2)
      expect(active.affectedComponents?.[0]?.impact).toBe('degraded_performance')
      const resolved = await payload.find({
        collection: 'incidents',
        where: { title: { equals: 'Payment confirmations delayed' } },
        depth: 0,
        overrideAccess: true,
      })
      expect(resolved.docs[0].status).toBe('resolved')
      expect(resolved.docs[0].updates).toHaveLength(4)
    })

    it('back-fills heartbeats and every stat roll-up with percentiles and timing', async () => {
      const { history } = first.seeded
      expect(history.heartbeats).toBeGreaterThan(1000)
      expect(history.minutely).toBeGreaterThan(500)
      expect(history.hourly).toBeGreaterThan(1000)
      expect(history.daily).toBeGreaterThan(100)
      expect(history.locationHourly).toBeGreaterThan(500)
      expect(await count('stat-hourly')).toBe(history.hourly)

      const gateway = first.seeded.monitors['api-gateway']
      const { docs } = await payload.find({
        collection: 'stat-hourly',
        where: { monitor: { equals: gateway } },
        sort: '-timestamp',
        limit: 5,
        depth: 0,
        overrideAccess: true,
      })
      const row = docs[1]
      expect(row.up).toBeGreaterThan(0)
      expect(Array.isArray(row.latencyHistogram)).toBe(true)
      const extras = row.extras as { timing?: Record<string, { avg: number }> }
      expect(extras.timing?.ttfb?.avg).toBeGreaterThan(0)

      // Per-location series for the multi-location monitors (#92): local + three probes.
      const keys = new Set(
        (
          await payload.find({
            collection: 'stat-location-hourly',
            where: { monitor: { equals: gateway } },
            limit: 0,
            pagination: false,
            depth: 0,
            overrideAccess: true,
          })
        ).docs.map((d) => d.location),
      )
      expect(keys.size).toBe(4)
      expect(keys.has('local')).toBe(true)

      const monitor = (await payload.findByID({
        collection: 'monitors',
        id: gateway,
        depth: 0,
        overrideAccess: true,
      })) as Monitor
      expect(monitor.status?.lastStatus).toMatch(/up|degraded|down/)
      expect(monitor.status?.lastCheckAt).toBeTruthy()
    })

    it('is idempotent: a second reset recreates the same dataset and drops visitor changes', async () => {
      const before = await snapshot()
      const org = await demoOrg()
      await payload.create({
        collection: 'tags',
        data: { organization: org.id, name: 'visitor-tag', color: '#000000' },
        overrideAccess: true,
      })
      // Small batches: the wipe goes through `deleteInBatches` (#243) many times per collection.
      await resetDemoData(payload, { batchSize: 250 })
      const after = await snapshot()
      expect(after).toEqual(before)
      expect(await count('tags', { name: { equals: 'visitor-tag' } })).toBe(0)
    }, 180_000)

    it('refuses a database with non-demo accounts unless forced', async () => {
      const stranger = await payload.create({
        collection: 'users',
        data: { email: 'real-admin@marmot.test', password: 'password-123' },
        overrideAccess: true,
      })
      try {
        await expect(resetDemoData(payload, { historyDays: 1 })).rejects.toBeInstanceOf(
          DemoDatabaseError,
        )
        await expect(refuseNonDemoDatabase(payload)).rejects.toBeInstanceOf(DemoDatabaseError)
        // Nothing was deleted.
        expect(await count('users', { id: { equals: stranger.id } })).toBe(1)
        expect(await count('monitors')).toBe(DEMO_MONITORS.length)
        const job = await processDemoResetJob(payload, { id: 'x', name: DEMO_RESET_JOB_NAME })
        // Debounced (the dataset is fresh) or refused: either way the stranger survives.
        expect(job).toEqual({ skipped: 'reset less than a minute ago' })
        expect(await count('users', { id: { equals: stranger.id } })).toBe(1)
      } finally {
        await payload.delete({
          collection: 'users',
          id: stranger.id,
          overrideAccess: true,
          context: { demoSeed: true },
        })
      }
    })

    it('skips scheduled resets outside demo mode', async () => {
      setEnv({ DEMO_MODE: undefined })
      try {
        expect(await processDemoResetJob(payload, { id: 'x', name: DEMO_RESET_JOB_NAME })).toEqual({
          skipped: 'demo mode is off',
        })
      } finally {
        setEnv({ DEMO_MODE: 'true' })
      }
    })

    it('deletes children before what they reference', () => {
      const order = wipeOrder(payload.config.collections.map((c) => c.slug))
      const at = (slug: string) => order.indexOf(slug)
      expect(order).not.toContain('payload-migrations')
      expect(at('heartbeats')).toBeLessThan(at('monitors'))
      expect(at('monitors')).toBeLessThan(at('tags'))
      expect(at('monitors')).toBeLessThan(at('locations'))
      expect(at('auth-accounts')).toBeLessThan(at('users'))
      expect(at('users')).toBeLessThan(at('organizations'))
      expect(order.at(-1)).toBe('organizations')
    })
  })

  describe('scheduling', () => {
    it('upserts the reset and probe schedulers in demo mode and removes them otherwise', async () => {
      const queue = createQueue('maintenance', { prefix: `demo-test-${Date.now().toString(36)}` })
      try {
        await scheduleDemoJobs(queue)
        const scheduler = await queue.getJobScheduler(DEMO_RESET_JOB_NAME)
        expect(Number(scheduler?.every)).toBe(env.DEMO_RESET_INTERVAL_MINUTES * 60_000)
        expect(await queue.getJob('demo-reset-boot')).toBeTruthy()
        expect(await nextScheduledReset(queue)).toBeInstanceOf(Date)
        // Idempotent.
        await scheduleDemoJobs(queue)
        expect(await queue.getJobSchedulersCount()).toBe(2)

        setEnv({ DEMO_MODE: undefined })
        await scheduleDemoJobs(queue)
        expect(await queue.getJobScheduler(DEMO_RESET_JOB_NAME)).toBeUndefined()
        expect(await queue.getJobSchedulersCount()).toBe(0)
      } finally {
        setEnv({ DEMO_MODE: 'true' })
        await queue.obliterate({ force: true })
        await queue.close()
      }
    })
  })

  describe('simulated checks', () => {
    it('never connects: a monitor aimed at a private address gets a simulated result', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      const monitor = {
        id: 'visitor',
        key: null,
        type: 'http',
        url: 'http://127.0.0.1:9/admin',
        interval: 60,
        timeout: 5,
      } as unknown as Monitor
      const result = await runCheck(payload, monitor, 5_000)
      expect(result.msg).toMatch(/simulated/)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('is deterministic and follows the profile outages', () => {
      const time = new Date('2026-10-08T12:34:00Z')
      const input = { key: 'k', type: 'http', profile: DEFAULT_PROFILE, time }
      expect(simulateOutcome(input)).toEqual(simulateOutcome(input))
      const outage = {
        ...DEFAULT_PROFILE,
        outage: { everyMinutes: 1, forMinutes: 1, message: 'x' },
      }
      expect(simulateOutcome({ ...input, profile: outage })).toMatchObject({ ok: false, msg: 'x' })
      const seeded = simulateCheck(
        {
          id: '1' as unknown as Monitor['id'],
          key: 'marketing-site',
          type: 'http',
          url: 'https://x',
        },
        time,
      )
      expect(seeded.msg).not.toMatch(/simulated/)
    })

    it('plays the probe agents of the seeded locations', async () => {
      const result = await runDemoProbes(payload, new Date())
      expect(result.locations).toBe(DEMO_LOCATIONS.length)
      expect(result.results).toBeGreaterThan(0)
      expect(await count('heartbeats', { location: { exists: true } })).toBeGreaterThan(0)
    })
  })

  describe('nothing leaves the instance', () => {
    it('delivers notifications to the sink instead of the provider', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      const result = await sendNotification(
        payload,
        { type: 'slack', config: { webhookUrl: 'https://hooks.slack.com/services/x' } },
        { monitor: null, heartbeat: null, message: 'hello' },
      )
      expect(result).toMatch(/demo/i)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('refuses every outbound connection through the guard', async () => {
      const error = await guardedFetch('https://example.com/').catch((err: unknown) => err)
      expect(findBlockedMessage(error)).toMatch(/DEMO_MODE/)
    })

    it('sinks outbound and subscriber webhooks', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      const attempt = await postWebhook({
        url: 'https://example.com/hook',
        envelope: { type: 'monitor.down' } as never,
        secrets: ['s'],
        deliveryId: 'd1',
      })
      expect(attempt).toMatchObject({ ok: true, status: 202 })
      expect(
        await postSubscriberWebhook({
          url: 'https://example.com/sub',
          body: {},
          event: 'incident.updated',
          deliveryId: 'd2',
        }),
      ).toBe(202)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('replaces SMTP with the sink email adapter', async () => {
      setEnv({ SMTP_HOST: 'smtp.example.com' })
      try {
        const adapter = (await getEmailAdapter()) as EmailAdapter | undefined
        const initialized = adapter?.({ payload })
        expect(initialized?.name).toBe('demo-sink')
        await expect(
          initialized?.sendEmail({ to: 'someone@example.com', subject: 'Hi' }),
        ).resolves.toMatchObject({ demo: true })
      } finally {
        setEnv({ SMTP_HOST: undefined })
      }
    })
  })

  describe('guard rails', () => {
    it('turns signups, email verification and first-run setup off', async () => {
      expect(await isSignupAllowed(payload)).toBe(false)
      expect(await isEmailVerificationRequired(payload)).toBe(false)
      await expect(
        runSetup(payload, {
          name: 'x',
          email: 'x@marmot.test',
          password: 'password-123',
          organizationName: 'X',
          organizationSlug: 'x-demo',
        }),
      ).rejects.toBeInstanceOf(SetupError)
      const response = await setupRoute(request('http://localhost:3000/api/setup', { body: {} }))
      expect(response.status).toBe(403)
    })

    it('keeps the demo credentials: no password, email or account changes', async () => {
      const { user } = await demoSession()
      const update = (data: Record<string, unknown>) =>
        payload.update({
          collection: 'users',
          id: user.id,
          data,
          user,
          overrideAccess: false,
        })
      await expect(update({ password: 'hijacked-password' })).rejects.toMatchObject({
        status: 403,
      })
      await expect(update({ email: 'mine@example.com' })).rejects.toMatchObject({ status: 403 })
      await expect(update({ name: 'Visitor' })).resolves.toMatchObject({ name: 'Visitor' })
      await expect(
        payload.forgotPassword({ collection: 'users', data: { email: DEMO_ACCOUNT.email } }),
      ).rejects.toMatchObject({ status: 403 })
      // The demo password still works.
      await expect(demoSession()).resolves.toBeTruthy()
    })

    it('locks API keys, webhooks, SSO, uploads, custom domains and instance settings', async () => {
      const { user } = await demoSession()
      const org = await demoOrg()
      const asDemo = { user, overrideAccess: false } as const
      const refused = { status: 403, data: { code: 'demo_mode' } }

      await expect(
        payload.create({
          collection: 'api-keys',
          data: { organization: org.id, name: 'k' } as never,
          ...asDemo,
        }),
      ).rejects.toMatchObject(refused)
      await expect(
        payload.create({
          collection: 'webhook-endpoints',
          data: { organization: org.id, url: 'https://example.com', events: ['*'] } as never,
          ...asDemo,
        }),
      ).rejects.toMatchObject(refused)
      await expect(
        payload.create({
          collection: 'sso-connections',
          data: { organization: org.id, name: 's', slug: 's', type: 'oidc' } as never,
          ...asDemo,
        }),
      ).rejects.toMatchObject(refused)
      await expect(
        payload.create({ collection: 'media', data: { alt: 'x' } as never, ...asDemo }),
      ).rejects.toMatchObject(refused)
      await expect(
        payload.update({
          collection: 'organizations',
          id: org.id,
          data: { enforceSso: true },
          ...asDemo,
        }),
      ).rejects.toMatchObject(refused)
      const page = (
        await payload.find({ collection: 'status-pages', limit: 1, depth: 0, overrideAccess: true })
      ).docs[0]
      await expect(
        payload.update({
          collection: 'status-pages',
          id: page.id,
          data: { domains: [{ hostname: 'status.attacker.test' }] },
          ...asDemo,
        }),
      ).rejects.toMatchObject(refused)
      // Even a superadmin (e.g. a forced instance) cannot change instance settings.
      await expect(
        payload.updateGlobal({ slug: 'instance-settings', data: { allowSignup: true } }),
      ).rejects.toMatchObject(refused)
    })

    it('answers 403 on the routes without a collection behind them', async () => {
      const { cookie } = await demoSession()
      const org = await demoOrg()
      const base = `http://localhost:3000/api/orgs/${org.id}`
      const responses = await Promise.all([
        importRoute(request(`${base}/import`, { body: {}, cookie }), orgParams(org.id)),
        dockerTestRoute(
          request(`${base}/docker-hosts/test`, { body: { connectionType: 'socket' }, cookie }),
          orgParams(org.id),
        ),
        billingCheckoutRoute(
          request(`${base}/billing/checkout`, { body: { plan: 'team' }, cookie }),
          orgParams(org.id),
        ),
        smtpTestRoute(request('http://localhost:3000/api/instance/smtp-test', { cookie })),
        twoFactorSetupRoute(
          request('http://localhost:3000/api/account/2fa/setup', {
            body: { password: DEMO_ACCOUNT.password },
            cookie,
          }),
        ),
      ])
      for (const response of responses) {
        expect(response.status).toBe(403)
        const body = (await response.json()) as { errors: { data?: { code?: string } }[] }
        expect(body.errors[0].data?.code).toBe('demo_mode')
      }
    })

    it('is all off outside demo mode', async () => {
      setEnv({ DEMO_MODE: undefined })
      try {
        const org = await demoOrg()
        const tag = await payload.create({
          collection: 'webhook-endpoints',
          data: {
            organization: org.id,
            name: 'outside demo',
            url: 'https://example.com/hook',
            events: ['*'],
          } as never,
          overrideAccess: true,
        })
        expect(tag.id).toBeDefined()
        expect(await isSignupAllowed(payload)).toBe(true)
      } finally {
        setEnv({ DEMO_MODE: 'true' })
      }
    })
  })
})
