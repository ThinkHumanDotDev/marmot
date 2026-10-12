/**
 * Group aggregation modes (#144) through the real check path: the group check reads its children's
 * cached status, aggregates it with the group's `aggregation` setting and records the beat
 * (retries, status cache) like any other monitor.
 */
import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { monitorFormSchema } from '@/lib/validation/monitor-schema'
import { defaultMonitorValues } from '@/lib/validation/monitor'
import type { Monitor, Organization } from '@/payload-types'
import { processCheckJob, type ChecksQueue } from '@/server/engine'

let payload: Payload
let org: Organization

const run = Date.now().toString(36)

const fakeQueue = () =>
  ({
    upsertJobScheduler: vi.fn(async () => undefined),
    removeJobScheduler: vi.fn(async () => true),
  }) as unknown as ChecksQueue

async function createMonitor(data: Partial<Monitor> & { name: string }): Promise<Monitor> {
  return (await payload.create({
    collection: 'monitors',
    overrideAccess: true,
    depth: 0,
    context: { skipEngineSync: true },
    data: {
      organization: org.id,
      type: 'manual',
      manualStatus: 'up',
      interval: 60,
      retryInterval: 20,
      maxRetries: 0,
      ...data,
    } as RequiredDataFromCollectionSlug<'monitors'>,
  })) as Monitor
}

/** Sets a child's cached status, as the worker would after its last beat. */
async function setStatus(child: Monitor, lastStatus: 'up' | 'down' | 'degraded', lastPing = 100) {
  await payload.update({
    collection: 'monitors',
    id: child.id,
    overrideAccess: true,
    context: { skipEngineSync: true },
    data: { status: { lastStatus, lastPing } },
  })
}

const check = async (group: Monitor) =>
  (
    await processCheckJob(
      payload,
      { data: { monitorId: String(group.id) } },
      { queue: fakeQueue() },
    )
  ).heartbeat

/** A group of `n` replicas (`api-1` … `api-n`), all UP. */
async function replicaGroup(name: string, n: number, data: Partial<Monitor> = {}) {
  const group = await createMonitor({ name, type: 'group', manualStatus: null, ...data })
  const children: Monitor[] = []
  for (let i = 1; i <= n; i++) {
    const child = await createMonitor({ name: `api-${i}`, parent: group.id })
    await setStatus(child, 'up', 10 * i)
    children.push(child)
  }
  return { group, children }
}

beforeAll(async () => {
  payload = await getPayload({ config })
  org = await payload.create({
    collection: 'organizations',
    data: { name: 'Group Aggregation Org', slug: `group-agg-${run}` },
  })
})

afterAll(async () => {
  if (!org?.id) return
  // One by one, children first: the monitors' `beforeDelete` hook removes their heartbeats and
  // stats and detaches the children of a group.
  const { docs } = await payload.find({
    collection: 'monitors',
    where: { organization: { equals: org.id } },
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
  })
  const ordered = [...docs].sort((a, b) => Number(Boolean(b.parent)) - Number(Boolean(a.parent)))
  for (const doc of ordered) {
    await payload.delete({ collection: 'monitors', id: doc.id, overrideAccess: true })
  }
  await payload.delete({ collection: 'organizations', id: org.id, overrideAccess: true })
})

describe('group aggregation', () => {
  it('existing groups keep the worst-child behaviour by default', async () => {
    const { group, children } = await replicaGroup('legacy', 3)
    expect(group.aggregation).toBe('worst')
    expect(group.aggregationLatency).toBe('none')
    expect(children[0].groupWeight).toBe(1)

    await setStatus(children[1], 'down')
    const beat = await check(group)
    expect(beat).toMatchObject({ status: 'down', msg: 'Child monitors down: api-2' })

    // Documents written before #144 have no aggregation fields at all (MongoDB) or the column
    // defaults (Postgres); both read as worst.
    expect(monitorFormSchema.parse({ ...defaultMonitorValues('group'), name: 'g' })).toMatchObject({
      aggregation: 'worst',
      aggregationLatency: 'none',
      groupWeight: 1,
    })
  })

  it('a quorum group of 5 with min 3 stays up with 2 children down and goes DOWN with 3', async () => {
    const { group, children } = await replicaGroup('replicas', 5, {
      aggregation: 'quorum',
      aggregationQuorum: 3,
      aggregationQuorumUnit: 'count',
    })
    expect((await check(group))?.status).toBe('up')

    await setStatus(children[2], 'down')
    await setStatus(children[4], 'down')
    const two = await check(group)
    expect(two).toMatchObject({
      status: 'degraded',
      msg: '3/5 children up (quorum 3); 2/5 children down: api-3, api-5',
    })

    await setStatus(children[0], 'down')
    const three = await check(group)
    expect(three).toMatchObject({
      status: 'down',
      msg: '2/5 children up (quorum 3); 3/5 children down: api-1, api-3, api-5',
    })
    const cached = await payload.findByID({
      collection: 'monitors',
      id: group.id,
      depth: 0,
      overrideAccess: true,
    })
    expect(cached.status?.lastStatus).toBe('down')
  })

  it('weighted groups score their children by weight', async () => {
    const { group, children } = await replicaGroup('weighted', 2, { aggregation: 'weighted' })
    await payload.update({
      collection: 'monitors',
      id: children[0].id,
      overrideAccess: true,
      context: { skipEngineSync: true },
      data: { groupWeight: 3 },
    })
    await setStatus(children[1], 'down')
    expect(await check(group)).toMatchObject({
      status: 'degraded',
      msg: 'Score 75%; 1/2 children down: api-2',
    })
    await setStatus(children[0], 'down')
    expect((await check(group))?.status).toBe('down')
  })

  it('derives the group ping from the children', async () => {
    const { group } = await replicaGroup('latency', 3, { aggregationLatency: 'max' })
    expect(await check(group)).toMatchObject({ status: 'up', ping: 30 })
  })

  it('validates the quorum of quorum groups', () => {
    const base = { ...defaultMonitorValues('group'), name: 'g', aggregation: 'quorum' }
    expect(monitorFormSchema.safeParse(base).success).toBe(false)
    expect(monitorFormSchema.safeParse({ ...base, aggregationQuorum: 2 }).success).toBe(true)
    expect(
      monitorFormSchema.safeParse({
        ...base,
        aggregationQuorum: 150,
        aggregationQuorumUnit: 'percent',
      }).success,
    ).toBe(false)
  })
})
