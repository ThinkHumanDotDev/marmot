import { getPayload, type Payload } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import type { Role } from '@/access/permissions'
import {
  GET as listRoute,
  POST as declareRoute,
} from '@/app/api/orgs/[orgId]/declared-incidents/route'
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as patchRoute,
} from '@/app/api/orgs/[orgId]/declared-incidents/[id]/route'
import { POST as noteRoute } from '@/app/api/orgs/[orgId]/declared-incidents/[id]/notes/route'
import { env } from '@/env'
import type { DeclaredIncidentSummary } from '@/lib/declared-incidents'
import type {
  AuditLog,
  DeclaredIncident,
  Incident,
  Notification,
  Organization,
  StatusPage,
  User,
} from '@/payload-types'
import {
  processDeclaredNotificationJob,
  runDeclaredReminders,
  setDeclaredJobSink,
  type DeclaredNotificationJob,
} from '@/server/declared-incidents'
import { closeEmitter } from '@/server/realtime/emitter'

/**
 * Declared incidents (#101): the workflow (declare, commander, statuses, postmortem, close), the
 * rejected transitions, the append-only timeline, org RBAC, commander notifications and
 * reminders, and the audit trail.
 */

let payload: Payload
const run = Date.now().toString(36)
const email = (name: string) => `${name}+di-${run}@marmot.test`
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
  // Reloaded with its memberships, for Local API calls as this user.
  const withOrgs = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
  return { user: withOrgs, cookie: `payload-token=${token}` }
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

/** The Local API's `user` needs the collection to apply collection access. */
const asUser = (session: Session) => ({ ...session.user, collection: 'users' as const })

const params = (orgId: string | number, id?: string | number) =>
  Promise.resolve({ orgId: String(orgId), id: String(id ?? '') })

let org: Organization
let otherOrg: Organization
let owner: Session
let admin: Session
let member: Session
let viewer: Session
let outsider: Session
let channel: Notification
const jobs: DeclaredNotificationJob[] = []

async function declare(body: Record<string, unknown>, session = member) {
  const response = await declareRoute(request('POST', body, session), { params: params(org.id) })
  return { response, body: (await response.json()) as DeclaredIncidentSummary }
}

async function patch(id: string, body: Record<string, unknown>, session = member) {
  const response = await patchRoute(request('PATCH', body, session), { params: params(org.id, id) })
  return {
    response,
    body: (await response.json()) as DeclaredIncidentSummary & { errors?: { message: string }[] },
  }
}

async function note(id: string, message: string, session = member) {
  return noteRoute(request('POST', { message }, session), { params: params(org.id, id) })
}

const raw = (id: string) =>
  payload.findByID({
    collection: 'declared-incidents',
    id,
    depth: 0,
    overrideAccess: true,
  }) as Promise<DeclaredIncident>

