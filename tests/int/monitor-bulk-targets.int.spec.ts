import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import type { Role } from '@/access/permissions'
import { POST as bulkRoute } from '@/app/api/orgs/[orgId]/monitors/bulk/route'
import { env } from '@/env'
import type { BulkResponse } from '@/lib/monitor-bulk'
import { defaultMonitorValues } from '@/lib/validation/monitor'
import type {
  AuditLog,
  Maintenance,
  Monitor,
  Organization,
  StatusPage,
  User,
} from '@/payload-types'
import { monitorBulkBody } from '@/server/monitors/bulk-schema'

/**
 * Bulk "add to maintenance window" and "add to status page group" (#262) on
 * `POST /api/orgs/:orgId/monitors/bulk`: permissions on the monitors and on the target (with
 * organization overrides), one write of the target as the user, `unchanged` for monitors already
 * there, targets of another organization and unknown groups.
 */
let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+bulkt-${run}@marmot.test`
const PASSWORD = 'password-123'

type Session = { user: User; cookie: string }
type Id = string | number

async function createMember(name: string, org: Organization, role: Role): Promise<Session> {
  const user = await payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name },
  })
  await addOrgMembership({ payload, userId: user.id, orgId: org.id, role })
  const { token } = await payload.login({
    collection: 'users',
    data: { email: email(name), password: PASSWORD },
  })
  return { user, cookie: `payload-token=${token}` }
}

async function bulk(org: Organization, body: unknown, session?: Session) {
  const request = new Request(`http://localhost/api/orgs/${String(org.id)}/monitors/bulk`, {
    method: 'POST',
    headers: {
      Origin: env.NEXT_PUBLIC_SERVER_URL,
      'content-type': 'application/json',
      ...(session ? { cookie: session.cookie } : {}),
    },
    body: JSON.stringify(body),
  })
  const res = await bulkRoute(request, { params: Promise.resolve({ orgId: String(org.id) }) })
  return { status: res.status, body: (await res.json()) as BulkResponse & { error?: string } }
}

async function createMonitor(org: Organization, name: string): Promise<Monitor> {
  return payload.create({
    collection: 'monitors',
    data: {
      ...defaultMonitorValues('http'),
      name,
      url: 'http://localhost:3000/api/health',
      organization: org.id,
      active: true,
    } as never,
    depth: 0,
  })
}

async function createWindow(org: Organization, title: string, monitors: Id[] = []) {
  return (await payload.create({
    collection: 'maintenance',
    data: {
      organization: org.id,
      title,
      strategy: 'manual',
      active: false,
      monitors,
    } as never,
    depth: 0,
  })) as Maintenance
}

async function createPage(org: Organization, slug: string, monitors: Id[] = []) {
  return (await payload.create({
    collection: 'status-pages',
    data: {
      organization: org.id,
      title: slug,
      slug: `${slug}-${run}`,
      groups: [
        { name: 'Core', monitors: monitors.map((monitor) => ({ monitor })) },
        { name: 'Edge', monitors: [{ type: 'static', name: 'CDN' }] },
      ],
    } as never,
    depth: 0,
  })) as StatusPage
}

const ids = (values: unknown[] | null | undefined) =>
  (values ?? []).map((value) =>
    String(value && typeof value === 'object' ? (value as { id: Id }).id : value),
  )

const windowMonitors = async (id: Id) =>
  ids((await payload.findByID({ collection: 'maintenance', id, depth: 0 })).monitors)

const reloadPage = (id: Id) => payload.findByID({ collection: 'status-pages', id, depth: 0 })

const resultOf = (response: BulkResponse, id: Id) =>
  response.results.find((result) => result.id === String(id))

async function setOverrides(org: Organization, overrides: Record<string, string>) {
  await payload.update({
    collection: 'organizations',
    id: org.id,
    data: { permissionOverrides: overrides } as never,
  })
}

let orgA: Organization
let orgB: Organization
let member: Session
let viewer: Session

