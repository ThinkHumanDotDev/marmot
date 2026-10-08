import { getPayload, type CollectionSlug, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { deleteInBatches } from '@/db/delete-in-batches'
import {
  runRetention,
  SUBSCRIBER_DELIVERY_KEEP_DAYS,
  type RetentionResult,
} from '@/server/jobs/retention'
import { getDailyKey, getHourlyKey, getMinutelyKey } from '@/server/stats/uptime-calculator'

type Id = string | number

let payload: Payload
let organizationId: Id
let monitorId: Id
let statusPageId: Id
let notificationId: Id
let endpointId: Id

const run = Date.now().toString(36)
const NOW = new Date()
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000)
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000)

const MONITOR_DEFAULTS = {
  type: 'manual' as const,
  active: false,
  interval: 60,
  retryInterval: 60,
  maxRetries: 0,
  resendInterval: 0,
  timeout: 48,
}

/** Smaller than every seeded set below, so each collection needs several batches. */
const BATCH = 2
/** Expired rows seeded per collection: two full batches plus a partial one. */
const EXPIRED = 5

/** Sets `createdAt` without hooks (Payload always stamps it on create). */
async function backdate(collection: CollectionSlug, ids: Id[], createdAt: Date) {
  for (const id of ids) {
    await payload.db.updateOne({ collection, id, data: { createdAt: createdAt.toISOString() } })
  }
}

async function remaining(collection: CollectionSlug, ids: Id[]): Promise<string[]> {
  const { docs } = await payload.find({
    collection,
    where: { id: { in: ids } },
    limit: 0,
    depth: 0,
    overrideAccess: true,
  })
  return docs.map((doc) => String(doc.id))
}

async function times<T>(n: number, make: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < n; i++) out.push(await make(i))
  return out
}

async function createHeartbeats(
  monitor: Id,
  count: number,
  time: (i: number) => Date,
  important = false,
) {
  const docs = await times(count, (i) =>
    payload.create({
      collection: 'heartbeats',
      data: {
        monitor: monitor as never,
        organization: organizationId as never,
        status: 'up',
        important,
        downCount: 0,
        time: time(i).toISOString(),
      },
      depth: 0,
    }),
  )
  return docs.map((doc) => doc.id)
}

async function createStats(
  collection: 'stat-minutely' | 'stat-hourly' | 'stat-daily',
  timestamps: number[],
) {
  const docs = await times(timestamps.length, (i) =>
    payload.create({
      collection,
      data: {
        monitor: monitorId as never,
        organization: organizationId as never,
        timestamp: timestamps[i]!,
        up: 1,
        down: 0,
      },
      depth: 0,
    }),
  )
  return docs.map((doc) => doc.id)
}

async function createSubscribers(count: number, prefix: string) {
  const docs = await times(count, (i) =>
    payload.create({
      collection: 'status-page-subscribers',
      data: {
        organization: organizationId as never,
        statusPage: statusPageId as never,
        channel: 'email',
        target: `${prefix}-${i}-${run}@retention.test`,
        source: 'self_signup',
      },
      depth: 0,
    }),
  )
  return docs.map((doc) => doc.id)
}

async function createSubscriberDeliveries(subscribers: Id[]) {
  const docs = await times(subscribers.length, (i) =>
    payload.create({
      collection: 'subscriber-deliveries',
      data: {
        organization: organizationId as never,
        notification: notificationId as never,
        subscriber: subscribers[i] as never,
        channel: 'email',
        state: 'sent',
      },
      depth: 0,
    }),
  )
  return docs.map((doc) => doc.id)
}

async function createWebhookDeliveries(count: number) {
  const docs = await times(count, (i) =>
    payload.create({
      collection: 'webhook-deliveries',
      data: {
        organization: organizationId as never,
        endpoint: endpointId as never,
        eventId: `evt_${run}_${i}`,
        eventType: 'monitor.down',
        trigger: 'event',
        state: 'succeeded',
        attempts: 1,
        body: { id: `evt_${run}_${i}` },
      },
      depth: 0,
    }),
  )
  return docs.map((doc) => doc.id)
}

