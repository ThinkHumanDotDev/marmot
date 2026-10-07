import { getPayload, type Payload } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import type { Role } from '@/access/permissions'
import { POST as ackByLinkRoute } from '@/app/api/incident-ack/route'
import { GET as listRoute } from '@/app/api/orgs/[orgId]/monitor-incidents/route'
import { GET as getRoute } from '@/app/api/orgs/[orgId]/monitor-incidents/[id]/route'
import { POST as acknowledgeRoute } from '@/app/api/orgs/[orgId]/monitor-incidents/[id]/acknowledge/route'
import { POST as resolveRoute } from '@/app/api/orgs/[orgId]/monitor-incidents/[id]/resolve/route'
import { POST as publishRoute } from '@/app/api/orgs/[orgId]/monitor-incidents/[id]/publish/route'
import { env } from '@/env'
import type { MonitorIncidentSummary } from '@/lib/monitor-incidents'
import type {
  Incident,
  Monitor,
  MonitorIncident,
  Notification,
  Organization,
  User,
} from '@/payload-types'
import { clearHeartbeatListeners, type ChecksQueue } from '@/server/engine'
import { recordBeat } from '@/server/engine/worker'
import {
  ackLinkUrl,
  buildIncidentMessage,
  findOpenIncident,
  processIncidentNotificationJob,
  registerIncidentListener,
  setIncidentJobSink,
  setReminderPolicy,
  signAckToken,
  verifyAckToken,
  type IncidentJob,
} from '@/server/incidents'
import {
  clearNotificationGates,
  processNotificationJob,
  registerNotificationListener,
  type NotificationsQueue,
} from '@/server/notifications'
import { closeEmitter } from '@/server/realtime/emitter'

/**
 * Monitor incidents (#100): the engine opens and resolves them, members acknowledge them through
 * the API or a signed link, reminders stop once acknowledged, channels hear about it, and an
 * incident can be published to a status page. Access is org-scoped.
 */

let payload: Payload
const run = Date.now().toString(36)
const email = (name: string) => `${name}+mi-${run}@marmot.test`
const PASSWORD = 'password-123'

type Session = { user: User; cookie: string }

async function createMember(name: string, orgs: [Organization, Role][]): Promise<Session> {
  const user = await payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name },
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