beforeAll(async () => {
  payload = await getPayload({ config })
  const mk = (name: string, slug: string) =>
    payload.create({ collection: 'organizations', data: { name, slug: `${slug}-${run}` } })
  org = await mk('Response Co', 'response-co')
  otherOrg = await mk('Other Response Co', 'other-response-co')
  owner = await createMember('owner', [[org, 'owner']])
  admin = await createMember('admin', [[org, 'admin']])
  member = await createMember('member', [[org, 'member']])
  viewer = await createMember('viewer', [[org, 'viewer']])
  outsider = await createMember('outsider', [[otherOrg, 'owner']])
  channel = (await payload.create({
    collection: 'notifications',
    depth: 0,
    overrideAccess: true,
    data: {
      organization: org.id,
      name: 'war-room',
      type: 'discord',
      config: {
        webhookUrl: 'https://discord.com/api/webhooks/1/test',
        messageFormat: 'custom',
        messageTemplate: '{{ msg }}',
      },
      events: ['incident'],
      active: true,
    } as never,
  })) as Notification
  setDeclaredJobSink(async (next) => {
    jobs.push(...next)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

afterAll(async () => {
  setDeclaredJobSink(null)
  await closeEmitter()
  const orgIds = [org?.id, otherOrg?.id].filter(Boolean)
  if (orgIds.length) {
    await payload.delete({
      collection: 'declared-incidents',
      where: { organization: { in: orgIds } },
      overrideAccess: true,
    })
    await payload.delete({ collection: 'incidents', where: { organization: { in: orgIds } } })
    await payload.delete({ collection: 'status-pages', where: { organization: { in: orgIds } } })
    await payload.delete({
      collection: 'monitor-incidents',
      where: { organization: { in: orgIds } },
    })
    await payload.delete({ collection: 'monitors', where: { organization: { in: orgIds } } })
    await payload.delete({ collection: 'notifications', where: { organization: { in: orgIds } } })
    await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
  }
  await payload.delete({ collection: 'users', where: { email: { like: `+di-${run}@` } } })
})

describe('lifecycle', () => {
  it('declares, assigns a commander, mitigates, resolves, writes and approves a postmortem, closes', async () => {
    jobs.length = 0
    const started = new Date(Date.now() - 30 * 60_000).toISOString()
    const declared = await declare({
      title: 'Checkout fails',
      severity: 'critical',
      summary: 'EU customers cannot pay',
      startedAt: started,
    })
    expect(declared.response.status).toBe(201)
    const incident = declared.body
    expect(incident).toMatchObject({
      title: 'Checkout fails',
      severity: 'critical',
      status: 'open',
      declaredBy: { id: String(member.user.id) },
      commander: null,
      postmortem: { status: 'none' },
    })
    expect(new Date(incident.startedAt).toISOString()).toBe(started)
    expect(incident.timeline.map((entry) => entry.type)).toEqual(['declared'])
    // The following channel hears about the declaration.
    expect(jobs.map((job) => [job.data.event, job.data.target])).toEqual([
      ['declared', { channel: String(channel.id) }],
    ])

    jobs.length = 0
    const assigned = await patch(incident.id, { commander: owner.user.id })
    expect(assigned.response.status).toBe(200)
    expect(assigned.body.commander).toMatchObject({ id: String(owner.user.id), name: 'owner' })
    const commanderEntry = assigned.body.timeline.at(-1)
    expect(commanderEntry).toMatchObject({ type: 'commander_changed', to: 'owner' })
    expect(jobs.map((job) => job.data.target)).toEqual(
      expect.arrayContaining([
        { channel: String(channel.id) },
        { commander: String(owner.user.id) },
      ]),
    )

    const mitigated = await patch(incident.id, { status: 'mitigated', severity: 'major' })
    expect(mitigated.response.status).toBe(200)
    expect(mitigated.body.status).toBe('mitigated')
    expect(mitigated.body.mitigatedAt).not.toBeNull()

    const resolved = await patch(incident.id, { status: 'resolved' })
    expect(resolved.body.status).toBe('resolved')
    expect(resolved.body.resolvedAt).not.toBeNull()

    // Closing needs an approved postmortem.
    const early = await patch(incident.id, { status: 'closed' })
    expect(early.response.status).toBe(409)
    // Approving needs content.
    expect((await patch(incident.id, { approvePostmortem: true })).response.status).toBe(400)

    const drafted = await patch(incident.id, { postmortem: '## Summary\n\nA bad deploy.' })
    expect(drafted.body.postmortem).toMatchObject({ status: 'draft' })
    const edited = await patch(incident.id, {
      postmortem: '## Summary\n\nA bad deploy, rolled back.',
    })
    expect(edited.body.postmortem.content).toContain('rolled back')
    const approved = await patch(incident.id, { approvePostmortem: true }, owner)
    expect(approved.body.postmortem).toMatchObject({
      status: 'approved',
      approvedBy: { id: String(owner.user.id) },
    })

    const closed = await patch(incident.id, { status: 'closed' })
    expect(closed.response.status).toBe(200)
    expect(closed.body.status).toBe('closed')
    expect(closed.body.closedAt).not.toBeNull()
    expect(closed.body.postmortemSkipped).toBe(false)

    expect(closed.body.timeline.map((entry) => entry.type)).toEqual([
      'declared',
      'commander_changed',
      'severity_changed',
      'status_changed',
      'status_changed',
      'postmortem_drafted',
      'postmortem_approved',
      'status_changed',
      'closed',
    ])
    const severity = closed.body.timeline.find((entry) => entry.type === 'severity_changed')
    expect(severity).toMatchObject({ from: 'critical', to: 'major' })

    // Read-only once closed.
    expect((await patch(incident.id, { title: 'Renamed' })).response.status).toBe(409)
    expect((await note(incident.id, 'too late')).status).toBe(409)
    expect((await raw(incident.id)).title).toBe('Checkout fails')
  })

  it('rejects invalid status transitions', async () => {
    const { body: incident } = await declare({ title: 'Flaky queue' })
    expect(incident.severity).toBe('major')
    const toClosed = await patch(incident.id, { status: 'closed' })
    expect(toClosed.response.status).toBe(409)
    expect((await raw(incident.id)).status).toBe('open')

    expect((await patch(incident.id, { status: 'resolved' })).response.status).toBe(200)
    // resolved → mitigated is not a transition; resolved → open (reopen) is.
    expect((await patch(incident.id, { status: 'mitigated' })).response.status).toBe(409)
    const reopened = await patch(incident.id, { status: 'open' })
    expect(reopened.body.status).toBe('open')
    expect(reopened.body.resolvedAt).toBeNull()

    const canceled = await patch(incident.id, { status: 'canceled' })
    expect(canceled.body.status).toBe('canceled')
    expect(canceled.body.canceledAt).not.toBeNull()
    expect((await patch(incident.id, { status: 'open' })).response.status).toBe(409)
  })

  it('pre-fills startedAt from a monitor incident and rejects a start in the future', async () => {
    const monitor = await payload.create({
      collection: 'monitors',
      depth: 0,
      overrideAccess: true,
      data: {
        organization: org.id,
        name: 'API',
        type: 'http',
        url: 'https://example.com',
        active: false,
        interval: 60,
      } as never,
    })
    const startedAt = new Date(Date.now() - 2 * 3600_000).toISOString()
    const outage = await payload.create({
      collection: 'monitor-incidents',
      depth: 0,
      overrideAccess: true,
      data: { organization: org.id, monitor: monitor.id, status: 'open', startedAt } as never,
    })
    const { response, body } = await declare({ title: 'API down', monitorIncident: outage.id })
    expect(response.status).toBe(201)
    expect(new Date(body.startedAt).toISOString()).toBe(startedAt)
    expect(body.monitorIncident).toMatchObject({ id: String(outage.id), monitorName: 'API' })

    const future = new Date(Date.now() + 3600_000).toISOString()
    expect((await declare({ title: 'Tomorrow', startedAt: future })).response.status).toBe(400)
  })

  it('lets only admins close without an approved postmortem', async () => {
    const { body: incident } = await declare({ title: 'Small blip', severity: 'minor' })
    await patch(incident.id, { status: 'resolved' })
    const byMember = await patch(incident.id, { status: 'closed', skipPostmortem: true })
    expect(byMember.response.status).toBe(403)
    const byAdmin = await patch(incident.id, { status: 'closed', skipPostmortem: true }, admin)
    expect(byAdmin.response.status).toBe(200)
    expect(byAdmin.body.postmortemSkipped).toBe(true)
    expect(byAdmin.body.timeline.at(-1)).toMatchObject({ type: 'closed', to: 'postmortem_skipped' })
  })
})

describe('timeline', () => {
  it('appends notes and keeps earlier entries whatever the writer sends', async () => {
    const { body: incident } = await declare({ title: 'Slow search' })
    const response = await note(incident.id, '  Rolled back the index change  ')
    expect(response.status).toBe(201)
    const withNote = (await response.json()) as DeclaredIncidentSummary
    expect(withNote.timeline.at(-1)).toMatchObject({
      type: 'note',
      message: 'Rolled back the index change',
      by: { id: String(member.user.id) },
    })
    expect((await note(incident.id, '   ')).status).toBe(400)

    // Writing the timeline directly (Local API as the member) cannot rewrite history.
    await payload.update({
      collection: 'declared-incidents',
      id: incident.id,
      data: { timeline: [], summary: 'Search p95 at 4s' },
      user: asUser(member),
      overrideAccess: false,
    })
    const stored = await raw(incident.id)
    expect(stored.summary).toBe('Search p95 at 4s')
    expect(stored.timeline?.map((entry) => entry.type)).toEqual(['declared', 'note'])
    expect(stored.declaredBy).toBe(member.user.id)
  })

  it('records linking and unlinking the public status-page incident', async () => {
    const page = (await payload.create({
      collection: 'status-pages',
      depth: 0,
      overrideAccess: true,
      data: { organization: org.id, title: 'Public', slug: `public-di-${run}` } as never,
    })) as StatusPage
    const publicIncident = (await payload.create({
      collection: 'incidents',
      depth: 0,
      overrideAccess: true,
      data: {
        organization: org.id,
        statusPage: page.id,
        title: 'Payments degraded',
        updates: [{ status: 'investigating', message: 'Looking into it' }],
      } as never,
    })) as Incident
    const foreignPage = (await payload.create({
      collection: 'status-pages',
      depth: 0,
      overrideAccess: true,
      data: { organization: otherOrg.id, title: 'Other', slug: `other-di-${run}` } as never,
    })) as StatusPage
    const foreignIncident = (await payload.create({
      collection: 'incidents',
      depth: 0,
      overrideAccess: true,
      data: {
        organization: otherOrg.id,
        statusPage: foreignPage.id,
        title: 'Not yours',
        updates: [{ status: 'investigating', message: 'x' }],
      } as never,
    })) as Incident

    const { body: incident } = await declare({ title: 'Payments' })
    const foreign = await patch(incident.id, { statusPageIncident: foreignIncident.id })
    expect(foreign.response.status).toBe(400)

    const linked = await patch(incident.id, { statusPageIncident: publicIncident.id })
    expect(linked.body.statusPageIncident).toMatchObject({
      id: String(publicIncident.id),
      title: 'Payments degraded',
    })
    expect(linked.body.timeline.at(-1)).toMatchObject({
      type: 'linked',
      message: 'Payments degraded',
    })
    const unlinked = await patch(incident.id, { statusPageIncident: null })
    expect(unlinked.body.statusPageIncident).toBeNull()
    expect(unlinked.body.timeline.at(-1)).toMatchObject({ type: 'unlinked' })
  })
})

describe('access', () => {
  it('lets viewers read and not change; other organizations see nothing', async () => {
    const { body: incident } = await declare({ title: 'Read only for viewers' })

    const list = await listRoute(
      request('GET', undefined, viewer, 'http://localhost/x?status=active'),
      {
        params: params(org.id),
      },
    )
    expect(list.status).toBe(200)
    const listed = (await list.json()) as { docs: DeclaredIncidentSummary[] }
    expect(listed.docs.some((doc) => doc.id === incident.id)).toBe(true)
    expect(
      (await getRoute(request('GET', undefined, viewer), { params: params(org.id, incident.id) }))
        .status,
    ).toBe(200)

    expect((await declare({ title: 'Nope' }, viewer)).response.status).toBe(403)
    expect((await patch(incident.id, { status: 'mitigated' }, viewer)).response.status).toBe(403)
    expect((await note(incident.id, 'hi', viewer)).status).toBe(403)
    expect(
      (
        await deleteRoute(request('DELETE', undefined, member), {
          params: params(org.id, incident.id),
        })
      ).status,
    ).toBe(403)
    // Collection access applies to direct Local API writes as well.
    await expect(
      payload.update({
        collection: 'declared-incidents',
        id: incident.id,
        data: { title: 'Changed by a viewer' },
        user: asUser(viewer),
        overrideAccess: false,
      }),
    ).rejects.toThrow(/not allowed/)

    // Another organization's member: forbidden on this org, not found through their own.
    expect(
      (await getRoute(request('GET', undefined, outsider), { params: params(org.id, incident.id) }))
        .status,
    ).toBe(403)
    expect(
      (
        await getRoute(request('GET', undefined, outsider), {
          params: params(otherOrg.id, incident.id),
        })
      ).status,
    ).toBe(404)

    expect(
      (
        await deleteRoute(request('DELETE', undefined, admin), {
          params: params(org.id, incident.id),
        })
      ).status,
    ).toBe(204)
  })

  it('only accepts members of the organization as commander', async () => {
    const { response } = await declare({ title: 'Wrong commander', commander: outsider.user.id })
    expect(response.status).toBe(400)
  })
})

describe('notifications and reminders', () => {
  it('reminds the commander after the severity threshold, then backs off; activity re-arms it', async () => {
    const { body: incident } = await declare({
      title: 'Database failover',
      severity: 'critical',
      commander: owner.user.id,
    })
    const armed = await raw(incident.id)
    const nextAt = Date.parse(armed.nextReminderAt ?? '')
    expect(nextAt - Date.parse(armed.lastActivityAt ?? '')).toBe(3600_000)

    jobs.length = 0
    // Not due yet.
    await runDeclaredReminders(payload, new Date(nextAt - 60_000))
    expect(jobs.filter((job) => job.data.incidentId === incident.id)).toHaveLength(0)

    await runDeclaredReminders(payload, new Date(nextAt + 1000))
    const reminders = jobs.filter((job) => job.data.incidentId === incident.id)
    expect(reminders.map((job) => job.data.event)).toEqual(['reminder', 'reminder'])
    expect(reminders.map((job) => job.data.target)).toEqual(
      expect.arrayContaining([{ commander: String(owner.user.id) }]),
    )
    const reminded = await raw(incident.id)
    expect(reminded.remindersSent).toBe(1)
    // Backoff: the next one comes after twice the threshold.
    expect(Date.parse(reminded.nextReminderAt ?? '') - (nextAt + 1000)).toBe(2 * 3600_000)
    // The reminder is not activity and leaves the timeline alone.
    expect(reminded.lastActivityAt).toBe(armed.lastActivityAt)
    expect(reminded.timeline).toHaveLength(armed.timeline?.length ?? 0)

    await note(incident.id, 'Replica promoted')
    const active = await raw(incident.id)
    expect(active.remindersSent).toBe(0)
    expect(Date.parse(active.nextReminderAt ?? '') - Date.parse(active.lastActivityAt ?? '')).toBe(
      3600_000,
    )

    // Resolved incidents are not reminded.
    await patch(incident.id, { status: 'resolved' })
    expect((await raw(incident.id)).nextReminderAt ?? null).toBeNull()
  })

  it('emails the commander and posts to the following channels', async () => {
    const { body: incident } = await declare({ title: 'CDN outage', severity: 'major' })
    jobs.length = 0
    await patch(incident.id, { commander: admin.user.id })
    const commanderJob = jobs.find((job) => 'commander' in job.data.target)
    const channelJob = jobs.find((job) => 'channel' in job.data.target)
    expect(commanderJob?.data.event).toBe('commander')
    expect(channelJob?.data.event).toBe('commander')

    const sendEmail = vi.spyOn(payload, 'sendEmail').mockResolvedValue(undefined)
    expect(await processDeclaredNotificationJob(payload, commanderJob!)).toEqual({
      outcome: 'sent',
    })
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: admin.user.email,
        subject: expect.stringContaining('CDN outage'),
        text: expect.stringContaining(`/declared-incidents/${incident.id}`),
      }),
    )

    const calls: { content: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)) as { content: string })
        return new Response('{}', { status: 200 })
      }),
    )
    expect(await processDeclaredNotificationJob(payload, channelJob!)).toEqual({ outcome: 'sent' })
    expect(calls).toHaveLength(1)
    expect(calls[0].content).toMatch(
      /^\[CDN outage\] \[🧑‍🚒 Commander assigned\] admin is the incident commander\. http/,
    )

    // Assigning yourself sends no email to yourself.
    jobs.length = 0
    await patch(incident.id, { commander: member.user.id })
    expect(jobs.some((job) => 'commander' in job.data.target)).toBe(false)
  })
})

describe('audit', () => {
  it('writes every member change to the audit log', async () => {
    const { body: incident } = await declare({ title: 'Audited' })
    await patch(incident.id, { severity: 'critical' })
    await note(incident.id, 'Investigating')
    const { docs } = await payload.find({
      collection: 'audit-logs',
      where: {
        and: [
          { entityType: { equals: 'declared_incident' } },
          { entityId: { equals: incident.id } },
        ],
      },
      depth: 0,
      limit: 20,
    })
    const actions = (docs as AuditLog[]).map((row) => row.action).sort()
    // Declared, severity changed, note added.
    expect(actions).toEqual([
      'declared_incident.created',
      'declared_incident.updated',
      'declared_incident.updated',
    ])
    expect((docs as AuditLog[]).every((row) => String(row.actor) === String(member.user.id))).toBe(
      true,
    )
  })
})
