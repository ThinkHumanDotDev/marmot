import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import { GET as billingOverview } from '@/app/api/orgs/[orgId]/billing/route'
import { POST as billingCheckout } from '@/app/api/orgs/[orgId]/billing/checkout/route'
import { POST as billingPortal } from '@/app/api/orgs/[orgId]/billing/portal/route'
import { resetEnvCache } from '@/env'
import { PLAN_LIMITS } from '@/lib/entitlements'
import type { Monitor, Organization, User } from '@/payload-types'
import { ENTITLEMENT_HTTP_STATUS, getOrgUsage } from '@/server/billing/entitlements'

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+billing-${run}@marmot.test`
const PASSWORD = 'password-123'

type RequestUser = User & { collection: 'users' }

async function as(user: { id: User['id'] }): Promise<RequestUser> {
  const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
  return { ...fresh, collection: 'users' }
}

const createUser = (name: string, extra: Partial<User> = {}) =>
  payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name, ...extra },
  })

const MONITOR_DEFAULTS = {
  type: 'manual' as const,
  active: true,
  interval: 60,
  retryInterval: 60,
  maxRetries: 0,
  resendInterval: 0,
  timeout: 48,
}

async function createMonitor(user: User, org: Organization, name: string): Promise<Monitor> {
  return payload.create({
    collection: 'monitors',
    data: { ...MONITOR_DEFAULTS, name, organization: org.id } as never,
    user: await as(user),
    overrideAccess: false,
    depth: 0,
  })
}

async function authedRequest(user: User, method: string, body?: unknown): Promise<Request> {
  const { token } = await payload.login({
    collection: 'users',
    data: { email: user.email, password: PASSWORD },
  })
  return new Request('http://localhost/api/test', {
    method,
    headers: {
      Authorization: `JWT ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

const routeParams = (orgId: string | number) => ({
  params: Promise.resolve({ orgId: String(orgId) }),
})

const setBilling = (enabled: boolean) => {
  if (enabled) process.env.BILLING_ENABLED = 'true'
  else delete process.env.BILLING_ENABLED
  resetEnvCache()
}

/** Runs `fn` and returns the thrown error (tests that expect a rejection). */
async function rejection(
  fn: () => Promise<unknown>,
): Promise<{ status?: number; message: string }> {
  try {
    await fn()
  } catch (error) {
    return error as { status?: number; message: string }
  }
  throw new Error('expected the operation to be rejected')
}

let owner: User
let admin: User
let member: User
let superadmin: User
let org: Organization

const previousBilling = process.env.BILLING_ENABLED
const previousStripe = process.env.STRIPE_SECRET_KEY

