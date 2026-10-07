import { getPayload, type Payload } from 'payload'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import { POST as acknowledgeRoute } from '@/app/api/orgs/[orgId]/monitor-incidents/[id]/acknowledge/route'
import { POST as createMonitorRoute } from '@/app/api/orgs/[orgId]/monitors/route'
import { env } from '@/env'
import type {
  Heartbeat,
  Monitor,
  MonitorIncident,
  Notification,
  Organization,
} from '@/payload-types'
import { clearHeartbeatListeners, type ChecksQueue } from '@/server/engine'
import { recordBeat } from '@/server/engine/worker'
import { registerIncidentListener, setIncidentJobSink, setReminderPolicy } from '@/server/incidents'
import {
  clearNotificationGates,
  registerNotificationListener,
  type NotificationsQueue,
} from '@/server/notifications'
import { closeEmitter } from '@/server/realtime/emitter'

/**
 * Alert flapping (#147): the recovery threshold keeps a flapping service to one DOWN and one UP
 * notification and one incident, and the reminder backoff spaces resend-interval reminders
 * (exponential 1×, 2×, 4× …), caps them at `maxReminders` and stops them on acknowledgement. Runs
 * the real state machine, the incident listener and the notification listener (queue stubbed).
 */

let payload: Payload
const run = Date.now().toString(36)

const queue = {
  upsertJobScheduler: vi.fn(async () => undefined),
  removeJobScheduler: vi.fn(async () => true),
} as unknown as ChecksQueue

/** Notification jobs the dispatcher would enqueue (one per channel per notifying beat). */
const enqueued: string[] = []
const notificationsQueue = {
  getJob: vi.fn(async () => null),
  addBulk: vi.fn(async (jobs: { opts: { jobId: string } }[]) => {
    for (const job of jobs) enqueued.push(job.opts.jobId)
    return []
  }),
} as unknown as NotificationsQueue

let org: Organization
let channel: Notification
let cookie: string
let unhook: () => void
let unhookNotifications: () => void

const t0 = new Date(Date.now() - 24 * 60 * 60_000)
const minute = (n: number) => new Date(t0.getTime() + n * 60_000)

async function createMonitor(name: string, extra: Partial<Monitor> = {}): Promise<Monitor> {
  return (await payload.create({
    collection: 'monitors',
    depth: 0,
    overrideAccess: true,
    data: {
      organization: org.id,
      name,
      type: 'http',
      url: 'https://example.com',
      active: true,
      interval: 60,
      retryInterval: 20,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 48,
      notifications: [channel.id],
      ...extra,
    } as never,
  })) as Monitor
}

async function beat(monitor: Monitor, ok: boolean, at: Date, msg = ok ? 'OK' : 'HTTP 503') {
  const result = await recordBeat(
    payload,
    monitor,
    ok ? { ok: true, status: 'up', msg, ping: 12 } : { ok: false, msg },
    { queue, now: at },
  )
  return result
}

const incidentsOf = async (monitor: Monitor) =>
  (
    await payload.find({
      collection: 'monitor-incidents',
      where: { monitor: { equals: monitor.id } },
      sort: 'startedAt',
      depth: 0,
      overrideAccess: true,
    })
  ).docs as MonitorIncident[]

beforeAll(async () => {
  payload = await getPayload({ config })
  org = await payload.create({
    collection: 'organizations',
    data: { name: 'Flappy Co', slug: `flappy-co-${run}` },
  })
  const user = await payload.create({
    collection: 'users',
    data: { email: `owner+flap-${run}@marmot.test`, password: 'password-123', name: 'Ada' },
  })
  await addOrgMembership({ payload, userId: user.id, orgId: org.id, role: 'owner' })
  const { token } = await payload.login({
    collection: 'users',
    data: { email: `owner+flap-${run}@marmot.test`, password: 'password-123' },
  })
  cookie = `payload-token=${token}`
  channel = (await payload.create({
    collection: 'notifications',
    depth: 0,
    overrideAccess: true,
    data: {
      organization: org.id,
      name: 'hook',
      type: 'webhook',
      config: { url: 'https://example.com/hook' },
      active: true,
    } as never,
  })) as Notification

  clearHeartbeatListeners()
  clearNotificationGates()
  unhook = registerIncidentListener(payload)
  unhookNotifications = registerNotificationListener(payload, { queue: notificationsQueue })
  setIncidentJobSink(async () => undefined)
})

beforeEach(() => {
  enqueued.length = 0
})

afterEach(() => {
  setReminderPolicy(null)
})

afterAll(async () => {
  unhook?.()
  unhookNotifications?.()
  setIncidentJobSink(null)
  await closeEmitter()
  if (org) {
    await payload.delete({ collection: 'monitors', where: { organization: { equals: org.id } } })
    await payload.delete({
      collection: 'notifications',
      where: { organization: { equals: org.id } },
    })
    await payload.delete({ collection: 'organizations', where: { id: { equals: org.id } } })
  }
  await payload.delete({ collection: 'users', where: { email: { like: `+flap-${run}@` } } })
})

