import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import type { Role } from '@/access/permissions'
import { POST as createMonitor } from '@/app/api/orgs/[orgId]/monitors/route'
import { PATCH as updateMonitor } from '@/app/api/orgs/[orgId]/monitors/[id]/route'
import { POST as cloneMonitor } from '@/app/api/orgs/[orgId]/monitors/[id]/clone/route'
import {
  GET as getChannelMonitors,
  PUT as setChannelMonitors,
} from '@/app/api/orgs/[orgId]/notifications/[id]/monitors/route'
import { GET as exportRoute } from '@/app/api/orgs/[orgId]/export/route'
import { POST as importRoute } from '@/app/api/orgs/[orgId]/import/route'
import type { ChannelMonitorRow } from '@/components/notifications/types'
import { env } from '@/env'
import { defaultMonitorValues, monitorToFormValues } from '@/lib/validation/monitor'
import type { Monitor, Notification, Organization, User } from '@/payload-types'
import type { MarmotExport } from '@/server/import-export/marmot'
import { getMonitorNotifications } from '@/server/notifications/dispatch'

/**
 * Notification channels of a monitor: the picker's route handlers (create, edit, clone), the
 * channel-side "Monitors" endpoint, access control and the export → import round trip.
 */

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+mnp-${run}@marmot.test`
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

/** Browser-like request: Payload only honours the cookie when `Origin` passes its CSRF allowlist. */
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

const httpMonitor = (name: string) => ({
  ...defaultMonitorValues('http'),
  name,
  url: 'http://localhost:3000/api/health',
})

const idOf = (value: unknown): string =>
  String(
    value && typeof value === 'object' && 'id' in value ? (value as { id: unknown }).id : value,
  )

const channelIdsOf = (monitor: Pick<Monitor, 'notifications'>) =>
  (monitor.notifications ?? []).map(idOf).sort()

const sorted = (...ids: (string | number)[]) => ids.map(String).sort()

let orgA: Organization
let orgB: Organization
let owner: Session
let member: Session
let viewer: Session
let slack: Notification
let mail: Notification
let byDefault: Notification
let paused: Notification
let foreign: Notification

const channel = (org: Organization, name: string, extra: Partial<Notification> = {}) =>
  payload.create({
    collection: 'notifications',
    data: {
      organization: org.id,
      name,
      type: 'webhook',
      config: { url: 'https://hooks.example.com/marmot', method: 'POST', contentType: 'json' },
      active: true,
      ...extra,
    } as never,
    depth: 0,
  }) as Promise<Notification>

async function create(body: Record<string, unknown>, session: Session = member) {
  return createMonitor(request('POST', body, session), { params: params(orgA.id) })
}

async function load(id: string | number) {
  return (await payload.findByID({ collection: 'monitors', id, depth: 0 })) as Monitor
}

describe('monitor notification channels', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    const mk = (name: string, slug: string) =>
      payload.create({ collection: 'organizations', data: { name, slug: `${slug}-${run}` } })
    orgA = await mk('Picker A', 'mnp-a')
    orgB = await mk('Picker B', 'mnp-b')
    owner = await createMember('owner', [
      [orgA, 'owner'],
      [orgB, 'owner'],
    ])
    member = await createMember('member', [[orgA, 'member']])
    viewer = await createMember('viewer', [[orgA, 'viewer']])

    slack = await channel(orgA, 'Ops Slack')
    mail = await channel(orgA, 'On-call mail')
    byDefault = await channel(orgA, 'Default hook', { isDefault: true })
    paused = await channel(orgA, 'Paused hook', { active: false })
    foreign = await channel(orgB, 'Other org hook')
  })

  afterAll(async () => {
    const orgIds = [orgA?.id, orgB?.id].filter(Boolean)
    if (orgIds.length) {
      await payload.delete({ collection: 'monitors', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'notifications', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
    }
    await payload.delete({
      collection: 'users',
      where: { email: { like: `+mnp-${run}@marmot.test` } },
    })
  })

  describe('monitor routes', () => {
    it('creates a monitor with exactly the selected channels, and only those are alerted', async () => {
      const res = await create({
        ...httpMonitor('Picked'),
        notifications: [slack.id, mail.id],
      })
      expect(res.status).toBe(201)
      const doc = (await res.json()) as Monitor
      // The default channel is not added on top of an explicit selection.
      expect(channelIdsOf(doc)).toEqual(sorted(slack.id, mail.id))

      const alerted = await getMonitorNotifications(payload, await load(doc.id))
      expect(alerted.map((n) => String(n.id)).sort()).toEqual(sorted(slack.id, mail.id))
    })

    it('keeps an explicitly empty selection empty', async () => {
      const res = await create({ ...httpMonitor('Silent'), notifications: [] })
      expect(res.status).toBe(201)
      expect(((await res.json()) as Monitor).notifications ?? []).toEqual([])
    })

    it('attaches the default channels when the body has no notifications key', async () => {
      const { notifications: _omit, ...body } = httpMonitor('Defaults')
      const res = await create(body)
      expect(res.status).toBe(201)
      expect(channelIdsOf((await res.json()) as Monitor)).toEqual(sorted(byDefault.id))
    })

    it('refuses channels of another organization and duplicates', async () => {
      const cross = await create({ ...httpMonitor('Cross'), notifications: [foreign.id] })
      expect(cross.status).toBe(400)
      expect(JSON.stringify(await cross.json())).toContain('notifications')

      const dup = await create({ ...httpMonitor('Dup'), notifications: [slack.id, slack.id] })
      expect(dup.status).toBe(400)
      expect(JSON.stringify(await dup.json())).toContain('notifications')
    })

    it('edits the selection; the next transition uses the new channels', async () => {
      const created = (await (
        await create({ ...httpMonitor('Edited'), notifications: [slack.id] })
      ).json()) as Monitor

      const res = await updateMonitor(
        request('PATCH', { notifications: [mail.id, paused.id] }, member),
        { params: params(orgA.id, created.id) },
      )
      expect(res.status).toBe(200)
      const stored = await load(created.id)
      expect(channelIdsOf(stored)).toEqual(sorted(mail.id, paused.id))
      // Paused channels stay attached but are skipped when alerting.
      const alerted = await getMonitorNotifications(payload, stored)
      expect(alerted.map((n) => String(n.id))).toEqual([String(mail.id)])

      // A partial PATCH without `notifications` keeps them.
      const rename = await updateMonitor(request('PATCH', { name: 'Edited 2' }, member), {
        params: params(orgA.id, created.id),
      })
      expect(rename.status).toBe(200)
      expect(channelIdsOf(await load(created.id))).toEqual(sorted(mail.id, paused.id))

      // The form round-trips the stored selection.
      expect(monitorToFormValues(stored).notifications.map(String).sort()).toEqual(
        sorted(mail.id, paused.id),
      )
    })

    it('viewers may not change the channels of a monitor', async () => {
      const created = (await (
        await create({ ...httpMonitor('Viewer target'), notifications: [slack.id] })
      ).json()) as Monitor
      const res = await updateMonitor(request('PATCH', { notifications: [] }, viewer), {
        params: params(orgA.id, created.id),
      })
      expect(res.status).toBe(403)
      expect(channelIdsOf(await load(created.id))).toEqual(sorted(slack.id))
    })

    it('clone keeps the channels (and adds no default channel)', async () => {
      const created = (await (
        await create({ ...httpMonitor('Clone source'), notifications: [mail.id] })
      ).json()) as Monitor
      const res = await cloneMonitor(request('POST', undefined, member), {
        params: params(orgA.id, created.id),
      })
      expect(res.status).toBe(201)
      const copy = (await res.json()) as Monitor
      expect(copy.name).toBe('Clone source (copy)')
      expect(channelIdsOf(copy)).toEqual(sorted(mail.id))

      const empty = (await (
        await create({ ...httpMonitor('Clone empty'), notifications: [] })
      ).json()) as Monitor
      const emptyCopy = (await (
        await cloneMonitor(request('POST', undefined, member), {
          params: params(orgA.id, empty.id),
        })
      ).json()) as Monitor
      expect(emptyCopy.notifications ?? []).toEqual([])
    })

    it('drops ids of deleted channels instead of failing the save', async () => {
      const gone = await channel(orgA, 'Short-lived hook')
      const created = (await (
        await create({ ...httpMonitor('Stale'), notifications: [slack.id, gone.id] })
      ).json()) as Monitor
      await payload.delete({ collection: 'notifications', id: gone.id })
      const res = await updateMonitor(
        request('PATCH', { notifications: [slack.id, gone.id] }, member),
        { params: params(orgA.id, created.id) },
      )
      expect(res.status).toBe(200)
      expect(channelIdsOf(await load(created.id))).toEqual(sorted(slack.id))
    })
  })

  describe('channel → monitors endpoint', () => {
    const url = (id: string | number) =>
      `http://localhost/api/orgs/${orgA.id}/notifications/${id}/monitors`
    const get = (id: string | number, session?: Session, org: Organization = orgA) =>
      getChannelMonitors(request('GET', undefined, session, url(id)), {
        params: params(org.id, id),
      })
    const put = (
      id: string | number,
      monitors: unknown,
      session?: Session,
      org: Organization = orgA,
    ) =>
      setChannelMonitors(request('PUT', { monitors }, session, url(id)), {
        params: params(org.id, id),
      })

    let first: Monitor
    let second: Monitor

    beforeAll(async () => {
      first = (await (
        await create({ ...httpMonitor('Channel side 1'), notifications: [slack.id] })
      ).json()) as Monitor
      second = (await (
        await create({ ...httpMonitor('Channel side 2'), notifications: [] })
      ).json()) as Monitor
    })

    it('lists the monitors with their attachment for members, not for viewers', async () => {
      expect((await get(slack.id)).status).toBe(401)
      expect((await get(slack.id, viewer)).status).toBe(403)

      const res = await get(slack.id, member)
      expect(res.status).toBe(200)
      const { monitors } = (await res.json()) as { monitors: ChannelMonitorRow[] }
      const row = (m: Monitor) => monitors.find((r) => r.id === String(m.id))
      expect(row(first)).toMatchObject({ name: 'Channel side 1', attached: true })
      expect(row(second)).toMatchObject({ name: 'Channel side 2', attached: false })
    })

    it('only admins attach and detach', async () => {
      expect((await put(slack.id, [second.id], viewer)).status).toBe(403)
      expect((await put(slack.id, [second.id], member)).status).toBe(403)
      expect(channelIdsOf(await load(first.id))).toEqual(sorted(slack.id))
    })

    it('sets the monitors of the channel, keeping their other channels', async () => {
      // Give `first` a second channel so the detach must leave it alone.
      await payload.update({
        collection: 'monitors',
        id: first.id,
        data: { notifications: [slack.id, mail.id] as never },
        context: { skipEngineSync: true },
      })
      const res = await put(slack.id, [String(second.id)], owner)
      expect(res.status).toBe(200)
      const { monitors } = (await res.json()) as { monitors: ChannelMonitorRow[] }
      expect(monitors.find((r) => r.id === String(first.id))?.attached).toBe(false)
      expect(monitors.find((r) => r.id === String(second.id))?.attached).toBe(true)
      expect(channelIdsOf(await load(first.id))).toEqual(sorted(mail.id))
      expect(channelIdsOf(await load(second.id))).toEqual(sorted(slack.id))
    })

    it('rejects unknown monitors and channels of another organization', async () => {
      const otherMonitor = await payload.create({
        collection: 'monitors',
        data: { ...httpMonitor('Other org monitor'), organization: orgB.id } as never,
        depth: 0,
        context: { skipEngineSync: true },
      })
      const res = await put(slack.id, [otherMonitor.id], owner)
      expect(res.status).toBe(400)
      expect((await put(slack.id, 'nope', owner)).status).toBe(400)
      // The channel id belongs to orgB: not found through orgA's URL.
      expect((await get(foreign.id, owner)).status).toBe(404)
      expect((await put(foreign.id, [], owner)).status).toBe(404)
    })
  })

  describe('export → import', () => {
    it('round-trips the channel selection into another organization', async () => {
      const source = (await (
        await create({ ...httpMonitor('Round trip'), notifications: [mail.id] })
      ).json()) as Monitor

      const exported = await exportRoute(
        request('GET', undefined, owner, `http://localhost/api/orgs/${orgA.id}/export`),
        { params: Promise.resolve({ orgId: String(orgA.id) }) },
      )
      expect(exported.status).toBe(200)
      const file = (await exported.json()) as MarmotExport
      const entry = file.monitors.find((m) => String(m.id) === String(source.id))!
      expect(entry.notifications.map(String)).toEqual([String(mail.id)])

      const target = await payload.create({
        collection: 'organizations',
        data: { name: 'Picker C', slug: `mnp-c-${run}` },
      })
      await addOrgMembership({ payload, userId: owner.user.id, orgId: target.id, role: 'owner' })
      try {
        const imported = await importRoute(
          request('POST', file, owner, `http://localhost/api/orgs/${target.id}/import`),
          { params: Promise.resolve({ orgId: String(target.id) }) },
        )
        expect(imported.status).toBe(201)

        const [copy] = (
          await payload.find({
            collection: 'monitors',
            where: {
              and: [{ organization: { equals: target.id } }, { name: { equals: 'Round trip' } }],
            },
            depth: 1,
          })
        ).docs as Monitor[]
        const channels = (copy.notifications ?? []) as Notification[]
        expect(channels.map((n) => n.name)).toEqual(['On-call mail'])
        expect(idOf(channels[0].organization)).toBe(String(target.id))
      } finally {
        await payload.delete({
          collection: 'monitors',
          where: { organization: { equals: target.id } },
        })
        await payload.delete({
          collection: 'notifications',
          where: { organization: { equals: target.id } },
        })
        await payload.delete({ collection: 'organizations', id: target.id })
      }
    })
  })
})
