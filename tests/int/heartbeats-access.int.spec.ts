import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import type { Role } from '@/access/permissions'
import { GET as restGet } from '@/app/(payload)/api/[...slug]/route'
import { env } from '@/env'
import type { Heartbeat, Monitor, Organization, User } from '@/payload-types'
import { loadOrgState } from '@/server/realtime/state'
import { clearStatistics, recordHeartbeat } from '@/server/stats/uptime-calculator'

/**
 * Heartbeats and the stat rollups are readable through Payload's REST API only by members of the
 * monitor's organization who hold `monitor:read` (with the organization's permission overrides);
 * superadmins see everything. Before this, any logged-in user could read every organization's rows.
 */

let payload: Payload
const run = Date.now().toString(36)
const email = (name: string) => `${name}+hb-${run}@marmot.test`
const PASSWORD = 'password-123'

type Session = { user: User; cookie: string }
type Id = string | number
type ListResponse = { docs: { id: Id; monitor: Id | { id: Id } }[]; totalDocs: number }

const STAT_COLLECTIONS = ['stat-minutely', 'stat-hourly', 'stat-daily'] as const

async function createSession(
  name: string,
  orgs: [Organization, Role][],
  superadmin = false,
): Promise<Session> {
  const user = await payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name, superadmin },
  })
  for (const [org, role] of orgs) {
    await addOrgMembership({ payload, userId: user.id, orgId: org.id, role })
  }
  const { token } = await payload.login({
    collection: 'users',
    data: { email: email(name), password: PASSWORD },
  })
  return { user, cookie: `payload-token=${token}` }
}

/** The session's user as a Local API request user, re-read so its memberships are current. */
async function asUser(session: Session) {
  const fresh = await payload.findByID({ collection: 'users', id: session.user.id, depth: 0 })
  return { ...fresh, collection: 'users' as const }
}

/** `GET /api/<slug...>?<query>` through Payload's REST handler. */
async function rest(slug: string[], query: string, session?: Session) {
  const url = `http://localhost/api/${slug.join('/')}${query ? `?${query}` : ''}`
  const request = new Request(url, {
    headers: {
      Origin: env.NEXT_PUBLIC_SERVER_URL,
      ...(session ? { cookie: session.cookie } : {}),
    },
  })
  return restGet(request, { params: Promise.resolve({ slug }) })
}

async function list(collection: string, monitor: Monitor, session?: Session) {
  const response = await rest(
    [collection],
    `where[monitor][equals]=${encodeURIComponent(String(monitor.id))}&depth=0&limit=100`,
    session,
  )
  return { status: response.status, body: (await response.json()) as ListResponse }
}

/** Docs of `collection` for `monitor` as `session`; an error status counts as nothing returned. */
async function visible(collection: string, monitor: Monitor, session?: Session) {
  const { status, body } = await list(collection, monitor, session)
  return status === 200 ? body.docs : []
}

const monitorIdOf = (doc: { monitor: Id | { id: Id } }) =>
  String(typeof doc.monitor === 'object' ? doc.monitor.id : doc.monitor)

let orgA: Organization
let orgB: Organization
let monitorA: Monitor
let monitorB: Monitor
let beatA: Heartbeat
let beatB: Heartbeat
let memberA: Session
let viewerA: Session
let memberB: Session
let superadmin: Session

async function createMonitor(org: Organization, name: string): Promise<Monitor> {
  return (await payload.create({
    collection: 'monitors',
    depth: 0,
    overrideAccess: true,
    data: {
      organization: org.id,
      name,
      type: 'manual',
      active: false,
      interval: 60,
      retryInterval: 60,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 48,
    } as never,
  })) as Monitor
}

async function createBeat(monitor: Monitor, org: Organization, msg: string): Promise<Heartbeat> {
  const time = new Date()
  const beat = (await payload.create({
    collection: 'heartbeats',
    depth: 0,
    overrideAccess: true,
    data: {
      monitor: monitor.id,
      organization: org.id,
      status: 'up',
      msg,
      ping: 42,
      important: true,
      time: time.toISOString(),
    } as never,
  })) as Heartbeat
  await recordHeartbeat(payload, {
    monitorId: monitor.id,
    organizationId: org.id,
    status: 'up',
    ping: 42,
    time,
  })
  return beat
}

beforeAll(async () => {
  payload = await getPayload({ config })
  orgA = await payload.create({
    collection: 'organizations',
    data: { name: 'Heartbeats A', slug: `hb-a-${run}` },
  })
  orgB = await payload.create({
    collection: 'organizations',
    data: { name: 'Heartbeats B', slug: `hb-b-${run}` },
  })
  monitorA = await createMonitor(orgA, 'hb-monitor-a')
  monitorB = await createMonitor(orgB, 'hb-monitor-b')
  beatA = await createBeat(monitorA, orgA, 'secret of A')
  beatB = await createBeat(monitorB, orgB, 'secret of B')

  memberA = await createSession('member-a', [[orgA, 'member']])
  viewerA = await createSession('viewer-a', [[orgA, 'viewer']])
  memberB = await createSession('member-b', [[orgB, 'member']])
  superadmin = await createSession('superadmin', [], true)
})