async function createAuditLogs(count: number) {
  const docs = await times(count, (i) =>
    payload.create({
      collection: 'audit-logs',
      data: { action: 'auth.login', ip: `retention-${run}-${i}` },
      depth: 0,
    }),
  )
  return docs.map((doc) => doc.id)
}

beforeAll(async () => {
  payload = await getPayload({ config })
  const org = await payload.create({
    collection: 'organizations',
    data: { name: 'retention-int-org', slug: `retention-int-org-${run}` },
  })
  organizationId = org.id
  const monitor = await payload.create({
    collection: 'monitors',
    data: { ...MONITOR_DEFAULTS, organization: organizationId as never, name: 'retention-int' },
  })
  monitorId = monitor.id
  const page = await payload.create({
    collection: 'status-pages',
    data: {
      organization: organizationId as never,
      title: 'Retention',
      slug: `retention-${run}`,
    },
    depth: 0,
  })
  statusPageId = page.id
  const notification = await payload.create({
    collection: 'subscriber-notifications',
    data: {
      organization: organizationId as never,
      statusPage: statusPageId as never,
      dedupeKey: `retention-${run}`,
      event: 'incident_opened',
      state: 'sent',
      title: 'Retention',
      eventPublicId: `retention-${run}`,
      occurredAt: NOW.toISOString(),
    },
    depth: 0,
  })
  notificationId = notification.id
  const endpoint = await payload.create({
    collection: 'webhook-endpoints',
    data: {
      organization: organizationId as never,
      url: 'https://example.com/marmot-retention',
      events: ['monitor.down'],
    },
    depth: 0,
  })
  endpointId = endpoint.id
})

afterAll(async () => {
  await deleteInBatches(payload, 'heartbeats', { monitor: { equals: monitorId } })
  for (const collection of ['stat-minutely', 'stat-hourly', 'stat-daily'] as const) {
    await deleteInBatches(payload, collection, { monitor: { equals: monitorId } })
  }
  await deleteInBatches(payload, 'webhook-deliveries', { endpoint: { equals: endpointId } })
  await deleteInBatches(payload, 'audit-logs', { ip: { like: `retention-${run}` } })
  await deleteInBatches(
    payload,
    'status-page-subscribers',
    { statusPage: { equals: statusPageId } },
    { hooks: true },
  )
  await payload.delete({ collection: 'webhook-endpoints', id: endpointId })
  await payload.delete({ collection: 'subscriber-notifications', id: notificationId })
  await payload.delete({ collection: 'status-pages', id: statusPageId })
  await payload.delete({ collection: 'monitors', id: monitorId })
  await payload.delete({ collection: 'organizations', id: organizationId })
})

