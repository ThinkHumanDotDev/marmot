import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import { getUserRole } from '@/access/permissions'
import { POST as acceptInviteRoute } from '@/app/api/invite/[code]/accept/route'
import { POST as importKumaRoute } from '@/app/api/orgs/[orgId]/import/uptime-kuma/route'
import { POST as cloneMonitor } from '@/app/api/orgs/[orgId]/monitors/[id]/clone/route'
import { PATCH as patchMonitor } from '@/app/api/orgs/[orgId]/monitors/[id]/route'
import { GET as orgMonitorStats } from '@/app/api/orgs/[orgId]/monitors/[id]/stats/route'
import { GET as resolveDomain } from '@/app/api/status-pages/resolve-domain/route'
import { userResolution } from '@/auth/sso/hooks'
import { generateInviteLinkToken } from '@/collections/Organizations'
import { env, resetEnvCache } from '@/env'
import { PLAN_LIMITS } from '@/lib/entitlements'
import type { ImportReport } from '@/lib/import-export'
import type { Monitor, Organization, StatusPage, User } from '@/payload-types'
import {
  getOrgMinIntervalSeconds,
  hasMemberSeat,
  orgAllowsCustomDomains,
} from '@/server/billing/entitlements'
import { effectiveIntervalMs, resyncOrganization, withPlanCadence } from '@/server/engine/scheduler'
import { acceptInviteCode } from '@/server/invites'
import { runRetention } from '@/server/jobs/retention'
import { applyGroupMapping } from '@/server/sso/group-mapping'
import { getDailyKey } from '@/server/stats/uptime-calculator'
import { readFileSync } from 'node:fs'
import path from 'node:path'

