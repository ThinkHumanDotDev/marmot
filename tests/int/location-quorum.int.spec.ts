/**
 * Multi-location checks with quorum-based status (#92): per-location state rows, monitor-level
 * transitions by quorum (only those are important and notify, naming the failing locations),
 * single-location monitors untouched, probe ingest judged per location, the per-location stats
 * series, the location filter, and the safety-net recompute job.
 */
import { randomBytes } from 'node:crypto'

import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import {
  checksLocally,
  isMultiLocation,
  isRemoteMonitor,
  LOCAL_LOCATION,
  monitorLocationKeys,
} from '@/lib/probe-locations'
import { defaultMonitorValues } from '@/lib/validation/monitor'
import type {
  Heartbeat,
  Location,
  Monitor,
  MonitorLocationState,
  Organization,
  User,
} from '@/payload-types'
import {
  recordBeat,
  registerHeartbeatListener,
  syncMonitor,
  type ChecksQueue,
  type HeartbeatEvent,
} from '@/server/engine'
import type { CheckResult } from '@/server/engine/beat'
import { recomputeQuorumStatuses } from '@/server/jobs/quorum-recompute'
import { heartbeatLocationWhere } from '@/server/monitors/location-view'
import { ingestProbeResults } from '@/server/probes/ingest'
import { hashProbeToken } from '@/server/probes/tokens'
import { createStatsListener, getLocationStats } from '@/server/stats'

let payload: Payload
const run = Date.now().toString(36)
let org: Organization
let berlin: Location
let paris: Location
const events: HeartbeatEvent[] = []
const unsubscribe: (() => void)[] = []

const UP: CheckResult = { ok: true, msg: 'OK', ping: 42 }
const fail = (msg: string): CheckResult => ({ ok: false, msg })

async function createLocation(name: string): Promise<Location> {
  return (await payload.create({
    collection: 'locations',
    data: {
      organization: org.id,
      name,
      slug: `${name.toLowerCase()}-${run}`,
      tokenHash: hashProbeToken(`mp_${randomBytes(8).toString('hex')}`),
      tokenPrefix: randomBytes(4).toString('hex'),
    } as never,
    overrideAccess: true,
    depth: 0,
  })) as Location
}

async function createMonitor(data: Partial<Monitor> & { name: string }): Promise<Monitor> {
  return (await payload.create({
    collection: 'monitors',
    data: {
      ...defaultMonitorValues('http'),
      url: 'http://127.0.0.1:9/never',
      interval: 60,
      retryInterval: 20,
      organization: org.id,
      ...data,
    } as never,
    overrideAccess: true,
    depth: 0,
  })) as Monitor
}

const loadMonitor = async (id: string | number) =>
  (await payload.findByID({
    collection: 'monitors',
    id,
    depth: 0,
    overrideAccess: true,
  })) as Monitor

async function statesOf(monitorId: string | number): Promise<Map<string, MonitorLocationState>> {
  const { docs } = await payload.find({
    collection: 'monitor-location-states',
    where: { monitor: { equals: monitorId } },
    depth: 0,
    limit: 50,
    overrideAccess: true,
  })
  return new Map((docs as MonitorLocationState[]).map((doc) => [doc.locationKey, doc]))
}

/** Record one beat at `location` (`null` = the local workers) `seconds` after `base`. */
function beatAt(base: number) {
  let tick = 0
  return async (monitorId: string | number, location: Location | null, result: CheckResult) => {
    tick += 1
    const monitor = await loadMonitor(monitorId)
    return recordBeat(payload, monitor, result, {
      now: new Date(base + tick * 1000),
      location: location ? location.id : null,
      queue: fakeQueue().queue,
    })
  }
}

function fakeQueue() {
  const upserts: { key: string; every: number }[] = []
  const queue = {
    upsertJobScheduler: vi.fn(async (key: string, opts: { every: number }) => {
      upserts.push({ key, every: opts.every })
    }),
    removeJobScheduler: vi.fn(async () => true),
  } as unknown as ChecksQueue
  return { queue, upserts }
}

beforeAll(async () => {
  payload = await getPayload({ config })
  org = await payload.create({
    collection: 'organizations',
    data: { name: 'Quorum org', slug: `quorum-${run}` },
  })
  berlin = await createLocation('Berlin')
  paris = await createLocation('Paris')
  unsubscribe.push(registerHeartbeatListener((event) => void events.push(event)))
})

