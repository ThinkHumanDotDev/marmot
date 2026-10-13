import { getPayload, type Payload } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import type { Role } from '@/access/permissions'
import { GET as onCallRoute } from '@/app/api/orgs/[orgId]/on-call/route'
import { GET as shiftsRoute } from '@/app/api/orgs/[orgId]/on-call/shifts/route'
import { POST as createScheduleRoute } from '@/app/api/orgs/[orgId]/on-call/schedules/route'
import {
  DELETE as deleteScheduleRoute,
  GET as getScheduleRoute,
  PATCH as patchScheduleRoute,
} from '@/app/api/orgs/[orgId]/on-call/schedules/[id]/route'
import { POST as createPolicyRoute } from '@/app/api/orgs/[orgId]/on-call/escalation-policies/route'
import { PATCH as patchPolicyRoute } from '@/app/api/orgs/[orgId]/on-call/escalation-policies/[id]/route'
import { env } from '@/env'
import type {
  EscalationPolicySummary,
  OnCallScheduleSummary,
  OnCallShiftSummary,
} from '@/lib/on-call'
import type { Monitor, MonitorIncident, Notification, Organization, User } from '@/payload-types'
import { createQueue } from '@/server/engine/queues'
import { acknowledge, handleIncidentBeat, setIncidentJobSink } from '@/server/incidents'
import {
  escalationStepJobId,
  processEscalationPage,
  processEscalationStep,
  setEscalationsQueue,
  type EscalationJobData,
  type EscalationJobName,
  type EscalationPageJobData,
  type EscalationStepJobData,
  type EscalationsQueue,
} from '@/server/on-call/escalation'
import { closeEmitter } from '@/server/realtime/emitter'

/**
 * On-call schedules and escalation policies (#145): who is on call at an instant (rotation across
 * DST, overrides), members' upcoming shifts, escalation timing as BullMQ delayed jobs, stopping on
 * acknowledgement, and org RBAC on every route.
 */

let payload: Payload
const run = Date.now().toString(36)
const email = (name: string) => `${name}+oc-${run}@marmot.test`
const PASSWORD = 'password-123'
const prefix = `test-oncall-${run}`

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

const params = (orgId: string | number, id?: string | number) =>
  Promise.resolve({ orgId: String(orgId), id: String(id ?? '') })

let org: Organization
let otherOrg: Organization
let owner: Session
let admin: Session
let member: Session
let viewer: Session
let outsider: Session
let ada: Session
let grace: Session
let linus: Session
let channel: Notification
let foreignChannel: Notification
let queue: EscalationsQueue

async function createSchedule(body: Record<string, unknown>, session = member) {
  const response = await createScheduleRoute(request('POST', body, session), {
    params: params(org.id),
  })
  return { response, body: (await response.json()) as OnCallScheduleSummary }
}

async function createPolicy(body: Record<string, unknown>, session = admin) {
  const response = await createPolicyRoute(request('POST', body, session), {
    params: params(org.id),
  })
  return { response, body: (await response.json()) as EscalationPolicySummary }
}

async function onCallAt(at: string, session: Session = viewer) {
  const response = await onCallRoute(
    request('GET', undefined, session, `http://localhost/x?at=${encodeURIComponent(at)}`),
    { params: params(org.id) },
  )
  return { response, body: (await response.json()) as { schedules: OnCallScheduleSummary[] } }
}

/** A weekly rotation of Ada, Grace and Linus in New York, handing off on Mondays at 09:00. */
const weeklyLayer = () => ({
  name: 'Primary',
  rotation: 'weekly',
  handoffTime: '09:00',
  startDate: '2026-03-02',
  members: [ada.user.id, grace.user.id, linus.user.id],
})

async function createMonitor(name: string): Promise<Monitor> {
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
      timeout: 48,
    } as never,
  })) as Monitor
}