type Id = string | number

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+plan-${run}@marmot.test`
const PASSWORD = 'password-123'
const NOW = new Date()
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000)

const MONITOR_DEFAULTS = {
  type: 'manual' as const,
  active: true,
  interval: 60,
  retryInterval: 60,
  maxRetries: 0,
  resendInterval: 0,
  timeout: 48,
}

const setBilling = (enabled: boolean) => {
  if (enabled) process.env.BILLING_ENABLED = 'true'
  else delete process.env.BILLING_ENABLED
  resetEnvCache()
}

/** Runs `fn` and returns the thrown error (tests that expect a rejection). */
async function rejection(
  fn: () => Promise<unknown>,
): Promise<{ status?: number; message: string; data?: Record<string, unknown> }> {
  try {
    await fn()
  } catch (error) {
    return error as { status?: number; message: string; data?: Record<string, unknown> }
  }
  throw new Error('expected the operation to be rejected')
}

const createUser = (name: string) =>
  payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name },
  })

async function as(user: { id: User['id'] }) {
  const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
  return { ...fresh, collection: 'users' as const }
}

async function jwt(user: User): Promise<string> {
  const { token } = await payload.login({
    collection: 'users',
    data: { email: user.email, password: PASSWORD },
  })
  return `JWT ${token}`
}

async function authed(user: User, url: string, method = 'GET', body?: unknown): Promise<Request> {
  return new Request(url, {
    method,
    headers: {
      Authorization: await jwt(user),
      Origin: env.NEXT_PUBLIC_SERVER_URL,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

const orgs: Organization[] = []
async function createOrg(owner: User, name: string): Promise<Organization> {
  const org = await payload.create({
    collection: 'organizations',
    data: { name: `${name} ${run}`, slug: `${name}-${run}` },
    user: await as(owner),
    overrideAccess: false,
  })
  orgs.push(org)
  return org
}

const setPlan = (org: Organization, plan: string, subscriptionStatus: string) =>
  payload.update({
    collection: 'organizations',
    id: org.id,
    data: { plan, subscriptionStatus } as never,
  })

async function createMonitor(
  user: User,
  org: Organization,
  data: Partial<typeof MONITOR_DEFAULTS> & { name: string },
): Promise<Monitor> {
  return payload.create({
    collection: 'monitors',
    data: { ...MONITOR_DEFAULTS, ...data, organization: org.id } as never,
    user: await as(user),
    overrideAccess: false,
    depth: 0,
  })
}

const errorBody = async (res: Response) =>
  ((await res.json()) as { errors: { message: string; data?: Record<string, unknown> }[] })
    .errors[0]

let owner: User
const previousBilling = process.env.BILLING_ENABLED

beforeAll(async () => {
  payload = await getPayload({ config })
  setBilling(false)
  owner = await createUser('owner')
})

afterAll(async () => {
  if (previousBilling === undefined) delete process.env.BILLING_ENABLED
  else process.env.BILLING_ENABLED = previousBilling
  resetEnvCache()
  for (const org of orgs) {
    // Children of imported groups first: deleting a group detaches its children.
    await payload.delete({
      collection: 'monitors',
      where: { and: [{ organization: { equals: org.id } }, { parent: { exists: true } }] },
    })
    for (const collection of [
      'stat-daily',
      'heartbeats',
      'monitors',
      'status-pages',
      'notifications',
    ] as const) {
      await payload.delete({ collection, where: { organization: { equals: org.id } } })
    }
    await payload.delete({ collection: 'organizations', id: org.id })
  }
  await payload.delete({ collection: 'users', where: { email: { like: `+plan-${run}@` } } })
})

describe('minimum check interval', () => {
  let org: Organization
  let fast: Monitor

  beforeAll(async () => {
    org = await createOrg(owner, 'interval')
  })

  it('is not enforced while billing is disabled (self-host)', async () => {
    fast = await createMonitor(owner, org, { name: 'fast', interval: 20, retryInterval: 20 })
    expect(fast.interval).toBe(20)
    expect(await getOrgMinIntervalSeconds(payload, org.id)).toBe(0)
    expect(effectiveIntervalMs(await withPlanCadence(payload, fast))).toBe(20_000)
  })

  it('refuses a new monitor below the plan minimum with a readable 402', async () => {
    setBilling(true)
    for (const field of ['interval', 'retryInterval'] as const) {
      const error = await rejection(() =>
        createMonitor(owner, org, { name: `too fast ${field}`, [field]: 30 }),
      )
      expect(error.status).toBe(402)
      expect(error.message).toBe(
        'Your plan checks monitors at most every 60 seconds. Choose an interval of at least 60 seconds or upgrade your plan.',
      )
      expect(error.data).toEqual({
        code: 'entitlement_exceeded',
        resource: 'minIntervalSeconds',
        limit: PLAN_LIMITS.free.minIntervalSeconds,
        current: 30,
        plan: 'free',
      })
    }
    const ok = await createMonitor(owner, org, { name: 'slow enough', interval: 60 })
    expect(ok.interval).toBe(60)
  })

  it('keeps existing monitors editable and only checks intervals that change', async () => {
    const renamed = await payload.update({
      collection: 'monitors',
      id: fast.id,
      data: { name: 'fast (renamed)', interval: 20 },
      user: await as(owner),
      overrideAccess: false,
    })
    expect(renamed.name).toBe('fast (renamed)')
    const error = await rejection(async () =>
      payload.update({
        collection: 'monitors',
        id: fast.id,
        data: { interval: 30 },
        user: await as(owner),
        overrideAccess: false,
      }),
    )
    expect(error.status).toBe(402)
  })

  it('answers 402 with the structured data on the REST routes (PATCH and clone)', async () => {
    const routeParams = { params: Promise.resolve({ orgId: String(org.id), id: String(fast.id) }) }
    const patched = await patchMonitor(
      await authed(owner, `http://localhost/api/orgs/${org.id}/monitors/${fast.id}`, 'PATCH', {
        interval: 25,
      }),
      routeParams,
    )
    expect(patched.status).toBe(402)
    expect(await errorBody(patched)).toMatchObject({
      message: expect.stringContaining('at most every 60 seconds'),
      data: { code: 'entitlement_exceeded', resource: 'minIntervalSeconds', limit: 60 },
    })

    // The clone copies the 20 s interval of the monitor created before billing was on.
    const cloned = await cloneMonitor(
      await authed(owner, `http://localhost/api/orgs/${org.id}/monitors/${fast.id}/clone`, 'POST'),
      { params: Promise.resolve({ orgId: String(org.id), id: String(fast.id) }) },
    )
    expect(cloned.status).toBe(402)
  })

  it('schedules checks no faster than the plan, following upgrades and downgrades', async () => {
    const free = await withPlanCadence(payload, fast)
    expect(effectiveIntervalMs(free)).toBe(60_000)

    await setPlan(org, 'team', 'active')
    expect(effectiveIntervalMs(await withPlanCadence(payload, fast))).toBe(30_000)

    const upserts: { id: string; every: number }[] = []
    const queue = {
      upsertJobScheduler: vi.fn(async (id: string, repeat: { every: number }) => {
        upserts.push({ id, every: repeat.every })
      }),
      removeJobScheduler: vi.fn(async () => true),
    }
    // Downgrade: the subscription is canceled, the free minimum applies again.
    await setPlan(org, 'team', 'canceled')
    const synced = await resyncOrganization(payload, org.id, queue as never)
    expect(synced).toBeGreaterThanOrEqual(2)
    const fastUpsert = upserts.find((u) => u.id.endsWith(String(fast.id)))
    expect(fastUpsert?.every).toBe(60_000)
    // A monitor whose own interval is longer keeps it.
    for (const upsert of upserts) expect(upsert.every).toBeGreaterThanOrEqual(60_000)

    setBilling(false)
    expect(effectiveIntervalMs(await withPlanCadence(payload, fast))).toBe(20_000)
  })
})