function request(method: string, body?: unknown, session?: Session, url = 'http://localhost/x') {
  return new Request(url, {
    method,
    headers: {
      Origin: env.NEXT_PUBLIC_SERVER_URL,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(session ? { cookie: session.cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

const params = (orgId: string | number, id?: string | number) =>
  Promise.resolve({ orgId: String(orgId), id: String(id ?? '') })

/** Scheduler stub: recordBeat re-plans the scheduler when the cadence changes. */
const queue = {
  upsertJobScheduler: vi.fn(async () => undefined),
  removeJobScheduler: vi.fn(async () => true),
} as unknown as ChecksQueue

/** Notification queue stub: records what the dispatcher would enqueue. */
const enqueued: { jobId: string }[] = []
const notificationsQueue = {
  getJob: vi.fn(async () => null),
  addBulk: vi.fn(async (jobs: { opts: { jobId: string } }[]) => {
    for (const job of jobs) enqueued.push({ jobId: job.opts.jobId })
    return []
  }),
} as unknown as NotificationsQueue

const incidentJobs: IncidentJob[] = []

let org: Organization
let otherOrg: Organization
let owner: Session
let member: Session
let viewer: Session
let outsider: Session
let channel: Notification
let unhook: () => void
let unhookNotifications: () => void

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
      retryInterval: 60,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 48,
      notifications: [channel.id],
      ...extra,
    } as never,
  })) as Monitor
}

/** One beat through the real state machine and listeners; returns the refreshed monitor. */
async function beat(monitor: Monitor, ok: boolean, msg: string, at?: Date): Promise<Monitor> {
  const result = await recordBeat(
    payload,
    monitor,
    ok ? { ok: true, status: 'up', msg, ping: 12 } : { ok: false, msg },
    { queue, now: at },
  )
  return result.monitor
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
  const mk = (name: string, slug: string) =>
    payload.create({ collection: 'organizations', data: { name, slug: `${slug}-${run}` } })
  org = await mk('Incidents Co', 'incidents-co')
  otherOrg = await mk('Elsewhere Co', 'elsewhere-co')
  owner = await createMember('owner', [[org, 'owner']])
  member = await createMember('member', [[org, 'member']])
  viewer = await createMember('viewer', [[org, 'viewer']])
  outsider = await createMember('outsider', [[otherOrg, 'owner']])
  channel = (await payload.create({
    collection: 'notifications',
    depth: 0,
    overrideAccess: true,
    data: {
      organization: org.id,
      name: 'discord',
      type: 'discord',
      config: {
        webhookUrl: 'https://discord.com/api/webhooks/1/test',
        messageFormat: 'custom',
        messageTemplate: '{{ msg }}',
      },
      active: true,
    } as never,
  })) as Notification

  clearHeartbeatListeners()
  clearNotificationGates()
  unhook = registerIncidentListener(payload)
  unhookNotifications = registerNotificationListener(payload, { queue: notificationsQueue })
  setIncidentJobSink(async (jobs) => {
    incidentJobs.push(...jobs)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  setReminderPolicy(null)
})

afterAll(async () => {
  unhook?.()
  unhookNotifications?.()
  setIncidentJobSink(null)
  await closeEmitter()
  const orgIds = [org?.id, otherOrg?.id].filter(Boolean)
  if (orgIds.length) {
    await payload.delete({ collection: 'incidents', where: { organization: { in: orgIds } } })
    await payload.delete({ collection: 'status-pages', where: { organization: { in: orgIds } } })
    await payload.delete({ collection: 'monitors', where: { organization: { in: orgIds } } })
    await payload.delete({ collection: 'notifications', where: { organization: { in: orgIds } } })
    await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
  }
  await payload.delete({ collection: 'users', where: { email: { like: `+mi-${run}@` } } })
})

describe('engine lifecycle', () => {
  it('opens on DOWN, keeps one incident while down, resolves automatically on UP', async () => {
    let monitor = await createMonitor('Checkout API')
    const t0 = new Date(Date.now() - 10 * 60_000)
    monitor = await beat(monitor, true, 'OK', t0)
    expect(await incidentsOf(monitor)).toHaveLength(0)

    monitor = await beat(monitor, false, 'HTTP 503', new Date(t0.getTime() + 60_000))
    monitor = await beat(monitor, false, 'HTTP 500', new Date(t0.getTime() + 120_000))
    let incidents = await incidentsOf(monitor)
    expect(incidents).toHaveLength(1)
    expect(incidents[0]).toMatchObject({ status: 'open', cause: 'HTTP 503' })
    expect(incidents[0].organization).toEqual(org.id)
    expect(await findOpenIncident(payload, monitor.id)).toMatchObject({ id: incidents[0].id })

    monitor = await beat(monitor, true, 'OK', new Date(t0.getTime() + 300_000))
    incidents = await incidentsOf(monitor)
    expect(incidents).toHaveLength(1)
    expect(incidents[0]).toMatchObject({ status: 'resolved', autoResolved: true, resolvedBy: null })
    expect(Date.parse(incidents[0].resolvedAt!) - Date.parse(incidents[0].startedAt)).toBe(240_000)
    expect(incidents[0].timeline?.map((row) => row.type)).toEqual(['opened', 'resolved'])
    expect(await findOpenIncident(payload, monitor.id)).toBeNull()

    // The next outage is a new incident.
    monitor = await beat(monitor, false, 'timeout', new Date(t0.getTime() + 360_000))
    expect((await incidentsOf(monitor)).map((i) => i.status)).toEqual(['resolved', 'open'])
  })

  it('stays open through maintenance and does not reopen after a manual resolve', async () => {
    let monitor = await createMonitor('Search')
    monitor = await beat(monitor, false, 'refused')
    monitor = (
      await recordBeat(
        payload,
        monitor,
        { ok: false, msg: 'Monitor under maintenance', underMaintenance: true },
        { queue },
      )
    ).monitor
    let [incident] = await incidentsOf(monitor)
    expect(incident.status).toBe('open')
    expect(incident.timeline?.map((row) => row.type)).toEqual(['opened', 'maintenance'])

    monitor = await beat(monitor, false, 'still refused')
    expect(await incidentsOf(monitor)).toHaveLength(1)

    const response = await resolveRoute(request('POST', { note: 'handled' }, member), {
      params: params(org.id, incident.id),
    })
    expect(response.status).toBe(200)
    monitor = await beat(monitor, false, 'still refused')
    ;[incident] = await incidentsOf(monitor)
    expect(await incidentsOf(monitor)).toHaveLength(1)
    expect(incident).toMatchObject({ status: 'resolved', autoResolved: false })
  })

  it('ignores beats held while the checker itself was offline', async () => {
    const offline = (monitor: Monitor) =>
      recordBeat(
        payload,
        monitor,
        { ok: false, msg: 'Checker offline', checkerOffline: true },
        { queue },
      ).then((r) => r.monitor)

    // An UP monitor: a held beat opens nothing.
    let up = await createMonitor('Held up')
    up = await beat(up, true, 'OK')
    up = await offline(up)
    expect(await incidentsOf(up)).toHaveLength(0)

    // A DOWN monitor: the incident stays open through held beats and resolves on a real recovery.
    let down = await createMonitor('Held down')
    down = await beat(down, false, 'refused')
    down = await offline(down)
    down = await offline(down)
    let incidents = await incidentsOf(down)
    expect(incidents.map((i) => i.status)).toEqual(['open'])
    expect(incidents[0].timeline?.map((row) => row.type)).toEqual(['opened'])
    down = await beat(down, true, 'OK')
    incidents = await incidentsOf(down)
    expect(incidents.map((i) => i.status)).toEqual(['resolved'])
  })

  it('holds reminders back once the incident is acknowledged (pluggable policy)', async () => {
    let monitor = await createMonitor('Billing', { resendInterval: 1 })
    enqueued.length = 0
    monitor = await beat(monitor, false, 'down 1')
    expect(enqueued).toHaveLength(1)

    // resendInterval 1: every further DOWN beat is a reminder.
    monitor = await beat(monitor, false, 'down 2')
    expect(enqueued).toHaveLength(2)
    let [incident] = await incidentsOf(monitor)
    expect(incident.remindersSent).toBe(1)

    const ack = await acknowledgeRoute(request('POST', {}, member), {
      params: params(org.id, incident.id),
    })
    expect(ack.status).toBe(200)
    monitor = await beat(monitor, false, 'down 3')
    expect(enqueued).toHaveLength(2)
    ;[incident] = await incidentsOf(monitor)
    expect(incident.remindersSent).toBe(1)

    // A replacement policy (#147) decides instead.
    setReminderPolicy(({ incident: current }) => current?.status === 'acknowledged')
    monitor = await beat(monitor, false, 'down 4')
    expect(enqueued).toHaveLength(3)

    // Recovery is always announced.
    monitor = await beat(monitor, true, 'OK')
    expect(enqueued).toHaveLength(4)
    ;[incident] = await incidentsOf(monitor)
    expect(incident.status).toBe('resolved')
  })
})

describe('routes and access', () => {
  let monitor: Monitor
  let incident: MonitorIncident

  beforeAll(async () => {
    monitor = await createMonitor('Gateway')
    monitor = await beat(monitor, false, 'ECONNRESET')
    ;[incident] = await incidentsOf(monitor)
  })

  it('lists incidents with stats for viewers, not for other organizations', async () => {
    const response = await listRoute(
      request('GET', undefined, viewer, `http://localhost/x?monitor=${monitor.id}&range=all`),
      { params: params(org.id) },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      docs: MonitorIncidentSummary[]
      stats: { total: number; open: number }
    }
    expect(body.docs.map((d) => d.id)).toEqual([String(incident.id)])
    expect(body.docs[0]).toMatchObject({
      status: 'open',
      cause: 'ECONNRESET',
      monitor: { id: String(monitor.id), name: 'Gateway' },
    })
    expect(body.stats).toMatchObject({ total: 1, open: 1 })

    expect(
      (await listRoute(request('GET', undefined, outsider), { params: params(org.id) })).status,
    ).toBe(403)
    expect(
      (
        await getRoute(request('GET', undefined, outsider), {
          params: params(otherOrg.id, incident.id),
        })
      ).status,
    ).toBe(404)
    const outsiderUser = await payload.findByID({ collection: 'users', id: outsider.user.id })
    const visible = await payload.find({
      collection: 'monitor-incidents',
      user: { ...outsiderUser, collection: 'users' },
      overrideAccess: false,
      depth: 0,
    })
    expect(visible.docs.map((d) => String(d.id))).not.toContain(String(incident.id))
  })

  it('is written only by the server', async () => {
    await expect(
      payload.update({
        collection: 'monitor-incidents',
        id: incident.id,
        data: { status: 'resolved' },
        user: {
          ...(await payload.findByID({ collection: 'users', id: owner.user.id })),
          collection: 'users',
        },
        overrideAccess: false,
      }),
    ).rejects.toThrow()
  })

  it('lets members acknowledge once, refuses viewers, and notifies the channels', async () => {
    const denied = await acknowledgeRoute(request('POST', {}, viewer), {
      params: params(org.id, incident.id),
    })
    expect(denied.status).toBe(403)

    incidentJobs.length = 0
    const response = await acknowledgeRoute(request('POST', { note: 'Looking into it' }, member), {
      params: params(org.id, incident.id),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as MonitorIncidentSummary
    expect(body).toMatchObject({
      status: 'acknowledged',
      acknowledgedBy: { id: String(member.user.id), name: 'member' },
      acknowledgedVia: 'dashboard',
    })
    expect(body.timeline.at(-1)).toMatchObject({ type: 'acknowledged', message: 'Looking into it' })
    expect(incidentJobs.map((job) => job.data)).toEqual([
      expect.objectContaining({
        notificationId: String(channel.id),
        incidentId: String(incident.id),
        event: 'acknowledged',
      }),
    ])

    const again = await acknowledgeRoute(request('POST', {}, owner), {
      params: params(org.id, incident.id),
    })
    expect(again.status).toBe(409)

    // The audit log names who acknowledged (one row: the refused second attempt writes none).
    const { docs: audit } = await payload.find({
      collection: 'audit-logs',
      where: {
        and: [
          { action: { equals: 'monitor_incident.acknowledged' } },
          { entityId: { equals: String(incident.id) } },
        ],
      },
      depth: 0,
    })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      actorType: 'user',
      actorRef: String(member.user.id),
      organization: org.id,
      entityType: 'monitor_incident',
      after: { status: 'acknowledged' },
      metadata: { via: 'dashboard' },
    })
  })

  it('sends the acknowledgement through the provider in the [name] [label] text shape', async () => {
    const calls: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)))
        return new Response('{}', { status: 200 })
      }),
    )
    const job = incidentJobs[0]
    const result = await processIncidentNotificationJob(payload, job)
    expect(result.outcome).toBe('sent')
    expect(calls).toEqual([
      expect.objectContaining({
        content: '[Gateway] [👀 Acknowledged] Acknowledged by member. Note: Looking into it',
      }),
    ])
  })

  it('resolves by hand and announces it', async () => {
    incidentJobs.length = 0
    const response = await resolveRoute(request('POST', {}, member), {
      params: params(org.id, incident.id),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'resolved',
      autoResolved: false,
      resolvedBy: { id: String(member.user.id) },
    })
    expect(incidentJobs.map((job) => job.data.event)).toEqual(['resolved'])
    const again = await resolveRoute(request('POST', {}, member), {
      params: params(org.id, incident.id),
    })
    expect(again.status).toBe(409)
  })
})