describe('deleteInBatches', () => {
  it.each([
    { rows: 0, batchSize: 3 },
    { rows: 2, batchSize: 3 },
    { rows: 6, batchSize: 3 },
    { rows: 7, batchSize: 3 },
  ])('deletes $rows matching rows in batches of $batchSize', async ({ rows, batchSize }) => {
    const other = await payload.create({
      collection: 'monitors',
      data: { ...MONITOR_DEFAULTS, organization: organizationId as never, name: 'retention-batch' },
    })
    try {
      const doomed = await createHeartbeats(other.id, rows, (i) => daysAgo(2 + i))
      const kept = await createHeartbeats(other.id, 2, () => NOW)

      const deleted = await deleteInBatches(
        payload,
        'heartbeats',
        {
          and: [
            { monitor: { equals: other.id } },
            { time: { less_than: hoursAgo(1).toISOString() } },
          ],
        },
        { batchSize },
      )

      expect(deleted).toBe(rows)
      expect(await remaining('heartbeats', doomed)).toEqual([])
      expect((await remaining('heartbeats', kept)).sort()).toEqual(kept.map(String).sort())
    } finally {
      await deleteInBatches(payload, 'heartbeats', { monitor: { equals: other.id } })
      await payload.delete({ collection: 'monitors', id: other.id })
    }
  })

  it('runs collection hooks with `hooks: true`', async () => {
    const subscribers = await createSubscribers(3, 'hooks')
    const deliveries = await createSubscriberDeliveries(subscribers)

    const deleted = await deleteInBatches(
      payload,
      'status-page-subscribers',
      { id: { in: subscribers } },
      { batchSize: 2, hooks: true },
    )

    expect(deleted).toBe(3)
    expect(await remaining('status-page-subscribers', subscribers)).toEqual([])
    // The subscribers' `beforeDelete` hook removed their delivery rows.
    expect(await remaining('subscriber-deliveries', deliveries)).toEqual([])
  })

  it('rejects a batch size below 1', async () => {
    await expect(deleteInBatches(payload, 'heartbeats', {}, { batchSize: 0 })).rejects.toThrow(
      /batchSize/,
    )
  })
})