describe('custom domains', () => {
  let org: Organization
  let page: StatusPage
  const host = `status-${run}.plan-limits.test`

  const resolve = async (hostname: string) => {
    const res = await resolveDomain(
      new Request(`http://localhost/api/status-pages/resolve-domain?host=${hostname}`),
    )
    return { status: res.status, body: (await res.json()) as { slug?: string } }
  }

  beforeAll(async () => {
    setBilling(false)
    org = await createOrg(owner, 'domains')
  })

  afterAll(() => setBilling(false))

  it('refuses a custom domain on a plan without them (402)', async () => {
    setBilling(true)
    const error = await rejection(async () =>
      payload.create({
        collection: 'status-pages',
        data: {
          organization: org.id,
          title: 'Status',
          slug: `domains-${run}`,
          published: true,
          domains: [{ hostname: host }],
        } as never,
        user: await as(owner),
        overrideAccess: false,
      }),
    )
    expect(error.status).toBe(402)
    expect(error.data).toMatchObject({ resource: 'customDomains', plan: 'free' })
    expect(error.message).toMatch(/does not include custom domains/)
  })

  it('accepts them on a paid plan and resolves the hostname', async () => {
    await setPlan(org, 'team', 'active')
    page = await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'Status',
        slug: `domains-${run}`,
        published: true,
        domains: [{ hostname: host }],
      } as never,
      user: await as(owner),
      overrideAccess: false,
    })
    expect(await resolve(host)).toEqual({ status: 200, body: { slug: page.slug } })
  })

  it('stops resolving after a downgrade but keeps the domains and the page', async () => {
    await setPlan(org, 'team', 'canceled')
    expect(await orgAllowsCustomDomains(payload, org.id)).toBe(false)
    expect((await resolve(host)).status).toBe(404)

    // Editing the page keeps the stored hostname; adding another one is refused.
    const edited = await payload.update({
      collection: 'status-pages',
      id: page.id,
      data: { title: 'Status (edited)', domains: [{ hostname: host }] } as never,
      user: await as(owner),
      overrideAccess: false,
    })
    expect(edited.domains?.map((d) => d.hostname)).toEqual([host])
    const error = await rejection(async () =>
      payload.update({
        collection: 'status-pages',
        id: page.id,
        data: { domains: [{ hostname: host }, { hostname: `www.${host}` }] } as never,
        user: await as(owner),
        overrideAccess: false,
      }),
    )
    expect(error.status).toBe(402)

    // Upgrading again restores the hostname without re-entering it.
    await setPlan(org, 'pro', 'active')
    expect(await resolve(host)).toEqual({ status: 200, body: { slug: page.slug } })
  })

  it('always resolves with billing disabled', async () => {
    await setPlan(org, 'free', 'none')
    setBilling(false)
    expect((await resolve(host)).status).toBe(200)
  })
})