describe('signed acknowledge links', () => {
  it('signs, verifies and rejects tampered or expired tokens', () => {
    const token = signAckToken(42)
    expect(verifyAckToken(token)).toEqual({ incidentId: '42' })
    expect(verifyAckToken(`${token}x`)).toBeNull()
    expect(verifyAckToken(signAckToken(42, Date.now() - 8 * 24 * 3600 * 1000))).toBeNull()
    const [body, signature] = token.split('.')
    const forged = Buffer.from('43.9999999999').toString('base64url')
    expect(verifyAckToken(`${forged}.${signature}`)).toBeNull()
    expect(verifyAckToken(`${body}.${signature}`)).not.toBeNull()
  })

  it('puts the link in DOWN messages and acknowledges anonymously through it', async () => {
    let monitor = await createMonitor('Webhooks')
    monitor = await beat(monitor, false, 'HTTP 502')
    const [incident] = await incidentsOf(monitor)
    const heartbeats = await payload.find({
      collection: 'heartbeats',
      where: { monitor: { equals: monitor.id } },
      sort: '-time',
      limit: 1,
      depth: 0,
    })

    const calls: { content?: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)))
        return new Response('{}', { status: 200 })
      }),
    )
    await processNotificationJob(payload, {
      data: {
        notificationId: String(channel.id),
        monitorId: String(monitor.id),
        heartbeatId: String(heartbeats.docs[0].id),
        organizationId: String(org.id),
      },
    })
    const content = calls[0]?.content ?? ''
    expect(content).toContain('HTTP 502')
    const link = content.match(/Acknowledge: (\S+)/)?.[1]
    expect(link).toBeTruthy()
    expect(link!.startsWith(`${env.NEXT_PUBLIC_SERVER_URL.replace(/\/$/, '')}/ack/`)).toBe(true)
    const token = link!.split('/ack/')[1]

    expect((await ackByLinkRoute(request('POST', { token: `${token}0` }))).status).toBe(404)
    const response = await ackByLinkRoute(request('POST', { token }))
    expect(response.status).toBe(200)
    const [after] = await incidentsOf(monitor)
    expect(after).toMatchObject({
      status: 'acknowledged',
      acknowledgedBy: null,
      acknowledgedVia: 'link',
    })
    expect((await ackByLinkRoute(request('POST', { token }))).status).toBe(409)
    expect(ackLinkUrl(incident.id)).toContain('/ack/')
  })
})