describe('runRetention in batches', () => {
  it('prunes more expired rows than one batch in every collection and keeps the rest', async () => {
    const expired = {
      minutely: await createStats(
        'stat-minutely',
        Array.from({ length: EXPIRED }, (_, i) => getMinutelyKey(hoursAgo(25 + i))),
      ),
      hourly: await createStats(
        'stat-hourly',
        Array.from({ length: EXPIRED }, (_, i) => getHourlyKey(daysAgo(31 + i))),
      ),
      daily: await createStats(
        'stat-daily',
        Array.from({ length: EXPIRED }, (_, i) => getDailyKey(daysAgo(400 + i))),
      ),
      heartbeats: await createHeartbeats(monitorId, EXPIRED, (i) => hoursAgo(25 + i)),
      importantHeartbeats: await createHeartbeats(
        monitorId,
        EXPIRED,
        (i) => daysAgo(400 + i),
        true,
      ),
      auditLogs: await createAuditLogs(EXPIRED),
      webhookDeliveries: await createWebhookDeliveries(EXPIRED),
      unconfirmedSubscribers: await createSubscribers(EXPIRED, 'stale'),
    }
    const staleDeliveries = await createSubscriberDeliveries(expired.unconfirmedSubscribers)
    const recent = await createSubscribers(EXPIRED, 'recent')
    const oldDeliveries = await createSubscriberDeliveries(recent)

    await backdate('audit-logs', expired.auditLogs, daysAgo(30))
    await backdate('webhook-deliveries', expired.webhookDeliveries, daysAgo(30))
    await backdate('status-page-subscribers', expired.unconfirmedSubscribers, daysAgo(4))
    await backdate(
      'subscriber-deliveries',
      oldDeliveries,
      daysAgo(SUBSCRIBER_DELIVERY_KEEP_DAYS + 1),
    )

    const fresh = {
      minutely: await createStats('stat-minutely', [getMinutelyKey(hoursAgo(1))]),
      hourly: await createStats('stat-hourly', [getHourlyKey(daysAgo(1))]),
      daily: await createStats('stat-daily', [getDailyKey(daysAgo(10))]),
      heartbeats: await createHeartbeats(monitorId, 1, () => hoursAgo(1)),
      importantHeartbeats: await createHeartbeats(monitorId, 1, () => daysAgo(10), true),
      auditLogs: await createAuditLogs(1),
      webhookDeliveries: await createWebhookDeliveries(1),
    }

    const find = vi.spyOn(payload, 'find')
    const remove = vi.spyOn(payload, 'delete')
    const removeMany = vi.spyOn(payload.db, 'deleteMany')
    let result: RetentionResult
    try {
      result = await runRetention(payload, NOW, {
        keepDataPeriodDays: 180,
        auditLogRetentionDays: 14,
        webhookDeliveryRetentionDays: 14,
        batchSize: BATCH,
      })
      // Bounded: ids are fetched one batch at a time and every delete names at most one batch.
      // (The subscribers' `beforeDelete` cascade to their deliveries is not counted.)
      const pruned = find.mock.calls.filter(([args]) => args.limit === BATCH)
      expect(pruned.length).toBeGreaterThan(9)
      const batchDeletes = [
        // Payload's own bookkeeping (document locks, preferences) is not part of the job.
        ...removeMany.mock.calls
          .filter(([args]) => !args.collection.startsWith('payload-'))
          .map(([args]) => args.where),
        ...remove.mock.calls
          .filter(([args]) => args.collection !== 'subscriber-deliveries')
          .map(([args]) => ('where' in args ? args.where : undefined)),
      ]
      expect(batchDeletes.length).toBeGreaterThan(9)
      for (const where of batchDeletes) {
        const ids = (where?.id as { in?: unknown[] } | undefined)?.in
        expect(
          Array.isArray(ids) && ids.length > 0 && ids.length <= BATCH,
          JSON.stringify(where),
        ).toBe(true)
      }
    } finally {
      find.mockRestore()
      remove.mockRestore()
      removeMany.mockRestore()
    }

    // The job prunes the whole database: rows of other test files may be counted as well.
    expect(result.minutely).toBeGreaterThanOrEqual(EXPIRED)
    expect(result.hourly).toBeGreaterThanOrEqual(EXPIRED)
    expect(result.daily).toBeGreaterThanOrEqual(EXPIRED)
    expect(result.heartbeats).toBeGreaterThanOrEqual(EXPIRED)
    expect(result.importantHeartbeats).toBeGreaterThanOrEqual(EXPIRED)
    expect(result.auditLogs).toBeGreaterThanOrEqual(EXPIRED)
    expect(result.webhookDeliveries).toBeGreaterThanOrEqual(EXPIRED)
    expect(result.unconfirmedSubscribers).toBeGreaterThanOrEqual(EXPIRED)
    expect(result.subscriberDeliveries).toBeGreaterThanOrEqual(EXPIRED)

    const slugs: Record<keyof typeof expired, CollectionSlug> = {
      minutely: 'stat-minutely',
      hourly: 'stat-hourly',
      daily: 'stat-daily',
      heartbeats: 'heartbeats',
      importantHeartbeats: 'heartbeats',
      auditLogs: 'audit-logs',
      webhookDeliveries: 'webhook-deliveries',
      unconfirmedSubscribers: 'status-page-subscribers',
    }
    for (const [key, ids] of Object.entries(expired) as [keyof typeof expired, Id[]][]) {
      expect(await remaining(slugs[key], ids), key).toEqual([])
    }
    for (const [key, ids] of Object.entries(fresh) as [keyof typeof fresh, Id[]][]) {
      expect(await remaining(slugs[key], ids), key).toEqual(ids.map(String))
    }
    expect(await remaining('subscriber-deliveries', oldDeliveries)).toEqual([])
    // Removed by the unconfirmed subscribers' `beforeDelete` hook.
    expect(await remaining('subscriber-deliveries', staleDeliveries)).toEqual([])
    // Unconfirmed sign-ups younger than the TTL stay (only their old delivery rows went).
    expect((await remaining('status-page-subscribers', recent)).sort()).toEqual(
      recent.map(String).sort(),
    )

    // Nothing left to prune.
    const again = await runRetention(payload, NOW, {
      keepDataPeriodDays: 180,
      auditLogRetentionDays: 14,
      webhookDeliveryRetentionDays: 14,
      batchSize: BATCH,
    })
    expect(again).toEqual({
      minutely: 0,
      hourly: 0,
      daily: 0,
      heartbeats: 0,
      importantHeartbeats: 0,
      auditLogs: 0,
      unconfirmedSubscribers: 0,
      subscriberDeliveries: 0,
      webhookDeliveries: 0,
    })
  })
})