/** Opens the monitor's incident through the heartbeat listener, as a DOWN beat would. */
async function goDown(monitor: Monitor, at: Date): Promise<MonitorIncident> {
  const fresh = (await payload.findByID({
    collection: 'monitors',
    id: monitor.id,
    depth: 0,
    overrideAccess: true,
  })) as Monitor
  const result = await handleIncidentBeat({
    payload,
    monitor: fresh,
    heartbeat: { status: 'down', important: true, msg: 'HTTP 503', time: at.toISOString() },
  } as never)
  return result!.incident!
}

const incident = (id: string | number) =>
  payload.findByID({
    collection: 'monitor-incidents',
    id,
    depth: 0,
    overrideAccess: true,
  }) as Promise<MonitorIncident>

const stepJob = (incidentId: string | number, round: number, step: number) =>
  queue.getJob(escalationStepJobId(incidentId, round, step))

async function pageJobs(incidentId: string | number) {
  const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized'])
  return jobs.filter(
    (job) => job.name === 'escalation-page' && job.data.incidentId === String(incidentId),
  ) as unknown as { data: EscalationPageJobData }[]
}

beforeAll(async () => {
  payload = await getPayload({ config })
  const mk = (name: string, slug: string) =>
    payload.create({ collection: 'organizations', data: { name, slug: `${slug}-${run}` } })
  org = await mk('On-call Co', 'on-call-co')
  otherOrg = await mk('Other On-call Co', 'other-on-call-co')
  owner = await createMember('owner', [[org, 'owner']])
  admin = await createMember('admin', [[org, 'admin']])
  member = await createMember('member', [[org, 'member']])
  viewer = await createMember('viewer', [[org, 'viewer']])
  outsider = await createMember('outsider', [[otherOrg, 'owner']])
  ada = await createMember('Ada', [[org, 'member']])
  grace = await createMember('Grace', [[org, 'member']])
  linus = await createMember('Linus', [[org, 'member']])
  const discord = (orgId: string | number, name: string) =>
    payload.create({
      collection: 'notifications',
      depth: 0,
      overrideAccess: true,
      data: {
        organization: orgId,
        name,
        type: 'discord',
        config: {
          webhookUrl: 'https://discord.com/api/webhooks/1/test',
          messageFormat: 'custom',
          messageTemplate: '{{ msg }}',
        },
        active: true,
      } as never,
    }) as Promise<Notification>
  channel = await discord(org.id, 'ops-room')
  foreignChannel = await discord(otherOrg.id, 'elsewhere')
  queue = createQueue<EscalationJobData, void, EscalationJobName>('escalations', { prefix })
  setEscalationsQueue(queue)
  setIncidentJobSink(async () => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

afterAll(async () => {
  setEscalationsQueue(null)
  setIncidentJobSink(null)
  await queue?.obliterate({ force: true })
  await queue?.close()
  await closeEmitter()
  const orgIds = [org?.id, otherOrg?.id].filter(Boolean)
  if (orgIds.length) {
    for (const collection of [
      'monitor-incidents',
      'monitors',
      'escalation-policies',
      'on-call-schedules',
      'notifications',
    ] as const) {
      await payload.delete({ collection, where: { organization: { in: orgIds } } })
    }
    await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
  }
  await payload.delete({ collection: 'users', where: { email: { like: `+oc-${run}@` } } })
})

describe('who is on call', () => {
  let schedule: OnCallScheduleSummary

  it('follows a weekly rotation at 09:00 New York time across the DST change', async () => {
    const created = await createSchedule({
      name: 'Platform',
      timezone: 'America/New_York',
      layers: [weeklyLayer()],
    })
    expect(created.response.status).toBe(201)
    schedule = created.body
    expect(schedule.layers[0].members.map((m) => m.name)).toEqual(['Ada', 'Grace', 'Linus'])

    const name = async (at: string) =>
      (await onCallAt(at)).body.schedules.find((s) => s.id === schedule.id)?.onCall?.user.name ??
      null
    // Before the first shift: nobody.
    expect(await name('2026-03-02T13:59:00Z')).toBeNull()
    expect(await name('2026-03-02T14:00:00Z')).toBe('Ada') // 09:00 EST
    // DST starts on 2026-03-08: the next handoff is 09:00 EDT = 13:00 UTC.
    expect(await name('2026-03-09T12:59:00Z')).toBe('Ada')
    expect(await name('2026-03-09T13:00:00Z')).toBe('Grace')
    expect(await name('2026-03-16T13:00:00Z')).toBe('Linus')

    const { body } = await onCallAt('2026-03-09T13:00:00Z')
    const current = body.schedules.find((s) => s.id === schedule.id)!
    expect(current.onCall).toEqual({
      user: { id: String(grace.user.id), name: 'Grace' },
      source: 'layer',
      until: '2026-03-16T13:00:00.000Z',
    })
  })

  it('overrides take precedence over the rotation', async () => {
    const response = await patchScheduleRoute(
      request(
        'PATCH',
        {
          overrides: [
            {
              user: linus.user.id,
              start: '2026-03-10T00:00:00Z',
              end: '2026-03-11T00:00:00Z',
              note: 'Holiday swap',
            },
          ],
        },
        member,
      ),
      { params: params(org.id, schedule.id) },
    )
    expect(response.status).toBe(200)
    const { body } = await onCallAt('2026-03-10T12:00:00Z')
    expect(body.schedules.find((s) => s.id === schedule.id)?.onCall).toMatchObject({
      user: { name: 'Linus' },
      source: 'override',
      until: '2026-03-11T00:00:00.000Z',
    })
    // Back to the rotation once the override ends.
    const after = await onCallAt('2026-03-11T00:00:00Z')
    expect(after.body.schedules.find((s) => s.id === schedule.id)?.onCall?.user.name).toBe('Grace')
  })

  it('lists the upcoming shifts of the signed-in member', async () => {
    const response = await shiftsRoute(
      request(
        'GET',
        undefined,
        grace,
        'http://localhost/x?from=2026-03-02T14:00:00Z&to=2026-04-06T13:00:00Z',
      ),
      { params: params(org.id) },
    )
    expect(response.status).toBe(200)
    const { shifts } = (await response.json()) as { shifts: OnCallShiftSummary[] }
    expect(shifts.map((shift) => [shift.start, shift.end])).toEqual([
      // Linus's override cuts Grace's week in two.
      ['2026-03-09T13:00:00.000Z', '2026-03-10T00:00:00.000Z'],
      ['2026-03-11T00:00:00.000Z', '2026-03-16T13:00:00.000Z'],
      ['2026-03-30T13:00:00.000Z', '2026-04-06T13:00:00.000Z'],
    ])
    expect(shifts.every((shift) => shift.user.name === 'Grace')).toBe(true)
  })
})

describe('RBAC', () => {
  it('lets viewers read but not write schedules', async () => {
    const { response } = await createSchedule(
      { name: 'Nope', timezone: 'UTC', layers: [weeklyLayer()] },
      viewer,
    )
    expect(response.status).toBe(403)
    expect((await onCallAt('2026-03-10T12:00:00Z', viewer)).response.status).toBe(200)
  })

  it('hides schedules from other organizations, on routes and the Local API', async () => {
    const { body: schedule } = await createSchedule({
      name: 'Secret',
      timezone: 'UTC',
      layers: [weeklyLayer()],
    })
    expect((await onCallAt('2026-03-10T12:00:00Z', outsider)).response.status).toBe(403)
    const get = await getScheduleRoute(request('GET', undefined, outsider), {
      params: params(otherOrg.id, schedule.id),
    })
    expect(get.status).toBe(404)
    const del = await deleteScheduleRoute(request('DELETE', undefined, outsider), {
      params: params(org.id, schedule.id),
    })
    expect(del.status).toBe(403)
    const { docs } = await payload.find({
      collection: 'on-call-schedules',
      where: { id: { equals: schedule.id } },
      user: { ...outsider.user, collection: 'users' },
      overrideAccess: false,
    })
    expect(docs).toHaveLength(0)
  })

  it('only puts members of the organization on call', async () => {
    const { response } = await createSchedule({
      name: 'With outsider',
      timezone: 'UTC',
      layers: [{ ...weeklyLayer(), members: [ada.user.id, outsider.user.id] }],
    })
    expect(response.status).toBe(400)
    const zone = await createSchedule({
      name: 'Bad zone',
      timezone: 'Mars/Olympus',
      layers: [weeklyLayer()],
    })
    expect(zone.response.status).toBe(400)
  })

  it('lets admins, not members, manage escalation policies, with targets of their organization', async () => {
    const steps = [{ escalateAfterMinutes: 5, targets: [{ type: 'channel', id: channel.id }] }]
    expect((await createPolicy({ name: 'By member', steps }, member)).response.status).toBe(403)
    expect((await createPolicy({ name: 'By admin', steps }, admin)).response.status).toBe(201)
    const foreign = await createPolicy({
      name: 'Foreign',
      steps: [{ escalateAfterMinutes: 5, targets: [{ type: 'channel', id: foreignChannel.id }] }],
    })
    expect(foreign.response.status).toBe(400)
    // Owners rank above admins.
    expect((await createPolicy({ name: 'By owner', steps }, owner)).response.status).toBe(201)
  })
})

describe('escalation', () => {
  let schedule: OnCallScheduleSummary
  let policy: EscalationPolicySummary

  beforeAll(async () => {
    schedule = (
      await createSchedule({
        name: 'Escalation rota',
        timezone: 'America/New_York',
        layers: [weeklyLayer()],
      })
    ).body
  })

  it('pages the member on call, then step 2 after 10 minutes without an acknowledgement', async () => {
    const monitor = await createMonitor('Checkout API')
    const created = await createPolicy({
      name: 'Production',
      steps: [
        { escalateAfterMinutes: 10, targets: [{ type: 'schedule', id: schedule.id }] },
        {
          escalateAfterMinutes: 10,
          targets: [
            { type: 'user', id: linus.user.id },
            { type: 'channel', id: channel.id },
          ],
        },
      ],
      monitors: [monitor.id],
    })
    expect(created.response.status).toBe(201)
    policy = created.body
    expect(policy.monitors).toEqual([{ id: String(monitor.id), name: 'Checkout API' }])

    // Thursday 2026-03-12: Grace's week.
    const t0 = new Date('2026-03-12T15:00:00Z')
    const opened = await goDown(monitor, t0)
    expect(opened.escalation).toMatchObject({ status: 'active', step: 0, round: 0 })
    expect(String(opened.escalationPolicy)).toBe(policy.id)

    // Step 1 is queued without delay.
    const first = await stepJob(opened.id, 0, 0)
    expect(first?.opts.delay ?? 0).toBe(0)
    const step1 = await processEscalationStep(payload, first!.data as EscalationStepJobData, t0)
    expect(step1.outcome).toBe('paged')
    expect(step1.targets?.map((target) => target.label)).toEqual(['Grace (Escalation rota)'])
    expect(step1.next).toEqual({ step: 1, round: 0, delayMs: 600_000 })

    // Step 2 waits ten minutes in Redis as a delayed job.
    const second = await stepJob(opened.id, 0, 1)
    expect(second?.opts.delay).toBe(600_000)
    expect(await second?.getState()).toBe('delayed')
    let doc = await incident(opened.id)
    expect(doc.escalation).toMatchObject({ status: 'active', step: 1, round: 0 })
    expect(doc.timeline?.at(-1)).toMatchObject({
      type: 'escalated',
      message: 'Grace (Escalation rota)',
    })

    // Grace is emailed with the acknowledge link.
    const sendEmail = vi.spyOn(payload, 'sendEmail').mockResolvedValue(undefined)
    const [page] = await pageJobs(opened.id)
    expect(page.data.target).toEqual({ type: 'user', id: String(grace.user.id) })
    expect(await processEscalationPage(payload, page.data)).toEqual({ outcome: 'sent' })
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: grace.user.email,
        subject: '[Marmot] Page: Checkout API is down',
        text: expect.stringMatching(/^\[Checkout API\] \[📟 Page\] .*Acknowledge: http.*\/ack\//),
      }),
    )

    // Nobody acknowledged: step 2 pages Linus and the channel, and the policy is exhausted.
    const step2 = await processEscalationStep(
      payload,
      second!.data as EscalationStepJobData,
      new Date(t0.getTime() + 600_000),
    )
    expect(step2.targets?.map((target) => target.label)).toEqual(['Linus', 'ops-room'])
    expect(step2.next).toBeNull()
    doc = await incident(opened.id)
    expect(doc.escalation?.status).toBe('exhausted')

    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push((JSON.parse(String(init?.body)) as { content: string }).content)
        return new Response('{}', { status: 200 })
      }),
    )
    const channelPage = (await pageJobs(opened.id)).find(
      (job) => job.data.target.type === 'channel',
    )
    expect(await processEscalationPage(payload, channelPage!.data)).toEqual({ outcome: 'sent' })
    expect(calls[0]).toMatch(/Checkout API is down and you are on call/)
  })

  it('repeats the policy when asked', async () => {
    const monitor = await createMonitor('Search')
    const repeated = await createPolicy({
      name: 'Repeat once',
      repeat: 1,
      steps: [{ escalateAfterMinutes: 5, targets: [{ type: 'user', id: ada.user.id }] }],
      monitors: [monitor.id],
    })
    const opened = await goDown(monitor, new Date('2026-03-12T15:00:00Z'))
    const first = await stepJob(opened.id, 0, 0)
    const result = await processEscalationStep(payload, first!.data as EscalationStepJobData)
    expect(result.next).toEqual({ step: 0, round: 1, delayMs: 300_000 })
    const again = await stepJob(opened.id, 1, 0)
    expect(again?.opts.delay).toBe(300_000)
    expect((await processEscalationStep(payload, again!.data as EscalationStepJobData)).next).toBe(
      null,
    )
    expect(repeated.body.repeat).toBe(1)
  })

  it('stops on acknowledgement: the pending step is removed and queued pages are dropped', async () => {
    const monitor = await createMonitor('Payments')
    const patched = await patchPolicyRoute(
      request('PATCH', { monitors: [...policy.monitors.map((m) => m.id), monitor.id] }, admin),
      { params: params(org.id, policy.id) },
    )
    expect(patched.status).toBe(200)

    const t0 = new Date('2026-03-12T16:00:00Z')
    const opened = await goDown(monitor, t0)
    await processEscalationStep(
      payload,
      (await stepJob(opened.id, 0, 0))!.data as EscalationStepJobData,
      t0,
    )
    const pending = await stepJob(opened.id, 0, 1)
    expect(await pending?.getState()).toBe('delayed')

    // A worker restart: a fresh queue connection still finds the delayed step in Redis.
    const reopened = createQueue<EscalationJobData, void, EscalationJobName>('escalations', {
      prefix,
    })
    expect(await (await reopened.getJob(pending!.id!))?.getState()).toBe('delayed')
    await reopened.close()

    const acked = await acknowledge(payload, await incident(opened.id), {
      userId: grace.user.id,
      via: 'dashboard',
    })
    expect(acked.status).toBe('acknowledged')
    expect(await stepJob(opened.id, 0, 1)).toBeUndefined()
    const doc = await incident(opened.id)
    expect(doc.escalation).toMatchObject({ status: 'stopped', nextAt: null })

    // A job that slipped through pages nobody.
    const sendEmail = vi.spyOn(payload, 'sendEmail').mockResolvedValue(undefined)
    expect(
      (await processEscalationStep(payload, pending!.data as EscalationStepJobData)).outcome,
    ).toBe('stopped')
    const [page] = await pageJobs(opened.id)
    expect(await processEscalationPage(payload, page.data)).toEqual({
      outcome: 'skipped',
      reason: 'not-open',
    })
    expect(sendEmail).not.toHaveBeenCalled()
    expect(
      (await incident(opened.id)).timeline?.filter((row) => row.type === 'escalated'),
    ).toHaveLength(1)
  })

  it('monitors without a policy do not escalate', async () => {
    const monitor = await createMonitor('Quiet')
    const opened = await goDown(monitor, new Date())
    expect(opened.escalation?.status ?? null).toBeNull()
    expect(await stepJob(opened.id, 0, 0)).toBeUndefined()
  })
})