describe('bulk add to maintenance windows and status page groups', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    orgA = await payload.create({
      collection: 'organizations',
      data: { name: 'Bulk targets A', slug: `bulkt-a-${run}` },
    })
    orgB = await payload.create({
      collection: 'organizations',
      data: { name: 'Bulk targets B', slug: `bulkt-b-${run}` },
    })
    member = await createMember('member', orgA, 'member')
    viewer = await createMember('viewer', orgA, 'viewer')
  })

  afterAll(async () => {
    const orgIds = [orgA?.id, orgB?.id].filter(Boolean)
    if (orgIds.length) {
      const where = { organization: { in: orgIds } }
      await payload.delete({ collection: 'maintenance-occurrences', where })
      await payload.delete({ collection: 'maintenance', where })
      await payload.delete({ collection: 'status-pages', where })
      await payload.delete({ collection: 'monitors', where })
      await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
    }
    await payload.delete({
      collection: 'users',
      where: { email: { like: `+bulkt-${run}@marmot.test` } },
    })
  })

  it('validates the body', () => {
    const parse = (body: unknown) => monitorBulkBody.safeParse(body).success
    expect(parse({ ids: [1], action: 'addToMaintenance' })).toBe(false)
    expect(parse({ ids: [1], action: 'addToMaintenance', payload: { maintenance: 4 } })).toBe(true)
    expect(parse({ ids: [1], action: 'addToStatusPageGroup', payload: { statusPage: 2 } })).toBe(
      false,
    )
    expect(
      parse({
        ids: ['a'],
        action: 'addToStatusPageGroup',
        payload: { statusPage: 'p', group: 'g' },
      }),
    ).toBe(true)
  })

  it('adds the selection to a maintenance window in one write, reporting unchanged monitors', async () => {
    const monitors = await Promise.all(
      Array.from({ length: 10 }, (_, i) => createMonitor(orgA, `window ${i}`)),
    )
    const foreign = await createMonitor(orgB, 'foreign')
    const window = await createWindow(orgA, 'Database upgrade', [monitors[0].id])

    const response = await bulk(
      orgA,
      {
        ids: [...monitors.map((monitor) => monitor.id), foreign.id],
        action: 'addToMaintenance',
        payload: { maintenance: window.id },
      },
      member,
    )
    expect(response.status).toBe(200)
    expect(response.body.summary).toEqual({ changed: 9, unchanged: 1, failed: 1 })
    expect(resultOf(response.body, monitors[0].id)).toMatchObject({ ok: true, unchanged: true })
    expect(resultOf(response.body, monitors[1].id)).toEqual({
      id: String(monitors[1].id),
      ok: true,
    })
    expect(resultOf(response.body, foreign.id)).toMatchObject({ ok: false, error: 'notFound' })

    const stored = await windowMonitors(window.id)
    expect(stored).toHaveLength(10)
    expect(new Set(stored)).toEqual(new Set(monitors.map((monitor) => String(monitor.id))))

    // One audit row for the window, by the member, tagged as a bulk action.
    const { docs } = await payload.find({
      collection: 'audit-logs',
      where: {
        and: [
          { entityType: { equals: 'maintenance' } },
          { entityId: { equals: String(window.id) } },
        ],
      },
      depth: 0,
    })
    const updates = (docs as AuditLog[]).filter((row) => row.action === 'maintenance.updated')
    expect(updates).toHaveLength(1)
    expect(String(updates[0].actor)).toBe(String(member.user.id))
    expect(updates[0].metadata).toMatchObject({ bulk: { action: 'addToMaintenance', count: 11 } })

    // Again: everything is already there, nothing is written.
    const again = await bulk(
      orgA,
      { ids: [monitors[2].id], action: 'addToMaintenance', payload: { maintenance: window.id } },
      member,
    )
    expect(again.body.summary).toEqual({ changed: 0, unchanged: 1, failed: 0 })
  })

  it('adds the selection to a status page group, keeping the other groups', async () => {
    const one = await createMonitor(orgA, 'page one')
    const two = await createMonitor(orgA, 'page two')
    const page = await createPage(orgA, 'bulk-page', [one.id])
    const [core, edge] = page.groups!

    const response = await bulk(
      orgA,
      {
        ids: [one.id, two.id],
        action: 'addToStatusPageGroup',
        payload: { statusPage: page.id, group: core.id },
      },
      member,
    )
    expect(response.status).toBe(200)
    expect(response.body.summary).toEqual({ changed: 1, unchanged: 1, failed: 0 })

    const stored = await reloadPage(page.id)
    expect(stored.groups).toHaveLength(2)
    expect(stored.groups![0].id).toBe(core.id)
    expect(stored.groups![0].monitors?.map((row) => String(row.monitor))).toEqual([
      String(one.id),
      String(two.id),
    ])
    expect(stored.groups![0].monitors?.[1]).toMatchObject({ type: 'monitor', showValues: true })
    expect(stored.groups![1]).toMatchObject({ id: edge.id, name: 'Edge' })
    expect(stored.groups![1].monitors).toHaveLength(1)
    expect(stored.groups![1].monitors?.[0]).toMatchObject({ type: 'static', name: 'CDN' })

    // The static component of another group does not count: the monitor is added there too.
    const toEdge = await bulk(
      orgA,
      {
        ids: [one.id],
        action: 'addToStatusPageGroup',
        payload: { statusPage: page.id, group: edge.id },
      },
      member,
    )
    expect(toEdge.body.summary).toEqual({ changed: 1, unchanged: 0, failed: 0 })
    expect((await reloadPage(page.id)).groups![1].monitors).toHaveLength(2)
  })

  it('answers 404 for targets of another organization and unknown groups', async () => {
    const monitor = await createMonitor(orgA, 'target checks')
    const foreignWindow = await createWindow(orgB, 'Foreign window')
    const foreignPage = await createPage(orgB, 'bulk-foreign')
    const page = await createPage(orgA, 'bulk-groups')

    const window = await bulk(
      orgA,
      { ids: [monitor.id], action: 'addToMaintenance', payload: { maintenance: foreignWindow.id } },
      member,
    )
    expect(window.status).toBe(404)
    expect(await windowMonitors(foreignWindow.id)).toEqual([])

    const otherPage = await bulk(
      orgA,
      {
        ids: [monitor.id],
        action: 'addToStatusPageGroup',
        payload: { statusPage: foreignPage.id, group: foreignPage.groups![0].id },
      },
      member,
    )
    expect(otherPage.status).toBe(404)
    expect((await reloadPage(foreignPage.id)).groups![0].monitors ?? []).toHaveLength(0)

    const missingGroup = await bulk(
      orgA,
      {
        ids: [monitor.id],
        action: 'addToStatusPageGroup',
        payload: { statusPage: page.id, group: 'no-such-group' },
      },
      member,
    )
    expect(missingGroup.status).toBe(404)
  })

  it('refuses anonymous users, viewers and members without the target permission', async () => {
    const monitor = await createMonitor(orgA, 'rbac')
    const window = await createWindow(orgA, 'RBAC window')
    const page = await createPage(orgA, 'bulk-rbac')
    const toWindow = {
      ids: [monitor.id],
      action: 'addToMaintenance',
      payload: { maintenance: window.id },
    }
    const toPage = {
      ids: [monitor.id],
      action: 'addToStatusPageGroup',
      payload: { statusPage: page.id, group: page.groups![0].id },
    }

    expect((await bulk(orgA, toWindow)).status).toBe(401)
    expect((await bulk(orgA, toWindow, viewer)).status).toBe(403)
    expect((await bulk(orgA, toPage, viewer)).status).toBe(403)

    // The target's permission raised above the member role: refused, though monitor:update holds.
    await setOverrides(orgA, { 'maintenance:update': 'admin', 'status-page:update': 'admin' })
    try {
      expect((await bulk(orgA, toWindow, member)).status).toBe(403)
      expect((await bulk(orgA, toPage, member)).status).toBe(403)
    } finally {
      await setOverrides(orgA, {})
    }

    // The monitors' permission raised: refused as well, though the target permission holds.
    await setOverrides(orgA, { 'monitor:update': 'admin' })
    try {
      expect((await bulk(orgA, toWindow, member)).status).toBe(403)
      expect((await bulk(orgA, toPage, member)).status).toBe(403)
    } finally {
      await setOverrides(orgA, {})
    }

    expect(await windowMonitors(window.id)).toEqual([])
    expect((await reloadPage(page.id)).groups![0].monitors ?? []).toHaveLength(0)

    const allowed = await bulk(orgA, toWindow, member)
    expect(allowed.body.summary).toEqual({ changed: 1, unchanged: 0, failed: 0 })
  })
})