describe('member seats outside invitations', () => {
  let org: Organization
  let code: string
  const joiners: User[] = []

  beforeAll(async () => {
    setBilling(false)
    org = await createOrg(owner, 'seats')
    code = generateInviteLinkToken()
    await payload.update({
      collection: 'organizations',
      id: org.id,
      data: { inviteLinkToken: code },
    })
    for (let i = 0; i < 4; i++) joiners.push(await createUser(`joiner${i}`))
  })

  afterAll(() => setBilling(false))

  it('lets the invite link fill the plan, then refuses the next join with a 402', async () => {
    setBilling(true)
    // Owner + two joiners = the free plan's three seats.
    await acceptInviteCode({ payload, code, user: joiners[0] })
    await acceptInviteCode({ payload, code, user: joiners[1] })
    expect(await hasMemberSeat(payload, org.id)).toBe(false)

    const error = await rejection(() => acceptInviteCode({ payload, code, user: joiners[2] }))
    expect(error.status).toBe(402)
    expect(error.data).toMatchObject({ resource: 'members', limit: PLAN_LIMITS.free.maxMembers })

    // The invite page's route answers with the readable message.
    const res = await acceptInviteRoute(
      await authed(joiners[2], `http://localhost/api/invite/${code}/accept`, 'POST'),
      { params: Promise.resolve({ code }) },
    )
    expect(res.status).toBe(402)
    expect(await errorBody(res)).toMatchObject({
      message: 'Your plan allows 3 members. Upgrade your plan to add more.',
      data: { code: 'entitlement_exceeded', resource: 'members' },
    })

    // Somebody who is already a member just goes through.
    const again = await acceptInviteCode({ payload, code, user: joiners[0] })
    expect(again.role).toBe('member')
  })

  it('skips SSO group mapping into a full organization and audits it', async () => {
    const user = joiners[2]
    const result = await applyGroupMapping({
      payload,
      request: { headers: new Headers() },
      userId: user.id,
      provider: { id: `plan-${run}`, name: 'Plan IdP' },
      policy: {
        claim: 'groups',
        allowed: [],
        rules: [{ group: 'eng', org: { id: org.id }, role: 'member' }],
        remove: false,
      },
      groups: ['eng'],
    })
    expect(result.changed).toBe(false)
    expect(result.roles.has(String(org.id))).toBe(false)
    expect(getUserRole(await as(user), org.id)).toBeNull()
    const { docs } = await payload.find({
      collection: 'audit-logs',
      where: {
        and: [{ action: { equals: 'member.sync_skipped' } }, { organization: { equals: org.id } }],
      },
      depth: 0,
    })
    expect(docs.some((row) => (row.metadata as { reason?: string })?.reason === 'plan_limit')).toBe(
      true,
    )
  })

  it('skips just-in-time SSO membership into a full organization', async () => {
    const user = joiners[3]
    await userResolution.afterLogin!({
      payload,
      user,
      created: false,
      linked: false,
      request: new Request('http://localhost/api/auth/callback'),
      identity: { providerAccountId: `jit-${run}`, email: user.email, raw: {} },
      provider: {
        id: `conn-${run}`,
        name: 'Acme SSO',
        type: 'oidc',
        meta: {
          connectionId: `conn-${run}`,
          organization: org.id,
          autoProvision: true,
          defaultRole: 'member',
          groupClaim: 'groups',
          allowedGroups: [],
          groupRoles: [],
        },
      },
    } as never)
    expect(getUserRole(await as(user), org.id)).toBeNull()
  })

  it('adds members freely with billing disabled', async () => {
    setBilling(false)
    await acceptInviteCode({ payload, code, user: joiners[2] })
    await addOrgMembership({ payload, userId: joiners[3].id, orgId: org.id, role: 'member' })
    expect(getUserRole(await as(joiners[2]), org.id)).toBe('member')
  })
})