describe('billing entitlements', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    delete process.env.STRIPE_SECRET_KEY
    setBilling(false)
    owner = await createUser('owner')
    admin = await createUser('admin')
    member = await createUser('member')
    superadmin = await createUser('super', { superadmin: true })
    org = await payload.create({
      collection: 'organizations',
      data: { name: `Billing ${run}`, slug: `billing-${run}` },
      user: await as(owner),
      overrideAccess: false,
    })
    await addOrgMembership({ payload, userId: admin.id, orgId: org.id, role: 'admin' })
  })

  afterAll(async () => {
    if (previousBilling === undefined) delete process.env.BILLING_ENABLED
    else process.env.BILLING_ENABLED = previousBilling
    if (previousStripe === undefined) delete process.env.STRIPE_SECRET_KEY
    else process.env.STRIPE_SECRET_KEY = previousStripe
    resetEnvCache()
    await payload.delete({ collection: 'monitors', where: { organization: { equals: org.id } } })
    await payload.delete({
      collection: 'status-pages',
      where: { organization: { equals: org.id } },
    })
    await payload.delete({ collection: 'organizations', where: { id: { equals: org.id } } })
    await payload.delete({
      collection: 'users',
      where: { email: { like: `+billing-${run}@marmot.test` } },
    })
  })

  describe('with BILLING_ENABLED=false (self-host)', () => {
    it('lets a free organization create more monitors than the free plan allows', async () => {
      const over = PLAN_LIMITS.free.maxMonitors + 2
      for (let i = 0; i < over; i++) {
        await createMonitor(owner, org, `monitor ${i}`)
      }
      const usage = await getOrgUsage(payload, org.id)
      expect(usage.monitors).toBe(over)
      expect(usage.members).toBe(2)
      expect(usage.statusPages).toBe(0)
    })

    it('answers 501 billing disabled on every billing route, before authentication', async () => {
      const unauthenticated = new Request('http://localhost/api/test', { method: 'POST' })
      for (const [handler, request] of [
        [billingOverview, await authedRequest(owner, 'GET')],
        [billingCheckout, await authedRequest(owner, 'POST', { plan: 'team' })],
        [billingPortal, await authedRequest(owner, 'POST')],
        [billingPortal, unauthenticated],
      ] as const) {
        const res = await handler(request, routeParams(org.id))
        expect(res.status).toBe(501)
        expect(await res.json()).toEqual({ error: 'billing disabled' })
      }
    })
  })

  describe('with BILLING_ENABLED=true and the free plan', () => {
    beforeAll(() => setBilling(true))
    afterAll(() => setBilling(false))

    it('refuses the monitor that would exceed the plan with a readable 402', async () => {
      const error = await rejection(() => createMonitor(owner, org, 'one too many'))
      expect(error.status).toBe(ENTITLEMENT_HTTP_STATUS)
      expect(error.message).toBe(
        `Your plan allows ${PLAN_LIMITS.free.maxMonitors} monitors. Upgrade your plan to add more.`,
      )
    })

    it('still allows updates to existing monitors', async () => {
      const { docs } = await payload.find({
        collection: 'monitors',
        where: { organization: { equals: org.id } },
        limit: 1,
        depth: 0,
      })
      const updated = await payload.update({
        collection: 'monitors',
        id: docs[0].id,
        data: { name: 'renamed' },
        user: await as(owner),
        overrideAccess: false,
        depth: 0,
      })
      expect(updated.name).toBe('renamed')
    })

    it('counts members plus pending invitations against the seat limit', async () => {
      // owner + admin = 2 members; free allows 3 → one invitation fits, the next does not.
      const invitation = await payload.create({
        collection: 'invitations',
        data: { organization: org.id, email: email('invitee-1'), role: 'member' } as never,
        user: await as(owner),
        overrideAccess: false,
        depth: 0,
      })
      expect(invitation.status).toBe('pending')

      const error = await rejection(async () =>
        payload.create({
          collection: 'invitations',
          data: { organization: org.id, email: email('invitee-2'), role: 'member' } as never,
          user: await as(owner),
          overrideAccess: false,
          depth: 0,
        }),
      )
      expect(error.status).toBe(ENTITLEMENT_HTTP_STATUS)
      expect(error.message).toContain(`allows ${PLAN_LIMITS.free.maxMembers} members`)
    })

    it('limits status pages', async () => {
      const page = await payload.create({
        collection: 'status-pages',
        data: { organization: org.id, title: 'Status', slug: `billing-status-${run}` } as never,
        user: await as(owner),
        overrideAccess: false,
        depth: 0,
      })
      expect(page.id).toBeDefined()

      const error = await rejection(async () =>
        payload.create({
          collection: 'status-pages',
          data: { organization: org.id, title: 'Second', slug: `billing-status2-${run}` } as never,
          user: await as(owner),
          overrideAccess: false,
          depth: 0,
        }),
      )
      expect(error.status).toBe(ENTITLEMENT_HTTP_STATUS)
      expect(error.message).toBe('Your plan allows 1 status page. Upgrade your plan to add more.')
    })

    it('GET /api/orgs/:orgId/billing reports plan, entitlements and usage to admins', async () => {
      const res = await billingOverview(await authedRequest(admin, 'GET'), routeParams(org.id))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toMatchObject({
        billingEnabled: true,
        stripeConfigured: false,
        plan: 'free',
        effectivePlan: 'free',
        subscriptionStatus: 'none',
        hasCustomer: false,
        upgrades: ['team', 'pro'],
        entitlements: { maxMonitors: PLAN_LIMITS.free.maxMonitors, customDomains: false },
        usage: { monitors: PLAN_LIMITS.free.maxMonitors + 2, members: 2, statusPages: 1 },
      })
    })

    it('hides billing from members and viewers (403) and from outsiders (404)', async () => {
      await addOrgMembership({ payload, userId: member.id, orgId: org.id, role: 'member' })
      const forbidden = await billingOverview(
        await authedRequest(member, 'GET'),
        routeParams(org.id),
      )
      expect(forbidden.status).toBe(403)

      const outsider = await createUser('outsider')
      const missing = await billingOverview(
        await authedRequest(outsider, 'GET'),
        routeParams(org.id),
      )
      expect(missing.status).toBe(404)

      const anonymous = await billingOverview(
        new Request('http://localhost/api/test'),
        routeParams(org.id),
      )
      expect(anonymous.status).toBe(401)
    })

    it('validates the checkout plan and answers 503 while Stripe is not configured', async () => {
      const bad = await billingCheckout(
        await authedRequest(owner, 'POST', { plan: 'enterprise' }),
        routeParams(org.id),
      )
      expect(bad.status).toBe(400)

      const checkout = await billingCheckout(
        await authedRequest(owner, 'POST', { plan: 'team' }),
        routeParams(org.id),
      )
      expect(checkout.status).toBe(503)
      expect((await checkout.json()).error).toMatch(/stripe is not configured/i)

      const portal = await billingPortal(await authedRequest(owner, 'POST'), routeParams(org.id))
      expect(portal.status).toBe(503)
    })

    it('members cannot grant themselves a plan, superadmins can; enterprise is unlimited', async () => {
      const sneaky = await payload.update({
        collection: 'organizations',
        id: org.id,
        data: { plan: 'enterprise' },
        user: await as(owner),
        overrideAccess: false,
        depth: 0,
      })
      expect(sneaky.plan).toBe('free')

      const granted = await payload.update({
        collection: 'organizations',
        id: org.id,
        data: { plan: 'enterprise', subscriptionStatus: 'active' },
        user: await as(superadmin),
        overrideAccess: false,
        depth: 0,
      })
      expect(granted.plan).toBe('enterprise')

      const monitor = await createMonitor(owner, org, 'enterprise monitor')
      expect(monitor.id).toBeDefined()

      const res = await billingOverview(await authedRequest(owner, 'GET'), routeParams(org.id))
      const body = await res.json()
      expect(body.entitlements.maxMonitors).toBeNull()
      expect(body.upgrades).toEqual([])
    })

    it('a canceled subscription falls back to the free limits', async () => {
      await payload.update({
        collection: 'organizations',
        id: org.id,
        data: { plan: 'enterprise', subscriptionStatus: 'canceled' },
        overrideAccess: true,
        depth: 0,
      })
      const error = await rejection(() => createMonitor(owner, org, 'after cancel'))
      expect(error.status).toBe(ENTITLEMENT_HTTP_STATUS)

      const res = await billingOverview(await authedRequest(owner, 'GET'), routeParams(org.id))
      expect(await res.json()).toMatchObject({ plan: 'enterprise', effectivePlan: 'free' })
    })
  })
})
