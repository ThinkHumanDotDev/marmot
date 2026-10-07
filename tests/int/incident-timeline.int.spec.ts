import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { POST as createIncidentRoute } from '@/app/api/orgs/[orgId]/status-pages/[id]/incidents/route'
import { PATCH as patchIncidentRoute } from '@/app/api/orgs/[orgId]/status-pages/[id]/incidents/[incidentId]/route'
import {
  GET as listUpdatesRoute,
  POST as postUpdateRoute,
} from '@/app/api/orgs/[orgId]/status-pages/[id]/incidents/[incidentId]/updates/route'
import { PATCH as editUpdateRoute } from '@/app/api/orgs/[orgId]/status-pages/[id]/incidents/[incidentId]/updates/[updateId]/route'
import { GET as publicRoute } from '@/app/api/status-pages/[slug]/public/route'
import { GET as rssRoute } from '@/app/status/[slug]/rss/route'
import {
  onIncidentUpdatePosted,
  type IncidentUpdatePostedEvent,
} from '@/server/status-pages/incident-events'
import type { PublicStatusPageData } from '@/server/status-pages/public'
import type { Incident, Monitor, Organization, StatusPage, User } from '@/payload-types'

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+tl-${run}@marmot.test`
const PASSWORD = 'password-123'

const MONITOR_DEFAULTS = {
  type: 'manual' as const,
  active: true,
  interval: 60,
  retryInterval: 60,
  maxRetries: 0,
  resendInterval: 0,
  timeout: 48,
}

let owner: User
let viewer: User
let org: Organization
let api: Monitor
let website: Monitor
let unlisted: Monitor
let page: StatusPage
let ownerToken: string
let viewerToken: string
const events: IncidentUpdatePostedEvent[] = []
let unsubscribe: () => void

async function login(user: User): Promise<string> {
  const { token } = await payload.login({
    collection: 'users',
    data: { email: user.email, password: PASSWORD },
  })
  return token as string
}

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>

async function call(
  handler: unknown,
  method: string,
  params: Record<string, string>,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (token) headers.set('authorization', `JWT ${token}`)
  const res = await (handler as Handler)(
    new Request('http://localhost/api/test', {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve(params) },
  )
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

async function publicData(): Promise<PublicStatusPageData> {
  const res = await (publicRoute as unknown as Handler)(new Request('http://localhost/x'), {
    params: Promise.resolve({ slug: page.slug }),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as PublicStatusPageData
}

const monitorRow = (data: PublicStatusPageData, monitor: Monitor) =>
  data.groups.flatMap((g) => g.monitors).find((m) => m.id === String(monitor.id))

/** Writes the row as it looked before the timeline existed, bypassing hooks. */
async function stripTimeline(id: Incident['id']) {
  const doc = await payload.findByID({ collection: 'incidents', id, depth: 0 })
  await payload.db.updateOne({
    collection: 'incidents',
    id,
    data: { ...doc, updates: [], affectedMonitors: [], status: null, impact: null },
    req: {} as never,
  })
}

const pageParams = () => ({ orgId: String(org.id), id: String(page.id) })

describe('incident timeline', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    unsubscribe = onIncidentUpdatePosted((event) => {
      events.push(event)
    })

    owner = await payload.create({
      collection: 'users',
      data: { email: email('owner'), password: PASSWORD, name: 'Owner' },
    })
    viewer = await payload.create({
      collection: 'users',
      data: { email: email('viewer'), password: PASSWORD, name: 'Viewer' },
    })
    org = await payload.create({
      collection: 'organizations',
      data: { name: 'TL Acme', slug: `tl-acme-${run}` },
      user: { ...owner, collection: 'users' },
      overrideAccess: false,
    })
    const fresh = await payload.findByID({ collection: 'users', id: viewer.id, depth: 0 })
    await payload.update({
      collection: 'users',
      id: viewer.id,
      data: {
        organizations: [
          ...(fresh.organizations ?? []).map((row) => ({
            id: row.id,
            organization:
              typeof row.organization === 'object' ? row.organization.id : row.organization,
            role: row.role,
          })),
          { organization: org.id, role: 'viewer' },
        ],
      },
    })

    const status = { lastStatus: 'up' as const, lastCheckAt: new Date().toISOString() }
    api = await payload.create({
      collection: 'monitors',
      data: { ...MONITOR_DEFAULTS, name: 'API', organization: org.id, status },
    })
    website = await payload.create({
      collection: 'monitors',
      data: { ...MONITOR_DEFAULTS, name: 'Website', organization: org.id, status },
    })
    unlisted = await payload.create({
      collection: 'monitors',
      data: { ...MONITOR_DEFAULTS, name: 'Unlisted', organization: org.id, status },
    })

    page = await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'TL Status',
        slug: `tl-${run}`,
        published: true,
        groups: [{ name: 'Core', monitors: [{ monitor: api.id }, { monitor: website.id }] }],
      },
    })

    ownerToken = await login(owner)
    viewerToken = await login(viewer)
  })

  afterAll(async () => {
    unsubscribe?.()
    if (org?.id) {
      await payload.delete({ collection: 'incidents', where: { organization: { equals: org.id } } })
      await payload.delete({
        collection: 'status-pages',
        where: { organization: { equals: org.id } },
      })
      await payload.delete({ collection: 'monitors', where: { organization: { equals: org.id } } })
      await payload.delete({ collection: 'organizations', id: org.id })
    }
    await payload.delete({ collection: 'users', where: { email: { like: `+tl-${run}@` } } })
  })

  it('follows an incident from a major outage of "API" to resolved', async () => {
    events.length = 0

    // Open: API major outage.
    const opened = await call(createIncidentRoute, 'POST', pageParams(), ownerToken, {
      title: 'API outage',
      status: 'investigating',
      message: 'We are **looking** into errors.',
      components: [{ monitor: api.id, impact: 'major_outage' }],
    })
    expect(opened.status).toBe(201)
    const incident = opened.json.doc as Incident
    expect(incident.status).toBe('investigating')
    expect(incident.impact).toBe('major_outage')
    expect(incident.active).toBe(true)
    expect(incident.updates).toHaveLength(1)
    expect(incident.affectedMonitors).toEqual([
      expect.objectContaining({ monitor: api.id, impact: 'major_outage' }),
    ])

    let data = await publicData()
    expect(monitorRow(data, api)?.impact).toBe('major_outage')
    expect(monitorRow(data, website)?.impact).toBeUndefined()
    // API counts as down, Website is up.
    expect(data.overall).toBe('partial')
    expect(data.incidents[0]).toMatchObject({
      title: 'API outage',
      status: 'investigating',
      impact: 'major_outage',
      style: 'danger',
      content: 'We are **looking** into errors.',
      components: [{ id: String(api.id), name: 'API', impact: 'major_outage' }],
    })

    const params = { ...pageParams(), incidentId: String(incident.id) }

    // Identified: components left out keep their impact.
    const identified = await call(postUpdateRoute, 'POST', params, ownerToken, {
      status: 'identified',
      message: 'A bad deploy.',
    })
    expect(identified.status).toBe(201)
    expect((identified.json.update as { status: string }).status).toBe('identified')
    expect((identified.json.doc as Incident).impact).toBe('major_outage')
    data = await publicData()
    expect(monitorRow(data, api)?.impact).toBe('major_outage')

    // Monitoring: API recovers to degraded performance.
    const monitoring = await call(postUpdateRoute, 'POST', params, ownerToken, {
      status: 'monitoring',
      message: 'Rolled back; watching.',
      components: [{ monitor: String(api.id), impact: 'degraded_performance' }],
    })
    expect(monitoring.status).toBe(201)
    data = await publicData()
    expect(monitorRow(data, api)?.impact).toBe('degraded_performance')
    expect(data.overall).toBe('partial')

    // Resolved: everything back to operational, unpinned, gone from the active list.
    const resolved = await call(postUpdateRoute, 'POST', params, ownerToken, {
      status: 'resolved',
      message: 'All good.',
    })
    expect(resolved.status).toBe(201)
    const done = resolved.json.doc as Incident
    expect(done).toMatchObject({ status: 'resolved', impact: 'operational', active: false })
    expect(done.pinned).toBe(false)
    expect(done.resolvedAt).toBe((resolved.json.update as { postedAt: string }).postedAt)
    expect(done.affectedMonitors).toEqual([
      expect.objectContaining({ monitor: api.id, impact: 'operational' }),
    ])
    data = await publicData()
    expect(monitorRow(data, api)?.impact).toBeUndefined()
    expect(data.overall).toBe('up')
    expect(data.incidents.find((i) => i.id === String(incident.id))).toBeUndefined()

    // The timeline, oldest first, with timestamps.
    const timeline = await call(listUpdatesRoute, 'GET', params, viewerToken)
    expect(timeline.status).toBe(200)
    const updates = timeline.json.docs as { status: string; postedAt: string }[]
    expect(updates.map((u) => u.status)).toEqual([
      'investigating',
      'identified',
      'monitoring',
      'resolved',
    ])
    const times = updates.map((u) => Date.parse(u.postedAt))
    expect(times.every((t, i) => i === 0 || t >= times[i - 1])).toBe(true)

    // Subscriber hook (#104) saw every update once.
    const mine = events.filter((e) => String(e.incident.id) === String(incident.id))
    expect(mine.map((e) => e.kind)).toEqual(['opened', 'updated', 'updated', 'resolved'])
    expect(mine.map((e) => e.update.status)).toEqual([
      'investigating',
      'identified',
      'monitoring',
      'resolved',
    ])

    // RSS: one item per update.
    const rss = await (rssRoute as unknown as Handler)(
      new Request(`http://localhost/status/${page.slug}/rss`),
      { params: Promise.resolve({ slug: page.slug }) },
    )
    const xml = await rss.text()
    expect(xml).toContain('<title>API outage</title>')
    expect(xml).toContain('<title>[Identified] API outage</title>')
    expect(xml).toContain('<title>[Monitoring] API outage</title>')
    expect(xml).toContain('<title>[Resolved] API outage</title>')
    expect(xml).toContain('Affected: API (Major outage)')
  })

  it('shows the full timeline of active incidents publicly, newest first', async () => {
    const opened = await call(createIncidentRoute, 'POST', pageParams(), ownerToken, {
      title: 'Slow website',
      message: 'Pages load slowly.',
      components: [{ monitor: website.id, impact: 'partial_outage' }],
    })
    const incident = opened.json.doc as Incident
    const params = { ...pageParams(), incidentId: String(incident.id) }
    await call(postUpdateRoute, 'POST', params, ownerToken, {
      status: 'identified',
      message: 'CDN issue.',
    })

    const data = await publicData()
    const shown = data.incidents.find((i) => i.id === String(incident.id))
    expect(shown?.updates.map((u) => [u.status, u.message])).toEqual([
      ['identified', 'CDN issue.'],
      ['investigating', 'Pages load slowly.'],
    ])
    expect(shown?.updates[1].components).toEqual([
      { id: String(website.id), name: 'Website', impact: 'partial_outage' },
    ])
    expect(shown?.content).toBe('CDN issue.')
    expect(monitorRow(data, website)?.impact).toBe('partial_outage')

    await call(postUpdateRoute, 'POST', params, ownerToken, { status: 'resolved' })
  })

  it('lets earlier text be edited, marks it, and keeps status and impact as posted', async () => {
    const opened = await call(createIncidentRoute, 'POST', pageParams(), ownerToken, {
      title: 'Typo incident',
      message: 'Investigatign.',
      components: [{ monitor: api.id, impact: 'degraded_performance' }],
    })
    const incident = opened.json.doc as Incident
    const first = incident.updates?.[0]
    expect(first?.editedAt ?? null).toBeNull()
    const params = { ...pageParams(), incidentId: String(incident.id) }

    const edited = await call(
      editUpdateRoute,
      'PATCH',
      { ...params, updateId: String(first?.id) },
      ownerToken,
      { message: 'Investigating.' },
    )
    expect(edited.status).toBe(200)
    const update = edited.json.update as NonNullable<Incident['updates']>[number]
    expect(update.message).toBe('Investigating.')
    expect(update.editedAt).toBeTruthy()
    expect(update.postedAt).toBe(first?.postedAt)

    // Rewriting history through the Payload API only changes the text.
    const doc = edited.json.doc as Incident
    const rewritten = await payload.update({
      collection: 'incidents',
      id: incident.id,
      data: {
        updates: (doc.updates ?? []).map((row) => ({
          ...row,
          status: 'resolved' as const,
          components: [{ monitor: api.id, impact: 'major_outage' as const }],
        })),
      },
      user: {
        ...(await payload.findByID({ collection: 'users', id: owner.id, depth: 0 })),
        collection: 'users',
      },
      overrideAccess: false,
    })
    expect(rewritten.updates?.[0]).toMatchObject({ status: 'investigating' })
    expect(rewritten.impact).toBe('degraded_performance')
    expect(rewritten.active).toBe(true)

    const missing = await call(
      editUpdateRoute,
      'PATCH',
      { ...params, updateId: 'nope' },
      ownerToken,
      { message: 'x' },
    )
    expect(missing.status).toBe(404)

    await call(postUpdateRoute, 'POST', params, ownerToken, { status: 'resolved' })
  })

  it('validates input, components and roles', async () => {
    const bad = await call(createIncidentRoute, 'POST', pageParams(), ownerToken, {
      title: 'Bad',
      status: 'exploded',
    })
    expect(bad.status).toBe(400)

    const offPage = await call(createIncidentRoute, 'POST', pageParams(), ownerToken, {
      title: 'Off page',
      components: [{ monitor: unlisted.id, impact: 'major_outage' }],
    })
    expect(offPage.status).toBe(400)

    const future = await call(createIncidentRoute, 'POST', pageParams(), ownerToken, {
      title: 'Future',
      postedAt: new Date(Date.now() + 3_600_000).toISOString(),
      message: 'x',
    })
    expect(future.status).toBe(400)

    // Back-dating is allowed.
    const earlier = new Date(Date.now() - 3_600_000).toISOString()
    const backdated = await call(createIncidentRoute, 'POST', pageParams(), ownerToken, {
      title: 'Started an hour ago',
      postedAt: earlier,
      message: 'x',
    })
    expect(backdated.status).toBe(201)
    expect((backdated.json.doc as Incident).updates?.[0]?.postedAt).toBe(earlier)
    const params = { ...pageParams(), incidentId: String((backdated.json.doc as Incident).id) }
    const futureUpdate = await call(postUpdateRoute, 'POST', params, ownerToken, {
      status: 'identified',
      postedAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    expect(futureUpdate.status).toBe(400)

    const asViewer = await call(postUpdateRoute, 'POST', params, viewerToken, {
      status: 'identified',
    })
    expect(asViewer.status).toBe(403)
    const anonymous = await call(postUpdateRoute, 'POST', params, null, { status: 'identified' })
    expect(anonymous.status).toBe(401)

    // `active: false` (pre-timeline clients) posts a resolved update.
    const resolved = await call(patchIncidentRoute, 'PATCH', params, ownerToken, { active: false })
    expect(resolved.status).toBe(200)
    const doc = resolved.json.doc as Incident
    expect(doc.status).toBe('resolved')
    expect(doc.updates?.at(-1)).toMatchObject({ status: 'resolved' })
    expect(doc.resolvedAt).toBeTruthy()
  })

  it('declares an impact for incidents without components', async () => {
    const opened = await call(createIncidentRoute, 'POST', pageParams(), ownerToken, {
      title: 'Everything is slow',
      message: 'Investigating.',
      impact: 'major_outage',
    })
    expect(opened.status).toBe(201)
    expect((opened.json.doc as Incident).impact).toBe('major_outage')
    const data = await publicData()
    expect(data.overall).toBe('down')
    const params = { ...pageParams(), incidentId: String((opened.json.doc as Incident).id) }
    await call(postUpdateRoute, 'POST', params, ownerToken, { status: 'resolved' })
    expect((await publicData()).overall).toBe('up')
  })

  it('migrates incidents written before the timeline without data loss', async () => {
    events.length = 0
    const created = await payload.create({
      collection: 'incidents',
      data: {
        statusPage: page.id,
        organization: org.id,
        title: 'Legacy outage',
        content: 'Old **content**.',
        style: 'danger',
      },
    })
    // Pre-timeline clients still work: one update from content, impact from style.
    expect(created.updates).toHaveLength(1)
    expect(created.updates?.[0]).toMatchObject({
      status: 'investigating',
      message: 'Old **content**.',
    })
    expect(created.impact).toBe('major_outage')

    // Simulate a row stored before the migration: no updates, no derived fields.
    await stripTimeline(created.id)
    const legacy = await payload.findByID({ collection: 'incidents', id: created.id, depth: 0 })
    expect(legacy.updates ?? []).toHaveLength(0)

    // Read paths synthesise the single update.
    let data = await publicData()
    const shown = data.incidents.find((i) => i.id === String(created.id))
    expect(shown).toMatchObject({
      status: 'investigating',
      impact: 'major_outage',
      style: 'danger',
      content: 'Old **content**.',
    })
    expect(shown?.updates).toHaveLength(1)
    expect(shown?.updates[0].postedAt).toBe(created.createdAt)
    expect(data.overall).toBe('down')

    // The first write materialises it silently (no subscriber event for history).
    events.length = 0
    const params = { ...pageParams(), incidentId: String(created.id) }
    const pinned = await call(patchIncidentRoute, 'PATCH', params, ownerToken, { pinned: false })
    expect(pinned.status).toBe(200)
    const doc = pinned.json.doc as Incident
    expect(doc.updates).toHaveLength(1)
    expect(doc.updates?.[0]).toMatchObject({
      status: 'investigating',
      message: 'Old **content**.',
      postedAt: created.createdAt,
    })
    expect(doc.impact).toBe('major_outage')
    expect(events).toHaveLength(0)

    // Posting the first real update keeps the migrated one.
    await stripTimeline(created.id)
    const posted = await call(postUpdateRoute, 'POST', params, ownerToken, {
      status: 'resolved',
      message: 'Fixed.',
    })
    expect(posted.status).toBe(201)
    const after = posted.json.doc as Incident
    expect(after.updates?.map((u) => [u.status, u.message])).toEqual([
      ['investigating', 'Old **content**.'],
      ['resolved', 'Fixed.'],
    ])
    expect(events.map((e) => e.kind)).toEqual(['resolved'])
    data = await publicData()
    expect(data.overall).toBe('up')
  })

  it('keeps the history when an affected monitor is deleted', async () => {
    const temp = await payload.create({
      collection: 'monitors',
      data: { ...MONITOR_DEFAULTS, name: 'Temp', organization: org.id },
    })
    const groups = [{ name: 'Core', monitors: [{ monitor: api.id }, { monitor: website.id }] }]
    await payload.update({
      collection: 'status-pages',
      id: page.id,
      data: { groups: [{ ...groups[0], monitors: [...groups[0].monitors, { monitor: temp.id }] }] },
    })
    const opened = await call(createIncidentRoute, 'POST', pageParams(), ownerToken, {
      title: 'Temp down',
      components: [{ monitor: temp.id, impact: 'major_outage' }],
    })
    expect(opened.status).toBe(201)
    const incident = opened.json.doc as Incident

    await payload.update({ collection: 'status-pages', id: page.id, data: { groups } })
    await payload.delete({ collection: 'monitors', id: temp.id })

    const params = { ...pageParams(), incidentId: String(incident.id) }
    const resolved = await call(postUpdateRoute, 'POST', params, ownerToken, {
      status: 'resolved',
    })
    expect(resolved.status).toBe(201)
    expect((resolved.json.doc as Incident).updates).toHaveLength(2)
  })
})