describe('retention', () => {
  let freeOrg: Organization
  let proOrg: Organization
  let freeMonitor: Monitor
  let proMonitor: Monitor

  const daily = (monitor: Monitor, org: Organization, days: number) =>
    payload.create({
      collection: 'stat-daily',
      data: {
        monitor: monitor.id,
        organization: org.id,
        timestamp: getDailyKey(daysAgo(days)),
        up: 1,
        down: 0,
      } as never,
      depth: 0,
    })
  const important = (monitor: Monitor, org: Organization, days: number) =>
    payload.create({
      collection: 'heartbeats',
      data: {
        monitor: monitor.id,
        organization: org.id,
        status: 'down',
        important: true,
        downCount: 1,
        time: daysAgo(days).toISOString(),
      } as never,
      depth: 0,
    })
  const exists = async (collection: 'stat-daily' | 'heartbeats', id: Id) =>
    (await payload.count({ collection, where: { id: { equals: id } } })).totalDocs === 1

  beforeAll(async () => {
    setBilling(false)
    freeOrg = await createOrg(owner, 'retention-free')
    proOrg = await createOrg(owner, 'retention-pro')
    await setPlan(proOrg, 'pro', 'active')
    freeMonitor = await createMonitor(owner, freeOrg, { name: 'kept', active: false } as never)
    proMonitor = await createMonitor(owner, proOrg, { name: 'kept', active: false } as never)
  })

  afterAll(() => setBilling(false))

  it('keeps the instance retention for everyone while billing is disabled', async () => {
    const row = await daily(freeMonitor, freeOrg, 45)
    await runRetention(payload, NOW, { keepDataPeriodDays: 365 })
    expect(await exists('stat-daily', row.id)).toBe(true)
    await payload.delete({ collection: 'stat-daily', id: row.id })
  })

  it("prunes daily rows and important beats at the plan's retentionDays", async () => {
    setBilling(true)
    const freeOld = await daily(freeMonitor, freeOrg, 40)
    const freeRecent = await daily(freeMonitor, freeOrg, 10)
    const freeOldBeat = await important(freeMonitor, freeOrg, 40)
    const freeRecentBeat = await important(freeMonitor, freeOrg, 10)
    const proOld = await daily(proMonitor, proOrg, 40)
    const proOldBeat = await important(proMonitor, proOrg, 40)

    await runRetention(payload, NOW, { keepDataPeriodDays: 365 })

    expect(await exists('stat-daily', freeOld.id)).toBe(false)
    expect(await exists('heartbeats', freeOldBeat.id)).toBe(false)
    expect(await exists('stat-daily', freeRecent.id)).toBe(true)
    expect(await exists('heartbeats', freeRecentBeat.id)).toBe(true)
    // Pro keeps 365 days.
    expect(await exists('stat-daily', proOld.id)).toBe(true)
    expect(await exists('heartbeats', proOldBeat.id)).toBe(true)
  })

  it('never offers a stats period longer than the plan keeps (402)', async () => {
    const stats = async (range: string) =>
      orgMonitorStats(
        await authed(
          owner,
          `http://localhost/api/orgs/${freeOrg.id}/monitors/${freeMonitor.id}/stats?range=${range}`,
        ),
        { params: Promise.resolve({ orgId: String(freeOrg.id), id: String(freeMonitor.id) }) },
      )
    const refused = await stats('90d')
    expect(refused.status).toBe(402)
    expect(await errorBody(refused)).toMatchObject({
      message: 'Your plan keeps 30 days of history. Choose a shorter period or upgrade your plan.',
      data: { resource: 'retentionDays', limit: 30, current: 90 },
    })
    expect((await stats('30d')).status).toBe(200)
    setBilling(false)
    expect((await stats('1y')).status).toBe(200)
  })
})

describe('Uptime Kuma import', () => {
  let org: Organization

  const kumaBackup = () =>
    JSON.parse(
      readFileSync(path.join(process.cwd(), 'tests/fixtures/uptime-kuma-backup.json'), 'utf8'),
    ) as Record<string, unknown>
  const importKuma = async () =>
    importKumaRoute(
      await authed(
        owner,
        `http://localhost/api/orgs/${org.id}/import/uptime-kuma`,
        'POST',
        kumaBackup(),
      ),
      { params: Promise.resolve({ orgId: String(org.id) }) },
    )
  const monitorCount = async () =>
    (await payload.count({ collection: 'monitors', where: { organization: { equals: org.id } } }))
      .totalDocs

  beforeAll(async () => {
    setBilling(false)
    org = await createOrg(owner, 'kuma')
  })

  afterAll(() => setBilling(false))

  it('raises intervals to the plan minimum with a warning', async () => {
    setBilling(true)
    const res = await importKuma()
    expect(res.status).toBe(201)
    const report = (await res.json()) as ImportReport
    expect(report.warnings.some((w) => w.includes('raised to 60 seconds'))).toBe(true)
    const { docs } = await payload.find({
      collection: 'monitors',
      where: { organization: { equals: org.id } },
      depth: 0,
      limit: 0,
    })
    expect(docs.length).toBeGreaterThan(0)
    for (const monitor of docs) {
      expect(monitor.interval).toBeGreaterThanOrEqual(PLAN_LIMITS.free.minIntervalSeconds)
      expect(monitor.retryInterval).toBeGreaterThanOrEqual(PLAN_LIMITS.free.minIntervalSeconds)
    }
  })

  it('refuses an import that would exceed the monitor limit before writing anything', async () => {
    const before = await monitorCount()
    const res = await importKuma()
    expect(res.status).toBe(402)
    expect(await errorBody(res)).toMatchObject({
      data: { code: 'entitlement_exceeded', resource: 'monitors' },
    })
    expect(await monitorCount()).toBe(before)
  })
})