describe('publishing to a status page', () => {
  it('creates a public incident naming the monitor components, once', async () => {
    let monitor = await createMonitor('Storefront')
    monitor = await beat(monitor, false, 'HTTP 500')
    const [incident] = await incidentsOf(monitor)
    const page = await payload.create({
      collection: 'status-pages',
      depth: 0,
      overrideAccess: true,
      data: {
        organization: org.id,
        title: 'Public status',
        slug: `public-${run}`,
        groups: [{ name: 'Services', monitors: [{ type: 'monitor', monitor: monitor.id }] }],
      } as never,
    })
    const componentId = page.groups?.[0]?.monitors?.[0]?.id

    expect(
      (
        await publishRoute(request('POST', { statusPageId: page.id }, viewer), {
          params: params(org.id, incident.id),
        })
      ).status,
    ).toBe(403)

    const response = await publishRoute(
      request(
        'POST',
        { statusPageId: page.id, title: 'Storefront errors', message: 'On it' },
        member,
      ),
      { params: params(org.id, incident.id) },
    )
    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      incident: MonitorIncidentSummary
      statusPageIncident: Incident
    }
    expect(body.statusPageIncident).toMatchObject({ title: 'Storefront errors', active: true })
    expect(body.statusPageIncident.updates?.[0]).toMatchObject({
      status: 'investigating',
      message: 'On it',
      components: [expect.objectContaining({ component: componentId, impact: 'major_outage' })],
    })
    expect(body.incident.statusPageIncident).toMatchObject({
      id: String(body.statusPageIncident.id),
      statusPage: String(page.id),
    })
    expect(body.incident.timeline.at(-1)).toMatchObject({ type: 'published' })

    const again = await publishRoute(request('POST', { statusPageId: page.id }, member), {
      params: params(org.id, incident.id),
    })
    expect(again.status).toBe(409)
  })
})

describe('messages', () => {
  it('renders resolution messages with the duration', () => {
    const base = {
      startedAt: '2026-10-07T10:00:00.000Z',
      resolvedAt: '2026-10-07T11:30:00.000Z',
      acknowledgedBy: null,
      acknowledgedVia: null,
      timeline: [],
    }
    expect(
      buildIncidentMessage('API', { ...base, resolvedBy: { id: '1', name: 'Ada' } }, 'resolved'),
    ).toBe('[API] [✅ Resolved] Resolved by Ada after 1 hour 30 minutes.')
    expect(buildIncidentMessage('API', { ...base, resolvedBy: null }, 'resolved')).toBe(
      '[API] [✅ Resolved] Resolved by hand after 1 hour 30 minutes.',
    )
  })
})