afterAll(async () => {
  for (const off of unsubscribe) off()
  if (!org) return
  await payload.delete({ collection: 'monitors', where: { organization: { equals: org.id } } })
  await payload.delete({ collection: 'locations', where: { organization: { equals: org.id } } })
  await payload.delete({ collection: 'organizations', id: org.id })
})

describe('location helpers', () => {
  it('derives the location keys, local included on request', () => {
    expect(monitorLocationKeys({ locations: [] })).toEqual([LOCAL_LOCATION])
    expect(monitorLocationKeys({ locations: [1, 2] })).toEqual(['1', '2'])
    expect(monitorLocationKeys({ locations: [1], includeLocal: true })).toEqual([
      '1',
      LOCAL_LOCATION,
    ])
    expect(isMultiLocation({ locations: [1] })).toBe(false)
    expect(isMultiLocation({ locations: [1], includeLocal: true })).toBe(true)
    expect(isRemoteMonitor({ locations: [1], includeLocal: true })).toBe(false)
    expect(checksLocally({ locations: [1] })).toBe(false)
  })
})

describe('monitors with several locations', () => {
  it('saves more than one location with the quorum fields and schedules the local checks', async () => {
    const monitor = await createMonitor({
      name: 'multi save',
      locations: [berlin.id, paris.id],
      includeLocal: true,
    })
    expect(monitorLocationKeys(monitor)).toEqual([
      String(berlin.id),
      String(paris.id),
      LOCAL_LOCATION,
    ])
    expect(monitor.quorum).toBe('half')
    const { queue, upserts } = fakeQueue()
    await syncMonitor(monitor, queue)
    expect(upserts).toHaveLength(1)
    // The quorum may be PENDING; the local scheduler follows the local location only.
    await syncMonitor({ ...monitor, status: { lastStatus: 'pending' } }, queue)
    expect(upserts[1]?.every).toBe(60_000)
    await syncMonitor({ ...monitor, localStatus: 'pending' }, queue)
    expect(upserts[2]?.every).toBe(20_000)
  })

  it('stays UP with one failing location of three and goes DOWN with two', async () => {
    const monitor = await createMonitor({
      name: 'quorum three',
      locations: [berlin.id, paris.id],
      includeLocal: true,
    })
    const beat = beatAt(Date.now() - 60_000)
    events.length = 0

    const first = await beat(monitor.id, berlin, UP)
    expect(first.next).toMatchObject({ status: 'up', important: true, notify: false })
    await beat(monitor.id, paris, UP)
    const third = await beat(monitor.id, null, UP)
    expect(third.next).toMatchObject({ status: 'up', important: false })

    const oneDown = await beat(monitor.id, berlin, fail('connect ETIMEDOUT'))
    expect(oneDown.heartbeat).toMatchObject({
      status: 'up',
      locationStatus: 'down',
      important: false,
    })
    expect(oneDown.locationNext?.status).toBe('down')
    expect(oneDown.next.notify).toBe(false)

    const twoDown = await beat(monitor.id, paris, fail('ECONNREFUSED'))
    expect(twoDown.heartbeat).toMatchObject({
      status: 'down',
      locationStatus: 'down',
      important: true,
    })
    expect(twoDown.next).toMatchObject({ notify: true, notificationEvent: 'down' })
    expect(twoDown.heartbeat.msg).toBe(
      'Down at 2 of 3 locations: Berlin (connect ETIMEDOUT), Paris (ECONNREFUSED)',
    )
    expect(String((twoDown.heartbeat.location as Location | number | string) ?? '')).toBe(
      String(paris.id),
    )

    const states = await statesOf(monitor.id)
    expect(states.get(String(berlin.id))?.lastStatus).toBe('down')
    expect(states.get(String(paris.id))?.lastStatus).toBe('down')
    expect(states.get(LOCAL_LOCATION)?.lastStatus).toBe('up')
    expect((await loadMonitor(monitor.id)).status?.lastStatus).toBe('down')

    // Still down at two locations: neither important nor notified again.
    const stillDown = await beat(monitor.id, null, fail('timeout'))
    expect(stillDown.next).toMatchObject({ status: 'down', important: false, notify: false })

    // Two locations recover: back UP, announced once.
    await beat(monitor.id, null, UP)
    const recovered = await beat(monitor.id, berlin, UP)
    expect(recovered.next).toMatchObject({ status: 'up', important: true, notificationEvent: 'up' })
    expect(recovered.heartbeat.msg).toBe('Up at 2 of 3 locations; failing: Paris (ECONNREFUSED)')

    const notified = events.filter(
      (event) => String(event.monitor.id) === String(monitor.id) && event.notify,
    )
    expect(notified.map((event) => event.notificationEvent)).toEqual(['down', 'up'])
    expect(notified.every((event) => event.location?.key !== undefined)).toBe(true)
  })

  it('keeps each location’s retries and holds a checker-offline beat per location', async () => {
    const monitor = await createMonitor({
      name: 'quorum retries',
      locations: [berlin.id],
      includeLocal: true,
      maxRetries: 1,
    })
    const beat = beatAt(Date.now() - 60_000)
    await beat(monitor.id, berlin, UP)
    await beat(monitor.id, null, UP)

    // Two locations, `half` = 1: the first failure retries (PENDING), the second confirms it.
    const retry = await beat(monitor.id, berlin, fail('boom'))
    expect(retry.locationNext).toMatchObject({ status: 'pending', retries: 1 })
    expect(retry.next).toMatchObject({ status: 'pending', important: false })
    // The local location is held while its checker is offline: nothing changes.
    const held = await beat(monitor.id, null, {
      ok: false,
      msg: 'checker offline',
      checkerOffline: true,
    })
    expect(held.next).toMatchObject({ status: 'pending', important: false, notify: false })
    expect((await statesOf(monitor.id)).get(LOCAL_LOCATION)?.lastStatus).toBe('up')
    expect((await loadMonitor(monitor.id)).status?.lastStatus).toBe('pending')

    const down = await beat(monitor.id, berlin, fail('boom'))
    expect(down.next).toMatchObject({ status: 'down', important: true, notificationEvent: 'down' })
    expect(down.next.msg).toBe('Down at 1 of 2 locations: Berlin (boom)')
  })

  it('leaves single-location monitors on the plain state machine', async () => {
    const monitor = await createMonitor({ name: 'single', locations: [berlin.id] })
    const beat = beatAt(Date.now() - 60_000)
    await beat(monitor.id, berlin, UP)
    const down = await beat(monitor.id, berlin, fail('boom'))
    expect(down.next).toMatchObject({ status: 'down', important: true, msg: 'boom' })
    expect(down.locationNext).toBeUndefined()
    expect(down.heartbeat.locationStatus ?? null).toBeNull()
    expect((await statesOf(monitor.id)).size).toBe(0)
  })
})

