/**
 * Per-channel event filters (#126): the `events` selection on notification channels decides which
 * heartbeat events, expiry warnings and maintenance windows reach a channel; recovery messages
 * carry the downtime; templates get `{{ event }}`; import/export keeps the selection.
 */
import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import { DEFAULT_CHANNEL_EVENTS, normalizeChannelEvents } from '@/lib/notification-events'
import type { Heartbeat, Monitor, Notification, Organization } from '@/payload-types'
import type { HeartbeatEvent } from '@/server/engine'
import { buildMarmotExport, parseMarmotExport } from '@/server/import-export/marmot'
import { processDomainExpiry } from '@/server/jobs/expiry-notifications'
import type { MaintenanceEvent } from '@/server/maintenance/events'
import { registerNotificationProvider } from '@/server/notification-providers'
import type { NotificationSendContext } from '@/server/notification-providers/types'
import {
  channelAcceptsEvent,
  enqueueMaintenanceNotifications,
  enqueueNotificationsForHeartbeat,
  processMaintenanceNotificationJob,
  processNotificationJob,
  renderMessageTemplate,
  type MaintenanceNotificationJobData,
  type NotificationsQueue,
} from '@/server/notifications'
import { pickInput } from '@/server/notifications/api'

let payload: Payload
let org: Organization

const run = Date.now().toString(36)

const captured: NotificationSendContext[] = []
const CAPTURE = `filters-capture-${run}`
registerNotificationProvider({
  name: CAPTURE,
  label: 'Capture',
  group: 'generic',
  configSchema: z.object({}),
  async send(ctx) {
    captured.push(ctx)
    return 'ok'
  },
})

/** Notifications queue stub: records the jobs the dispatcher would add. */
function fakeQueue() {
  const added: { name: string; data: Record<string, unknown>; opts: { jobId?: string } }[] = []
  const queue = {
    getJob: vi.fn(async () => undefined),
    addBulk: vi.fn(async (jobs: typeof added) => {
      added.push(...jobs)
      return []
    }),
  } as unknown as NotificationsQueue
  return { queue, added }
}

async function channel(
  name: string,
  data: Partial<Notification> = {},
  type = CAPTURE,
): Promise<Notification> {
  return (await payload.create({
    collection: 'notifications',
    overrideAccess: true,
    depth: 0,
    data: {
      organization: org.id,
      name: `${name}-${run}`,
      type,
      config: {},
      active: true,
      ...data,
    } as never,
  })) as Notification
}

async function createMonitor(data: Partial<Monitor> & { name: string }): Promise<Monitor> {
  return (await payload.create({
    collection: 'monitors',
    overrideAccess: true,
    depth: 0,
    context: { skipEngineSync: true, explicitNotifications: true },
    data: {
      organization: org.id,
      type: 'http',
      url: 'https://example.com/',
      interval: 60,
      ...data,
    } as RequiredDataFromCollectionSlug<'monitors'>,
  })) as Monitor
}

async function heartbeat(
  monitor: Monitor,
  status: Heartbeat['status'],
  time: Date,
  important = true,
  msg = '',
): Promise<Heartbeat> {
  return (await payload.create({
    collection: 'heartbeats',
    overrideAccess: true,
    depth: 0,
    data: {
      monitor: monitor.id,
      organization: org.id,
      status,
      important,
      msg,
      time: time.toISOString(),
    } as never,
  })) as Heartbeat
}

beforeAll(async () => {
  payload = await getPayload({ config })
  org = await payload.create({
    collection: 'organizations',
    data: { name: 'Event filters', slug: `event-filters-${run}` },
  })
})

afterEach(() => {
  captured.length = 0
  vi.unstubAllGlobals()
})

describe('channel selection', () => {
  it('defaults to the events channels received before, normalises and never stores an empty list', async () => {
    const plain = await channel('plain')
    expect(plain.events).toEqual(['down', 'up', 'reminder', 'certificate'])

    const chosen = await channel('chosen', { events: ['maintenance', 'down'] as never })
    expect(chosen.events).toEqual(['down', 'maintenance'])

    const cleared = (await payload.update({
      collection: 'notifications',
      id: chosen.id,
      overrideAccess: true,
      depth: 0,
      data: { events: [] },
    })) as Notification
    expect(cleared.events).toEqual([...DEFAULT_CHANNEL_EVENTS])

    // The REST body: unknown names are dropped.
    expect(pickInput({ events: ['up', 'paging', 'degraded'] }).events).toEqual(['up', 'degraded'])
    expect(pickInput({ name: 'x' })).not.toHaveProperty('events')
  })

  it('a channel without a selection (created before the field existed) behaves as before', () => {
    for (const legacy of [{ events: null }, { events: [] }, {}] as Pick<Notification, 'events'>[]) {
      expect(normalizeChannelEvents(legacy.events)).toEqual([...DEFAULT_CHANNEL_EVENTS])
      for (const event of ['down', 'up', 'reminder', 'certificate'] as const) {
        expect(channelAcceptsEvent(legacy, event)).toBe(true)
      }
      expect(channelAcceptsEvent(legacy, 'degraded')).toBe(false)
      expect(channelAcceptsEvent(legacy, 'maintenance')).toBe(false)
      expect(channelAcceptsEvent(legacy, null)).toBe(true)
    }
  })
})

