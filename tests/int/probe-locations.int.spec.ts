/**
 * Probe locations (#91): the location token (hashed, shown once, rotation and deletion stop
 * ingestion), access control, the probe wire API (config with ETag, results through the state
 * machine with the location on the heartbeat), offline detection with its notices, audit rows,
 * the engine leaving probe-checked monitors alone, and the agent loop end to end against the route
 * handlers.
 */
import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import type { Role } from '@/access/permissions'
import {
  DELETE as deleteLocationRoute,
  PATCH as patchLocationRoute,
} from '@/app/api/orgs/[orgId]/locations/[id]/route'
import { POST as rotateTokenRoute } from '@/app/api/orgs/[orgId]/locations/[id]/rotate-token/route'
import {
  GET as listLocationsRoute,
  POST as createLocationRoute,
} from '@/app/api/orgs/[orgId]/locations/route'
import { POST as checkNowRoute } from '@/app/api/orgs/[orgId]/monitors/[id]/check/route'
import { GET as probeConfigRoute } from '@/app/api/probe/v1/config/route'
import { POST as probeResultsRoute } from '@/app/api/probe/v1/results/route'
import { env } from '@/env'
import { defaultMonitorValues } from '@/lib/validation/monitor'
import type { AuditLog, Heartbeat, Location, Monitor, Organization, User } from '@/payload-types'
import { ProbeAgent } from '@/probe/agent'
import {
  connectivityLocationOf,
  DEFAULT_LOCATION,
  processCheckJob,
  syncMonitor,
  type ChecksQueue,
} from '@/server/engine'
import { refreshLocationStatuses, type LocationNotice } from '@/server/probes/health'
import { ingestProbeResults } from '@/server/probes/ingest'
import { hashProbeToken } from '@/server/probes/tokens'
import { PROBE_CONFIG_PATH, PROBE_RESULTS_PATH, type ProbeConfig } from '@/server/probes/wire'

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+probe-${run}@marmot.test`
const PASSWORD = 'password-123'

type Session = { user: User; cookie: string }

let org: Organization
let otherOrg: Organization
let admin: Session
let member: Session

async function createMember(name: string, target: Organization, role: Role): Promise<Session> {
  const user = await payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name },
  })
  await addOrgMembership({ payload, userId: user.id, orgId: target.id, role })
  const { token } = await payload.login({
    collection: 'users',
    data: { email: email(name), password: PASSWORD },
  })
  return { user, cookie: `payload-token=${token}` }
}

/** Browser-like request: Payload only honours the cookie when `Origin` passes its CSRF allowlist. */
function userRequest(session: Session, path: string, method = 'GET', body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      Origin: env.NEXT_PUBLIC_SERVER_URL,
      cookie: session.cookie,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

function probeRequest(token: string, path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'user-agent': 'marmot-probe/9.9.9',
      'x-marmot-probe-hostname': 'probe-host',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  })
}

const orgParams = (target: Organization = org) => ({
  params: Promise.resolve({ orgId: String(target.id) }),
})
const idParams = (id: string | number, target: Organization = org) => ({
  params: Promise.resolve({ orgId: String(target.id), id: String(id) }),
})

async function createLocation(name: string, session: Session = admin) {
  const response = await createLocationRoute(
    userRequest(session, `/api/orgs/${org.id}/locations`, 'POST', {
      name,
      labels: [{ key: 'region', value: 'eu-west' }],
    }),
    orgParams(),
  )
  return {
    response,
    body: (await response.json()) as { doc: { id: string; slug: string }; token: string },
  }
}

async function createMonitor(
  data: Partial<Monitor> & { name: string },
  target: Organization = org,
) {
  return (await payload.create({
    collection: 'monitors',
    data: {
      ...defaultMonitorValues('http'),
      url: 'http://127.0.0.1:9/never',
      interval: 60,
      retryInterval: 30,
      organization: target.id,
      ...data,
    } as never,
    overrideAccess: true,
    depth: 0,
  })) as Monitor
}

/** Route responses carry string ids; Payload wants the adapter's id type (numbers on Postgres). */
const dbId = (id: string | number): string | number =>
  payload.db.defaultIDType === 'number' ? Number(id) : String(id)

const loadLocation = async (id: string | number) =>
  (await payload.findByID({
    collection: 'locations',
    id,
    depth: 0,
    overrideAccess: true,
  })) as Location

const loadMonitor = async (id: string | number) =>
  (await payload.findByID({
    collection: 'monitors',
    id,
    depth: 0,
    overrideAccess: true,
  })) as Monitor

async function heartbeatsOf(monitorId: string | number): Promise<Heartbeat[]> {
  const { docs } = await payload.find({
    collection: 'heartbeats',
    where: { monitor: { equals: monitorId } },
    sort: 'time',
    depth: 0,
    limit: 100,
    overrideAccess: true,
  })
  return docs as Heartbeat[]
}

async function auditRows(entityId: string | number): Promise<AuditLog[]> {
  const { docs } = await payload.find({
    collection: 'audit-logs',
    where: {
      and: [{ entityType: { equals: 'location' } }, { entityId: { equals: String(entityId) } }],
    },
    sort: 'createdAt',
    depth: 0,
    limit: 50,
  })
  return docs as AuditLog[]
}

function fakeQueue() {
  const upserts: string[] = []
  const removals: string[] = []
  const queue = {
    upsertJobScheduler: vi.fn(async (key: string) => void upserts.push(key)),
    removeJobScheduler: vi.fn(async (key: string) => {
      removals.push(key)
      return true
    }),
  } as unknown as ChecksQueue
  return { queue, upserts, removals }
}

beforeAll(async () => {
  payload = await getPayload({ config })
  org = await payload.create({
    collection: 'organizations',
    data: { name: 'Probe org', slug: `probe-${run}` },
  })
  otherOrg = await payload.create({
    collection: 'organizations',
    data: { name: 'Other probe org', slug: `probe-other-${run}` },
  })
  admin = await createMember('admin', org, 'admin')
  member = await createMember('member', org, 'member')
})

afterAll(async () => {
  for (const target of [org, otherOrg]) {
    if (!target) continue
    await payload.delete({ collection: 'monitors', where: { organization: { equals: target.id } } })
    await payload.delete({ collection: 'organizations', where: { id: { equals: target.id } } })
  }
  await payload.delete({
    collection: 'users',
    where: { email: { like: `+probe-${run}@marmot.test` } },
  })
})

describe('location tokens and access', () => {
  it('lets admins create a location, returns the token once and stores only its hash', async () => {
    const { response, body } = await createLocation('Office Berlin')
    expect(response.status).toBe(201)
    expect(body.token).toMatch(/^mp_[A-Za-z0-9]{8}_/)
    expect(body.doc.slug).toBe('office-berlin')
    expect(JSON.stringify(body.doc)).not.toContain(body.token)

    const stored = await loadLocation(body.doc.id)
    expect(stored.tokenHash).toBe(hashProbeToken(body.token))
    expect(stored.status).toBe('unknown')
    expect(stored.labels?.map((l) => [l.key, l.value])).toEqual([['region', 'eu-west']])

    // Members may see locations (to pick one for a monitor) but never the hash or a token.
    const list = await listLocationsRoute(
      userRequest(member, `/api/orgs/${org.id}/locations`),
      orgParams(),
    )
    expect(list.status).toBe(200)
    const listed = (await list.json()) as { docs: Record<string, unknown>[] }
    const row = listed.docs.find((d) => d.id === body.doc.id)
    expect(row).toBeDefined()
    expect(row).not.toHaveProperty('tokenHash')
    const memberUser = await payload.findByID({ collection: 'users', id: member.user.id, depth: 0 })
    const asMember = await payload.findByID({
      collection: 'locations',
      id: stored.id,
      user: { ...memberUser, collection: 'users' },
      overrideAccess: false,
    })
    expect(asMember).not.toHaveProperty('tokenHash')
  })

  it('refuses members, duplicate slugs and the reserved slug', async () => {
    const forbidden = await createLocationRoute(
      userRequest(member, `/api/orgs/${org.id}/locations`, 'POST', { name: 'Nope' }),
      orgParams(),
    )
    expect(forbidden.status).toBe(403)

    await createLocation('Duplicate slug')
    const duplicate = await createLocation('Duplicate slug')
    expect(duplicate.response.status).toBe(400)

    const reserved = await createLocationRoute(
      userRequest(admin, `/api/orgs/${org.id}/locations`, 'POST', { name: 'Here', slug: 'local' }),
      orgParams(),
    )
    expect(reserved.status).toBe(400)
  })

  it('audits create, update, token rotation and delete', async () => {
    const { body } = await createLocation('Audited')
    const patched = await patchLocationRoute(
      userRequest(admin, `/api/orgs/${org.id}/locations/${body.doc.id}`, 'PATCH', {
        name: 'Audited 2',
      }),
      idParams(body.doc.id),
    )
    expect(patched.status).toBe(200)
    const rotated = await rotateTokenRoute(
      userRequest(admin, `/api/orgs/${org.id}/locations/${body.doc.id}/rotate-token`, 'POST'),
      idParams(body.doc.id),
    )
    expect(rotated.status).toBe(200)
    const deleted = await deleteLocationRoute(
      userRequest(admin, `/api/orgs/${org.id}/locations/${body.doc.id}`, 'DELETE'),
      idParams(body.doc.id),
    )
    expect(deleted.status).toBe(200)

    const rows = await auditRows(body.doc.id)
    expect(rows.map((r) => r.action)).toEqual([
      'location.created',
      'location.updated',
      'location.token_rotated',
      'location.deleted',
    ])
    expect(rows.every((r) => String(r.actor) === String(admin.user.id))).toBe(true)
    expect(JSON.stringify(rows)).not.toContain(hashProbeToken(body.token))
  })
})

describe('monitor assignment', () => {
  it('accepts locations of the same organization for types a probe can run', async () => {
    const { body } = await createLocation('Assignable')
    const monitor = await createMonitor({
      name: 'Assigned',
      locations: [dbId(body.doc.id)] as never,
    })
    expect(monitor.locations?.map(String)).toEqual([String(body.doc.id)])
    expect(connectivityLocationOf(monitor)).toBe(String(body.doc.id))
    expect(connectivityLocationOf({ locations: [] })).toBe(DEFAULT_LOCATION)

    // Several locations are allowed since multi-location quorum (#92).
    const second = await createLocation('Second')
    const two = await createMonitor({
      name: 'Two',
      locations: [dbId(body.doc.id), dbId(second.body.doc.id)] as never,
    })
    expect(two.locations?.map(String)).toEqual([String(body.doc.id), String(second.body.doc.id)])
    await expect(
      createMonitor({ name: 'Push', type: 'push', locations: [dbId(body.doc.id)] as never }),
    ).rejects.toThrow()
    await expect(
      createMonitor({ name: 'Foreign', locations: [dbId(body.doc.id)] as never }, otherOrg),
    ).rejects.toThrow()
  })

  it('keeps probe-checked monitors off the workers', async () => {
    const { body } = await createLocation('Engine')
    const monitor = await createMonitor({
      name: 'Engine remote',
      active: true,
      locations: [dbId(body.doc.id)] as never,
    })
    const { queue, upserts, removals } = fakeQueue()
    await syncMonitor(monitor, queue)
    expect(upserts).toEqual([])
    expect(removals).toEqual([`monitor:${monitor.id}`])

    const result = await processCheckJob(
      payload,
      { data: { monitorId: String(monitor.id) } },
      { queue },
    )
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'remote' })
    expect(await heartbeatsOf(monitor.id)).toHaveLength(0)

    // "Check now" cannot record a beat from this server for it.
    const checkNow = await checkNowRoute(
      userRequest(admin, `/api/orgs/${org.id}/monitors/${monitor.id}/check`, 'POST'),
      idParams(monitor.id),
    )
    expect(checkNow.status).toBe(409)
  })

  it('moves monitors back to the local workers when their location is deleted', async () => {
    const { body } = await createLocation('Doomed')
    const monitor = await createMonitor({ name: 'Orphan', locations: [dbId(body.doc.id)] as never })
    await payload.delete({ collection: 'locations', id: body.doc.id, overrideAccess: true })
    expect((await loadMonitor(monitor.id)).locations ?? []).toEqual([])
  })
})

describe('probe API', () => {
  let token: string
  let locationId: string
  let monitor: Monitor
  let unassigned: Monitor

  beforeAll(async () => {
    const { body } = await createLocation('Probe API')
    token = body.token
    locationId = body.doc.id
    monitor = await createMonitor({
      name: 'Remote API',
      active: true,
      maxRetries: 0,
      locations: [dbId(locationId)] as never,
    })
    unassigned = await createMonitor({ name: 'Local API', active: true })
  })

  it('serves the assigned monitors with an ETag and stamps lastSeenAt', async () => {
    const response = await probeConfigRoute(probeRequest(token, PROBE_CONFIG_PATH))
    expect(response.status).toBe(200)
    const etag = response.headers.get('etag')
    expect(etag).toBeTruthy()
    const body = (await response.json()) as ProbeConfig
    expect(body.location.id).toBe(String(locationId))
    expect(body.monitors.map((m) => String(m.id))).toEqual([String(monitor.id)])
    expect(body.monitors[0]).not.toHaveProperty('notifications')
    expect(body.refreshSeconds).toBeLessThanOrEqual(60)

    const cached = await probeConfigRoute(
      probeRequest(token, PROBE_CONFIG_PATH, { headers: { 'if-none-match': etag! } }),
    )
    expect(cached.status).toBe(304)

    const stored = await loadLocation(locationId)
    expect(stored.lastSeenAt).toBeTruthy()
    expect(stored.agent).toMatchObject({ version: '9.9.9', hostname: 'probe-host' })
  })

  it('rejects missing and unknown tokens', async () => {
    const none = await probeConfigRoute(new Request(`http://localhost${PROBE_CONFIG_PATH}`))
    expect(none.status).toBe(401)
    const wrong = await probeConfigRoute(
      probeRequest(`mp_AAAAAAAA_${'x'.repeat(43)}`, PROBE_CONFIG_PATH),
    )
    expect(wrong.status).toBe(401)
  })

  it('records results through the state machine with the location on the heartbeat', async () => {
    const t0 = Date.now() - 5_000
    const post = (results: unknown[]) =>
      probeResultsRoute(
        probeRequest(token, PROBE_RESULTS_PATH, {
          method: 'POST',
          body: JSON.stringify({ results }),
        }),
      )
    const response = await post([
      {
        monitorId: monitor.id,
        time: new Date(t0).toISOString(),
        ok: true,
        msg: '200 OK',
        ping: 12,
      },
      {
        monitorId: monitor.id,
        time: new Date(t0 + 1_000).toISOString(),
        ok: false,
        msg: 'ECONNREFUSED',
      },
      { monitorId: unassigned.id, time: new Date(t0).toISOString(), ok: true, msg: 'x' },
    ])
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      accepted: number
      results: {
        monitorId: string
        accepted: boolean
        status?: string
        reason?: string
        nextCheckSeconds?: number
      }[]
    }
    expect(body.accepted).toBe(2)
    expect(body.results[0]).toMatchObject({ accepted: true, status: 'up', nextCheckSeconds: 60 })
    expect(body.results[1]).toMatchObject({ accepted: true, status: 'down' })
    expect(body.results[2]).toMatchObject({ accepted: false, reason: 'not-assigned' })

    const beats = await heartbeatsOf(monitor.id)
    expect(beats.map((b) => b.status)).toEqual(['up', 'down'])
    expect(
      beats.every(
        (b) =>
          String(typeof b.location === 'object' ? b.location?.id : b.location) ===
          String(locationId),
      ),
    ).toBe(true)
    expect(beats[0].ping).toBe(12)
    const updated = await loadMonitor(monitor.id)
    expect(updated.status?.lastStatus).toBe('down')

    // A batch re-sent after a lost response is recorded once; old results are refused.
    const again = await post([
      {
        monitorId: monitor.id,
        time: new Date(t0 + 1_000).toISOString(),
        ok: false,
        msg: 'ECONNREFUSED',
      },
      { monitorId: monitor.id, time: new Date(Date.now() - 3_600_000).toISOString(), ok: true },
    ])
    const againBody = (await again.json()) as { results: { reason?: string }[] }
    expect(againBody.results.map((r) => r.reason)).toEqual(['duplicate', 'stale'])
    expect(await heartbeatsOf(monitor.id)).toHaveLength(2)

    const invalid = await post([{ monitorId: monitor.id, ok: 'yes' }])
    expect(invalid.status).toBe(400)
  })

  it('stops ingestion when the token is rotated', async () => {
    const rotated = await rotateTokenRoute(
      userRequest(admin, `/api/orgs/${org.id}/locations/${locationId}/rotate-token`, 'POST'),
      idParams(locationId),
    )
    const { token: next } = (await rotated.json()) as { token: string }
    expect(next).not.toBe(token)
    expect((await probeConfigRoute(probeRequest(token, PROBE_CONFIG_PATH))).status).toBe(401)
    expect((await probeConfigRoute(probeRequest(next, PROBE_CONFIG_PATH))).status).toBe(200)
    token = next
  })

  it('holds results while the probe is offline and applies maintenance on the server', async () => {
    const location = await loadLocation(locationId)
    const held = await ingestProbeResults(
      payload,
      location,
      [
        {
          monitorId: monitor.id,
          time: new Date().toISOString(),
          ok: false,
          msg: 'checker offline',
          checkerOffline: true,
        },
      ],
      { pipeline: false },
    )
    expect(held.results[0]).toMatchObject({ accepted: true, status: 'pending' })
    // The cached status stays what it was (DOWN) while the probe's uplink is out.
    expect((await loadMonitor(monitor.id)).status?.lastStatus).toBe('down')
  })
})