describe('probe ingest on a multi-location monitor', () => {
  it('judges duplicates per location and answers with the location’s cadence', async () => {
    const monitor = await createMonitor({
      name: 'ingest multi',
      locations: [berlin.id],
      includeLocal: true,
      maxRetries: 2,
    })
    const now = new Date()
    // A local check later than the probe's result: on a single location that would be a duplicate.
    await recordBeat(payload, await loadMonitor(monitor.id), UP, {
      now: new Date(now.getTime() - 1_000),
      queue: fakeQueue().queue,
    })
    const time = new Date(now.getTime() - 5_000).toISOString()
    const result = { monitorId: monitor.id, time, ok: false, msg: 'refused' }
    const first = await ingestProbeResults(payload, berlin, [result], { now, pipeline: false })
    expect(first.results[0]).toMatchObject({
      accepted: true,
      status: 'pending',
      nextCheckSeconds: 20,
    })
    const again = await ingestProbeResults(payload, berlin, [result], { now, pipeline: false })
    expect(again.results[0]).toMatchObject({ accepted: false, reason: 'duplicate' })
  })
})

describe('per-location stats and the location filter', () => {
  it('records a separate series per location and filters heartbeats by location', async () => {
    const monitor = await createMonitor({
      name: 'stats multi',
      locations: [berlin.id, paris.id],
    })
    const listener = createStatsListener(payload)
    unsubscribe.push(registerHeartbeatListener((event) => listener(event)))
    const beat = beatAt(Date.now() - 60_000)
    await beat(monitor.id, berlin, UP)
    await beat(monitor.id, paris, fail('down'))
    await beat(monitor.id, berlin, { ok: true, msg: 'OK', ping: 58 })

    const stats = await getLocationStats(payload, monitor.id, '24h')
    expect(stats.get(String(berlin.id))).toMatchObject({ uptime: 1, avgPing: 50 })
    expect(stats.get(String(paris.id))).toMatchObject({ uptime: 0, avgPing: null })

    const { docs } = await payload.find({
      collection: 'heartbeats',
      where: {
        and: [{ monitor: { equals: monitor.id } }, heartbeatLocationWhere(String(paris.id))],
      },
      depth: 0,
      overrideAccess: true,
    })
    expect((docs as Heartbeat[]).map((doc) => doc.locationStatus)).toEqual(['down'])

    const single = await createMonitor({ name: 'filter local' })
    await beatAt(Date.now() - 60_000)(single.id, null, UP)
    const local = await payload.find({
      collection: 'heartbeats',
      where: { and: [{ monitor: { equals: single.id } }, heartbeatLocationWhere(LOCAL_LOCATION)] },
      depth: 0,
      overrideAccess: true,
    })
    expect(local.totalDocs).toBe(1)
  })
})