describe('heartbeat notifications', () => {
  it('a down-only channel receives no recovery, reminder or degraded messages', async () => {
    const pager = await channel('pager', { events: ['down'] as never })
    const slack = await channel('slack', { events: ['up', 'degraded'] as never })
    const legacy = await channel('legacy')
    const monitor = await createMonitor({
      name: 'routed',
      notifications: [pager.id, slack.id, legacy.id] as never,
    })
    const beat = await heartbeat(monitor, 'down', new Date())
    const event = { payload, monitor, heartbeat: beat, organizationId: org.id }

    const routes: Record<string, string[]> = {}
    for (const notificationEvent of ['down', 'up', 'degraded', 'reminder'] as const) {
      const { queue, added } = fakeQueue()
      await enqueueNotificationsForHeartbeat({ ...event, notificationEvent }, { queue })
      routes[notificationEvent] = added.map((job) => String(job.data.notificationId)).sort()
    }
    const ids = (...channels: Notification[]) => channels.map((c) => String(c.id)).sort()
    expect(routes).toEqual({
      down: ids(pager, legacy),
      up: ids(slack, legacy),
      degraded: ids(slack),
      reminder: ids(legacy),
    })
  })

  it('recovery messages carry the downtime; the worker re-checks the selection', async () => {
    const recoveries = await channel('recoveries', { events: ['up'] as never })
    const monitor = await createMonitor({
      name: 'Shop',
      notifications: [recoveries.id] as never,
    })
    const end = new Date()
    const at = (minutesAgo: number) => new Date(end.getTime() - minutesAgo * 60_000)
    await heartbeat(monitor, 'up', at(60))
    await heartbeat(monitor, 'down', new Date(end.getTime() - 423_000)) // the outage: 7m 3s
    await heartbeat(monitor, 'down', at(3), false)
    const up = await heartbeat(monitor, 'up', end, true, '200 - OK')

    const job = (notificationEvent: 'up' | 'down') => ({
      data: {
        notificationId: String(recoveries.id),
        monitorId: String(monitor.id),
        heartbeatId: String(up.id),
        organizationId: String(org.id),
        notificationEvent,
      },
    })
    expect(await processNotificationJob(payload, job('up'))).toMatchObject({ outcome: 'sent' })
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      event: 'up',
      downtimeSeconds: 423,
      message: '[Shop] [✅ Up] 200 - OK (down for 7 minutes 3 seconds)',
    })

    // The template variables of the same send.
    const ctx = captured[0]
    expect(
      renderMessageTemplate(
        '{{ event }}|{{ downtime }}|{{ downtimeSeconds }}',
        ctx.message,
        ctx.monitor,
        ctx.heartbeat,
        ctx.locale,
        { event: ctx.event, downtimeSeconds: ctx.downtimeSeconds },
      ),
    ).toBe('up|7 minutes 3 seconds|423')

    // A job enqueued before the channel dropped the event is skipped, not sent.
    expect(await processNotificationJob(payload, job('down'))).toEqual({
      outcome: 'skipped',
      reason: 'event-filtered',
    })
    expect(captured).toHaveLength(1)
  })

  it('a recovery without a known outage start has no downtime', async () => {
    const recoveries = await channel('no-start', { events: ['up'] as never })
    const monitor = await createMonitor({ name: 'Fresh', notifications: [recoveries.id] as never })
    const up = await heartbeat(monitor, 'up', new Date(), true, 'OK')
    await processNotificationJob(payload, {
      data: {
        notificationId: String(recoveries.id),
        monitorId: String(monitor.id),
        heartbeatId: String(up.id),
        organizationId: String(org.id),
        notificationEvent: 'up',
      },
    })
    expect(captured[0]).toMatchObject({ downtimeSeconds: null, message: '[Fresh] [✅ Up] OK' })
  })
})

describe('certificate and domain expiry', () => {
  it('only reaches channels that accept the certificate event', async () => {
    const urlOf = (name: string) => `https://hooks.example.test/${name}-${run}`
    const webhook = (name: string, events?: string[]) =>
      channel(
        name,
        {
          config: { url: urlOf(name), method: 'POST', contentType: 'json' },
          ...(events ? { events: events as never } : {}),
        },
        'webhook',
      )
    const legacy = await webhook('expiry-default')
    const downOnly = await webhook('expiry-down', ['down'])
    const monitor = await createMonitor({
      name: 'expiring',
      url: 'https://www.example.com/',
      domainExpiryNotification: true,
      notifications: [legacy.id, downOnly.id] as never,
    })
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 10 * 86_400_000 + 3_600_000)
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            events: [{ eventAction: 'expiration', eventDate: expiresAt.toISOString() }],
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch
    const posted: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        posted.push(String(input instanceof Request ? input.url : input))
        return new Response('{}', { status: 200 })
      }),
    )

    const { notice } = await processDomainExpiry(
      payload,
      {
        monitor,
        heartbeat: { status: 'up' } as HeartbeatEvent['heartbeat'],
        organizationId: org.id,
      },
      { lookup: { fetchImpl }, now },
    )
    expect(notice).not.toBeNull()
    expect(posted).toEqual([urlOf('expiry-default')])
  })
})