afterAll(async () => {
  for (const monitor of [monitorA, monitorB]) {
    if (monitor) await clearStatistics(payload, monitor.id)
  }
  const orgIds = [orgA?.id, orgB?.id].filter((id) => id !== undefined)
  if (orgIds.length) {
    await payload.delete({ collection: 'monitors', where: { organization: { in: orgIds } } })
    await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
  }
  await payload.delete({
    collection: 'users',
    where: { email: { like: `+hb-${run}@marmot.test` } },
  })
})

describe('heartbeats read access', () => {
  it("does not hand another organization's heartbeats to a member of A", async () => {
    expect(await visible('heartbeats', monitorB, memberA)).toEqual([])

    // Without a filter only A's own rows come back.
    const response = await rest(['heartbeats'], 'depth=0&limit=500&sort=-time', memberA)
    expect(response.status).toBe(200)
    const { docs } = (await response.json()) as ListResponse
    expect(docs.some((doc) => String(doc.id) === String(beatB.id))).toBe(false)
    expect(docs.some((doc) => String(doc.id) === String(beatA.id))).toBe(true)

    // Nor by id.
    const byId = await rest(['heartbeats', String(beatB.id)], 'depth=0', memberA)
    expect(byId.status).not.toBe(200)
  })

  it("shows a member of A (and a viewer of A) A's heartbeats", async () => {
    const docs = await visible('heartbeats', monitorA, memberA)
    expect(docs.map((doc) => String(doc.id))).toEqual([String(beatA.id)])
    expect((docs[0] as unknown as Heartbeat).msg).toBe('secret of A')

    const viewerDocs = await visible('heartbeats', monitorA, viewerA)
    expect(viewerDocs.map((doc) => String(doc.id))).toEqual([String(beatA.id)])

    const byId = await rest(['heartbeats', String(beatA.id)], 'depth=0', memberA)
    expect(byId.status).toBe(200)
  })

  it('keeps each organization to its own heartbeats in both directions', async () => {
    expect(await visible('heartbeats', monitorA, memberB)).toEqual([])
    const docs = await visible('heartbeats', monitorB, memberB)
    expect(docs.map((doc) => String(doc.id))).toEqual([String(beatB.id)])
  })

  it('denies anonymous requests and lets superadmins read everything', async () => {
    expect(await visible('heartbeats', monitorA)).toEqual([])
    expect(await visible('heartbeats', monitorB)).toEqual([])
    expect((await visible('heartbeats', monitorA, superadmin)).length).toBe(1)
    expect((await visible('heartbeats', monitorB, superadmin)).length).toBe(1)
  })

  it("honours the organization's permission overrides for monitor:read", async () => {
    await payload.update({
      collection: 'organizations',
      id: orgA.id,
      data: { permissionOverrides: { 'monitor:read': 'member' } } as never,
      overrideAccess: true,
    })
    try {
      expect(await visible('heartbeats', monitorA, viewerA)).toEqual([])
      expect(await visible('stat-minutely', monitorA, viewerA)).toEqual([])
      expect((await visible('heartbeats', monitorA, memberA)).length).toBe(1)
    } finally {
      await payload.update({
        collection: 'organizations',
        id: orgA.id,
        data: { permissionOverrides: {} } as never,
        overrideAccess: true,
      })
    }
  })

  it('stays read-only through the API', async () => {
    await expect(
      payload.create({
        collection: 'heartbeats',
        data: {
          monitor: monitorA.id,
          organization: orgA.id,
          status: 'down',
          time: new Date().toISOString(),
        } as never,
        user: await asUser(memberA),
        overrideAccess: false,
      }),
    ).rejects.toThrow()
  })
})

describe('stat rollups read access', () => {
  it.each(STAT_COLLECTIONS)("%s: a member of A gets nothing of B's", async (collection) => {
    expect(await visible(collection, monitorB, memberA)).toEqual([])

    const response = await rest([collection], 'depth=0&limit=500', memberA)
    expect(response.status).toBe(200)
    const { docs } = (await response.json()) as ListResponse
    expect(docs.some((doc) => monitorIdOf(doc) === String(monitorB.id))).toBe(false)
  })

  it.each(STAT_COLLECTIONS)("%s: a member of A sees A's", async (collection) => {
    const docs = await visible(collection, monitorA, memberA)
    expect(docs.length).toBe(1)
    expect(monitorIdOf(docs[0])).toBe(String(monitorA.id))
    expect(await visible(collection, monitorB, memberB)).toHaveLength(1)
  })

  it.each(STAT_COLLECTIONS)('%s: anonymous gets nothing', async (collection) => {
    expect(await visible(collection, monitorA)).toEqual([])
  })
})

describe('server paths that read heartbeats for a user', () => {
  it('hydrates the monitors page from monitors read as the user', async () => {
    const state = await loadOrgState(payload, orgA.id, {
      user: (await asUser(memberA)) as never,
      overrideAccess: false,
      heartbeatLimit: 10,
      importantLimit: 10,
      ranges: ['24h'],
    })
    expect(state.monitors.map((monitor) => monitor.id)).toEqual([String(monitorA.id)])
    expect(state.heartbeats[String(monitorA.id)]).toHaveLength(1)
    expect(state.importantHeartbeats[String(monitorA.id)]).toHaveLength(1)

    // A non-member asking for A's state gets no monitors, hence no beats.
    const foreign = await loadOrgState(payload, orgA.id, {
      user: (await asUser(memberB)) as never,
      overrideAccess: false,
    })
    expect(foreign.monitors).toEqual([])
    expect(foreign.heartbeats).toEqual({})
  })
})