describe('per-location read access', () => {
  it('lets only members with monitor:read read the location states and stats', async () => {
    const monitor = await createMonitor({
      name: 'access multi',
      locations: [berlin.id, paris.id],
    })
    const listener = createStatsListener(payload)
    unsubscribe.push(registerHeartbeatListener((event) => listener(event)))
    const beat = beatAt(Date.now() - 60_000)
    await beat(monitor.id, berlin, UP)
    await beat(monitor.id, paris, UP)

    const other = await payload.create({
      collection: 'organizations',
      data: { name: 'Quorum other org', slug: `quorum-other-${run}` },
    })
    const users: User[] = []
    const userIn = async (name: string, orgId: string | number) => {
      const created = await payload.create({
        collection: 'users',
        data: { email: `${name}+quorum-${run}@marmot.test`, password: 'password-123', name },
      })
      users.push(created)
      await addOrgMembership({ payload, userId: created.id, orgId, role: 'viewer' })
      const fresh = await payload.findByID({ collection: 'users', id: created.id, depth: 0 })
      return { ...fresh, collection: 'users' as const }
    }
    try {
      const member = await userIn('member', org.id)
      const outsider = await userIn('outsider', other.id)
      for (const collection of ['monitor-location-states', 'stat-location-hourly'] as const) {
        const readAs = (user: typeof member) =>
          payload.find({
            collection,
            where: { monitor: { equals: monitor.id } },
            depth: 0,
            user,
            overrideAccess: false,
          })
        expect((await readAs(member)).totalDocs).toBeGreaterThanOrEqual(2)
        expect((await readAs(outsider)).totalDocs).toBe(0)
        await expect(
          payload.create({
            collection,
            data: { organization: org.id, monitor: monitor.id } as never,
            user: member,
            overrideAccess: false,
          }),
        ).rejects.toThrow()
      }
    } finally {
      for (const user of users) await payload.delete({ collection: 'users', id: user.id })
      await payload.delete({ collection: 'organizations', id: other.id })
    }
  })
})

describe('quorum recompute job', () => {
  it('repairs a drifted status, notifies, and prunes states of unassigned locations', async () => {
    const monitor = await createMonitor({
      name: 'recompute',
      locations: [berlin.id, paris.id],
      includeLocal: true,
    })
    const beat = beatAt(Date.now() - 120_000)
    await beat(monitor.id, berlin, UP)
    await beat(monitor.id, paris, UP)
    await beat(monitor.id, null, UP)

    // Two locations went down behind the monitor's back (a lost race), and a stale row lingers.
    const states = await statesOf(monitor.id)
    for (const key of [String(berlin.id), String(paris.id)]) {
      await payload.update({
        collection: 'monitor-location-states',
        id: states.get(key)!.id,
        data: { lastStatus: 'down', lastMsg: 'timeout' },
        overrideAccess: true,
      })
    }
    await payload.create({
      collection: 'monitor-location-states',
      data: {
        organization: org.id,
        monitor: monitor.id,
        locationKey: 'gone',
        lastStatus: 'down',
      } as never,
      overrideAccess: true,
    })
    events.length = 0

    const result = await recomputeQuorumStatuses(payload)
    expect(result.repaired).toContainEqual({
      monitorId: String(monitor.id),
      from: 'up',
      to: 'down',
    })
    expect(result.pruned).toBeGreaterThanOrEqual(1)
    expect((await statesOf(monitor.id)).has('gone')).toBe(false)

    const updated = await loadMonitor(monitor.id)
    expect(updated.status?.lastStatus).toBe('down')
    const repair = events.find((event) => String(event.monitor.id) === String(monitor.id))
    expect(repair).toMatchObject({ repair: true, notify: true, notificationEvent: 'down' })
    expect(repair?.heartbeat).toMatchObject({ trigger: 'quorum', important: true, status: 'down' })
    expect(repair?.heartbeat.msg).toBe(
      'Down at 2 of 3 locations: Berlin (timeout), Paris (timeout)',
    )

    // Nothing left to repair.
    const again = await recomputeQuorumStatuses(payload)
    expect(again.repaired.find((r) => r.monitorId === String(monitor.id))).toBeUndefined()
  })
})