describe('offline detection', () => {
  it('derives online and offline from lastSeenAt and notifies on each change', async () => {
    const { body } = await createLocation('Heartbeat')
    const notices: LocationNotice[] = []
    const deliver = () => async (_payload: Payload, notice: LocationNotice) => {
      notices.push(notice)
    }
    const start = new Date()
    await payload.update({
      collection: 'locations',
      id: body.doc.id,
      data: { lastSeenAt: start.toISOString() },
      overrideAccess: true,
    })

    const online = await refreshLocationStatuses(payload, start, { deliver })
    expect(online.changed).toContainEqual({
      id: String(body.doc.id),
      from: 'unknown',
      to: 'online',
    })
    // Coming online for the first time is not an incident.
    expect(notices.filter((n) => String(n.location.id) === String(body.doc.id))).toHaveLength(0)

    const later = new Date(start.getTime() + (env.PROBE_OFFLINE_AFTER + 1) * 1000)
    const offline = await refreshLocationStatuses(payload, later, { deliver })
    expect(offline.changed).toContainEqual({
      id: String(body.doc.id),
      from: 'online',
      to: 'offline',
    })
    expect((await loadLocation(body.doc.id)).status).toBe('offline')

    // Unchanged: no second notice.
    await refreshLocationStatuses(payload, new Date(later.getTime() + 1_000), { deliver })

    await payload.update({
      collection: 'locations',
      id: body.doc.id,
      data: { lastSeenAt: later.toISOString() },
      overrideAccess: true,
    })
    await refreshLocationStatuses(payload, later, { deliver })
    const mine = notices.filter((n) => String(n.location.id) === String(body.doc.id))
    expect(mine.map((n) => n.kind)).toEqual(['offline', 'online'])
    expect(mine[1].offlineSince).toBeTruthy()

    // Status changes made by the job are not audited (only people's changes are).
    expect((await auditRows(body.doc.id)).map((r) => r.action)).toEqual(['location.created'])
  })
})