describe('recovery threshold', () => {
  it('a flapping service sends one DOWN and one UP and keeps one incident', async () => {
    let monitor = await createMonitor('Flappy API', { successThreshold: 3, maxRetries: 1 })
    const pattern = [true, false, false, true, false, true, true, false, true, true, true, true]
    const statuses: string[] = []
    const notified: string[] = []
    for (const [i, ok] of pattern.entries()) {
      const before = enqueued.length
      const result = await beat(monitor, ok, minute(i))
      monitor = result.monitor
      statuses.push(result.next.status)
      if (enqueued.length > before) notified.push(result.next.status)
    }

    expect(statuses).toEqual([
      'up',
      'pending', // retry
      'down', // confirmed
      'pending', // recovering 1/3
      'down', // flap: straight back, silently
      'pending', // 1/3
      'pending', // 2/3
      'down',
      'pending',
      'pending',
      'up', // 3/3
      'up',
    ])
    expect(notified).toEqual(['down', 'up'])

    const incidents = await incidentsOf(monitor)
    expect(incidents).toHaveLength(1)
    expect(incidents[0]).toMatchObject({ status: 'resolved', autoResolved: true })
    expect(Date.parse(incidents[0].startedAt)).toBe(minute(2).getTime())
    expect(Date.parse(incidents[0].resolvedAt!)).toBe(minute(10).getTime())
  })

  it('labels recovering beats and stores the streak in the status cache', async () => {
    let monitor = await createMonitor('Labelled', { successThreshold: 2 })
    monitor = (await beat(monitor, false, minute(0))).monitor
    const { monitor: after, heartbeat } = await beat(monitor, true, minute(1), '200 - OK')
    expect(heartbeat).toMatchObject<Partial<Heartbeat>>({
      status: 'pending',
      msg: 'Recovering 1/2: 200 - OK',
      important: false,
    })
    expect(after.status).toMatchObject({ lastStatus: 'pending', recoveries: 1 })
    // Recovering beats poll at the retry interval, like retries.
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      `monitor:${monitor.id}`,
      expect.objectContaining({ every: 20_000 }),
      expect.anything(),
    )

    const done = await beat(after, true, minute(2))
    expect(done.heartbeat).toMatchObject({ status: 'up', important: true })
    expect(done.monitor.status).toMatchObject({ lastStatus: 'up', recoveries: 0 })
  })

  it('defaults keep one success enough (Uptime Kuma behaviour)', async () => {
    let monitor = await createMonitor('Default')
    expect(monitor.successThreshold).toBe(1)
    monitor = (await beat(monitor, false, minute(0))).monitor
    const result = await beat(monitor, true, minute(1))
    expect(result.next).toMatchObject({ status: 'up', notify: true })
    expect(enqueued).toHaveLength(2)
  })
})

describe('reminder backoff', () => {
  it('exponential reminders go out at 1×, 2×, 4× the base interval and stop at maxReminders', async () => {
    let monitor = await createMonitor('Backoff', {
      resendInterval: 1,
      reminderBackoff: 'exponential',
      maxReminders: 3,
    })
    const remindedAt: number[] = []
    for (let i = 0; i <= 20; i++) {
      const before = enqueued.length
      monitor = (await beat(monitor, false, minute(i))).monitor
      if (i > 0 && enqueued.length > before) remindedAt.push(i)
    }
    // Base interval = resendInterval (1) × interval (60 s): ticks every minute.
    expect(remindedAt).toEqual([1, 3, 7])
    const [incident] = await incidentsOf(monitor)
    expect(incident).toMatchObject({ status: 'open', remindersSent: 3 })
    expect(Date.parse(incident.lastReminderAt!)).toBe(minute(7).getTime())
  })

  it('linear reminders stop on acknowledgement', async () => {
    let monitor = await createMonitor('Linear', { resendInterval: 2, reminderBackoff: 'linear' })
    const remindedAt: number[] = []
    const beatAt = async (i: number) => {
      const before = enqueued.length
      monitor = (await beat(monitor, false, minute(i))).monitor
      if (i > 0 && enqueued.length > before) remindedAt.push(i)
    }
    // Ticks every 2 beats (2 minutes): reminders at ticks 1 and 3 → minutes 2 and 6.
    for (let i = 0; i <= 7; i++) await beatAt(i)
    expect(remindedAt).toEqual([2, 6])

    const [incident] = await incidentsOf(monitor)
    const response = await acknowledgeRoute(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: {
          Origin: env.NEXT_PUBLIC_SERVER_URL,
          'content-type': 'application/json',
          cookie,
        },
        body: '{}',
      }),
      { params: Promise.resolve({ orgId: String(org.id), id: String(incident.id) }) },
    )
    expect(response.status).toBe(200)
    for (let i = 8; i <= 20; i++) await beatAt(i)
    expect(remindedAt).toEqual([2, 6])
  })

  it('the API accepts and validates the new settings', async () => {
    const post = (body: Record<string, unknown>) =>
      createMonitorRoute(
        new Request('http://localhost/x', {
          method: 'POST',
          headers: {
            Origin: env.NEXT_PUBLIC_SERVER_URL,
            'content-type': 'application/json',
            cookie,
          },
          body: JSON.stringify({
            name: `api-${Math.random().toString(36).slice(2)}`,
            type: 'http',
            url: 'https://example.com',
            interval: 60,
            retryInterval: 60,
            maxRetries: 0,
            resendInterval: 5,
            timeout: 48,
            ...body,
          }),
        }),
        { params: Promise.resolve({ orgId: String(org.id) }) },
      )

    const created = await post({ successThreshold: 3, reminderBackoff: 'linear', maxReminders: 4 })
    expect(created.status).toBe(201)
    const doc = (await created.json()) as Monitor
    expect(doc).toMatchObject({ successThreshold: 3, reminderBackoff: 'linear', maxReminders: 4 })

    expect((await post({ successThreshold: 0 })).status).toBe(400)
    expect((await post({ reminderBackoff: 'fibonacci' })).status).toBe(400)
  })
})