describe('maintenance windows', () => {
  const maintenanceEvent = (
    type: MaintenanceEvent['type'],
    monitors: (string | number)[],
  ): MaintenanceEvent => ({
    type,
    organizationId: String(org.id),
    maintenance: {
      id: '1',
      title: 'DB upgrade',
      description: null,
      strategy: 'manual',
      statusPages: [],
      monitors: monitors.map(String),
    },
    occurrence: { id: `occ-${run}` } as MaintenanceEvent['occurrence'],
    update: null,
    reminderMinutes: null,
    at: new Date().toISOString(),
  })

  it('starts and ends reach the channels that opted in, for the monitors they watch', async () => {
    const ops = await channel('maint-ops', { events: ['down', 'maintenance'] as never })
    const legacy = await channel('maint-legacy')
    const group = await createMonitor({ name: 'Backend', type: 'group', url: null })
    const api = await createMonitor({
      name: 'API',
      parent: group.id,
      notifications: [ops.id, legacy.id] as never,
    })
    const web = await createMonitor({ name: 'Web', notifications: [ops.id] as never })
    await createMonitor({ name: 'Unrelated', notifications: [ops.id] as never })

    const started = fakeQueue()
    expect(
      await enqueueMaintenanceNotifications(
        payload,
        maintenanceEvent('started', [group.id, web.id]),
        { queue: started.queue },
      ),
    ).toBe(1)
    expect(started.added).toHaveLength(1)
    const job = started.added[0]
    expect(job.name).toBe('notify-maintenance')
    expect(job.opts.jobId).toBe(`notif-maint:${ops.id}:occ-${run}:started`)
    expect(job.data).toMatchObject({ notificationId: String(ops.id), type: 'started' })
    expect([...(job.data.monitorIds as string[])].sort()).toEqual(
      [String(api.id), String(web.id)].sort(),
    )

    // Announcements, notes and reminders stay with status page subscribers.
    for (const type of ['scheduled', 'reminder', 'updated', 'cancelled'] as const) {
      const quiet = fakeQueue()
      expect(
        await enqueueMaintenanceNotifications(payload, maintenanceEvent(type, [web.id]), {
          queue: quiet.queue,
        }),
      ).toBe(0)
      expect(quiet.added).toHaveLength(0)
    }

    const result = await processMaintenanceNotificationJob(payload, {
      data: job.data as unknown as MaintenanceNotificationJobData,
    })
    expect(result).toMatchObject({ outcome: 'sent' })
    expect(captured[0]).toMatchObject({
      event: 'maintenance',
      monitor: null,
      heartbeat: null,
      message: '[Marmot] [🔧 Maintenance] Maintenance "DB upgrade" started for API and Web.',
    })

    const completed = fakeQueue()
    await enqueueMaintenanceNotifications(payload, maintenanceEvent('completed', [web.id]), {
      queue: completed.queue,
    })
    await processMaintenanceNotificationJob(payload, {
      data: completed.added[0].data as unknown as MaintenanceNotificationJobData,
    })
    expect(captured[1].message).toBe(
      '[Marmot] [🔧 Maintenance] Maintenance "DB upgrade" ended for Web.',
    )
  })
})

describe('import and export', () => {
  it('round-trips the selection; files without one get the defaults', async () => {
    await channel('export-me', { events: ['down', 'degraded'] as never })
    const user = await payload.create({
      collection: 'users',
      data: { email: `filters-${run}@marmot.test`, password: 'password-123', name: 'Owner' },
    })
    await addOrgMembership({ payload, userId: user.id, orgId: org.id, role: 'owner' })
    const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
    const exported = await buildMarmotExport(payload, {
      orgId: org.id,
      user: { ...fresh, collection: 'users' },
    })
    const row = exported.notifications.find((n) => n.name === `export-me-${run}`)
    expect(row?.events).toEqual(['down', 'degraded'])
    const legacyRow = exported.notifications.find((n) => n.name === `plain-${run}`)
    expect(legacyRow?.events).toEqual([...DEFAULT_CHANNEL_EVENTS])

    const { events: _events, ...withoutEvents } = row!
    const plan = parseMarmotExport({
      ...exported,
      monitors: [],
      statusPages: [],
      notifications: [row, { ...withoutEvents, id: 'old', name: 'old-file' }],
    })
    expect(plan.notifications.map((n) => [n.name, n.events])).toEqual([
      [`export-me-${run}`, ['down', 'degraded']],
      ['old-file', undefined],
    ])
  })
})