describe('probe agent', () => {
  it('pulls its monitors, runs them and reports the results; a rotated token stops it', async () => {
    const { body } = await createLocation('Agent')
    const monitor = await createMonitor({
      name: 'Agent target',
      active: true,
      locations: [dbId(body.doc.id)] as never,
    })
    // Route the agent's HTTP calls to the route handlers.
    const fetchToRoutes = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      const { pathname } = new URL(request.url)
      if (pathname === PROBE_CONFIG_PATH) return probeConfigRoute(request)
      if (pathname === PROBE_RESULTS_PATH) return probeResultsRoute(request)
      return new Response('not found', { status: 404 })
    }) as typeof fetch
    const runCheck = vi.fn(async () => ({
      ok: true,
      status: 'up' as const,
      msg: 'probe ok',
      ping: 7,
    }))
    const agent = new ProbeAgent({
      url: 'http://marmot.test',
      token: body.token,
      version: '1.2.3',
      hostname: 'agent-host',
      fetch: fetchToRoutes,
      runCheck,
      connectivity: null,
      initialJitterMs: () => 60_000,
    })
    try {
      await agent.start()
      expect(agent.location?.id).toBe(String(body.doc.id))
      expect(agent.monitorIds()).toEqual([String(monitor.id)])

      await agent.checkNow(String(monitor.id))
      expect(runCheck).toHaveBeenCalledTimes(1)
      expect(agent.pendingResults()).toBe(0)
      const beats = await heartbeatsOf(monitor.id)
      expect(beats).toHaveLength(1)
      expect(beats[0]).toMatchObject({ status: 'up', msg: 'probe ok', ping: 7 })

      // Rotating the token: the next refresh is refused and every check stops.
      await rotateTokenRoute(
        userRequest(admin, `/api/orgs/${org.id}/locations/${body.doc.id}/rotate-token`, 'POST'),
        idParams(body.doc.id),
      )
      await agent.refresh()
      expect(agent.authorized).toBe(false)
      expect(agent.monitorIds()).toEqual([])
    } finally {
      await agent.stop()
    }
  })
})
