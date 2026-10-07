import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { POST as accessRoute } from '@/app/api/status-pages/[slug]/access/route'
import { GET as eventRoute } from '@/app/api/status-pages/[slug]/events/[kind]/[id]/route'
import { GET as eventsRoute } from '@/app/api/status-pages/[slug]/events/route'
import { GET as publicRoute } from '@/app/api/status-pages/[slug]/public/route'
import { GET as robotsRoute } from '@/app/status/[slug]/robots.txt/route'
import { GET as rssRoute } from '@/app/status/[slug]/rss/route'
import { GET as sitemapRoute } from '@/app/status/[slug]/sitemap.xml/route'
import { isPublicId, parseEventFilters } from '@/lib/status-page-events'
import type {
  Incident,
  Maintenance,
  MaintenanceOccurrence,
  Monitor,
  Organization,
  StatusPage,
} from '@/payload-types'
import { closeRateLimitStore } from '@/server/security/rate-limit'
import { resetInstanceSettingsCache } from '@/server/settings'
import { clearVerifiedPasswords } from '@/server/status-pages/access'
import type { EventHistory } from '@/server/status-pages/events'
import {
  getIncidentEvent,
  getMaintenanceEvent,
  listStatusPageEvents,
} from '@/server/status-pages/events'
import { derivePublicId } from '@/server/status-pages/public-ids'
import type { PublicStatusPageData } from '@/server/status-pages/public'

let payload: Payload

const run = Date.now().toString(36)
const DAY = 24 * 60 * 60_000
const PASSWORD = 'history page password'

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>

const call = (
  handler: unknown,
  url: string,
  params: Record<string, string>,
  init: RequestInit = {},
): Promise<Response> =>
  (handler as Handler)(new Request(url, init), { params: Promise.resolve(params) })

const MONITOR_DEFAULTS = {
  type: 'manual' as const,
  active: true,
  interval: 60,
  retryInterval: 60,
  maxRetries: 0,
  resendInterval: 0,
  timeout: 48,
}

let org: Organization
let api: Monitor
let web: Monitor
let page: StatusPage
let otherPage: StatusPage
let lockedPage: StatusPage
let apiComponent: string
let staticComponent: string

let outage: Incident
let degraded: Incident
let legacy: Incident
let foreign: Incident
let maintenance: Maintenance
let pausedMaintenance: Maintenance
let unrelatedMaintenance: Maintenance
let completed: MaintenanceOccurrence
let cancelled: MaintenanceOccurrence
let pausedScheduled: MaintenanceOccurrence
let unrelatedCompleted: MaintenanceOccurrence

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

/** Rewrites stored fields without hooks (backdating, simulating documents from before #107). */
async function rawUpdate(
  collection: 'incidents' | 'maintenance-occurrences',
  id: string | number,
  data: Record<string, unknown>,
) {
  const doc = await payload.findByID({ collection, id, depth: 0 })
  await payload.db.updateOne({ collection, id, data: { ...doc, ...data }, req: {} as never })
}

async function createIncident(
  statusPage: StatusPage,
  title: string,
  updates: NonNullable<Incident['updates']>,
): Promise<Incident> {
  return payload.create({
    collection: 'incidents',
    data: {
      statusPage: statusPage.id,
      title,
      updates,
    } as RequiredDataFromCollectionSlug<'incidents'>,
    depth: 0,
    overrideAccess: true,
  })
}

async function createMaintenance(title: string, extra: Partial<Maintenance>): Promise<Maintenance> {
  return (await payload.create({
    collection: 'maintenance',
    overrideAccess: true,
    depth: 0,
    data: {
      organization: org.id,
      strategy: 'manual',
      timezone: 'UTC',
      active: false,
      reminders: [],
      ...extra,
      title,
    } as RequiredDataFromCollectionSlug<'maintenance'>,
  })) as Maintenance
}

async function createOccurrence(
  doc: Maintenance,
  data: Partial<MaintenanceOccurrence>,
): Promise<MaintenanceOccurrence> {
  return (await payload.create({
    collection: 'maintenance-occurrences',
    overrideAccess: true,
    depth: 0,
    data: {
      maintenance: doc.id,
      start: iso(-3 * DAY),
      end: iso(-3 * DAY + 2 * 60 * 60_000),
      state: 'completed',
      ...data,
    } as RequiredDataFromCollectionSlug<'maintenance-occurrences'>,
  })) as MaintenanceOccurrence
}

const history = (filters: string, target = page) =>
  listStatusPageEvents(payload, target, parseEventFilters(new URLSearchParams(filters)))

const titles = (h: EventHistory) => h.events.map((e) => e.title)

describe('status page history and permalinks', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    clearVerifiedPasswords()
    resetInstanceSettingsCache()

    org = await payload.create({
      collection: 'organizations',
      data: { name: 'History Acme', slug: `sph-acme-${run}` },
      overrideAccess: true,
    })
    const monitor = (name: string) =>
      payload.create({
        collection: 'monitors',
        data: {
          ...MONITOR_DEFAULTS,
          name,
          organization: org.id,
          status: { lastStatus: 'up', lastCheckAt: new Date().toISOString(), lastPing: 10 },
        },
        overrideAccess: true,
      })
    api = await monitor('API')
    web = await monitor('Website')

    page = await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'Acme Status',
        slug: `sph-public-${run}`,
        published: true,
        searchEngineIndex: true,
        pastIncidentsDays: 5,
        domains: [{ hostname: `history-${run}.example.com` }],
        groups: [
          {
            name: 'Core',
            monitors: [
              { monitor: api.id },
              { monitor: web.id },
              { type: 'static', name: 'Support' },
            ],
          },
        ],
      } as never,
      overrideAccess: true,
    })
    const rows = page.groups?.[0]?.monitors ?? []
    apiComponent = String(rows[0]?.id)
    staticComponent = String(rows[2]?.id)

    otherPage = await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'Other',
        slug: `sph-other-${run}`,
        published: true,
        groups: [{ name: 'Web', monitors: [{ monitor: web.id }] }],
      },
      overrideAccess: true,
    })
    lockedPage = await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'Locked',
        slug: `sph-locked-${run}`,
        published: true,
        searchEngineIndex: true,
        access: 'password',
        password: PASSWORD,
      } as never,
      overrideAccess: true,
    })

    outage = await createIncident(page, 'API outage', [
      {
        status: 'investigating',
        message: 'The API is down.',
        postedAt: iso(-2 * DAY),
        components: [{ component: apiComponent, impact: 'major_outage' }],
      },
      { status: 'resolved', message: 'Fixed.', postedAt: iso(-2 * DAY + 90 * 60_000) },
    ])
    degraded = await createIncident(page, 'Slow support replies', [
      {
        status: 'identified',
        message: 'Replies take longer.',
        postedAt: iso(-60_000),
        components: [{ component: staticComponent, impact: 'degraded_performance' }],
      },
    ])
    legacy = await createIncident(page, 'Old incident', [
      { status: 'resolved', message: 'Long ago.', postedAt: iso(-70 * DAY) },
    ])
    // Backdate and drop the public id, as for incidents stored before #107.
    await rawUpdate('incidents', legacy.id, { createdAt: iso(-70 * DAY), publicId: null })
    await rawUpdate('incidents', outage.id, { createdAt: iso(-2 * DAY) })
    foreign = await createIncident(otherPage, 'Elsewhere', [
      { status: 'investigating', message: 'Other page.', postedAt: iso(-60_000) },
    ])

    maintenance = await createMaintenance('Database upgrade', {
      monitors: [api.id],
      statusPages: [page.id],
    })
    completed = await createOccurrence(maintenance, {
      start: iso(-3 * DAY),
      startedAt: iso(-3 * DAY),
      completedAt: iso(-3 * DAY + 2 * 60 * 60_000),
      updates: [
        { status: 'in-progress', message: '', postedAt: iso(-3 * DAY) },
        { status: 'completed', message: 'All done.', postedAt: iso(-3 * DAY + 2 * 60 * 60_000) },
      ],
    })
    cancelled = await createOccurrence(maintenance, {
      start: iso(-40 * DAY),
      state: 'cancelled',
      cancelledAt: iso(-41 * DAY),
      updates: [{ status: 'cancelled', message: 'Not needed.', postedAt: iso(-41 * DAY) }],
    })
    pausedMaintenance = await createMaintenance('Paused window', { statusPages: [page.id] })
    pausedScheduled = await createOccurrence(pausedMaintenance, {
      start: iso(5 * DAY),
      end: iso(5 * DAY + 60 * 60_000),
      state: 'scheduled',
    })
    unrelatedMaintenance = await createMaintenance('Not on this page', {
      statusPages: [otherPage.id],
    })
    unrelatedCompleted = await createOccurrence(unrelatedMaintenance, {})
  })

  afterAll(async () => {
    if (org?.id) {
      for (const collection of ['incidents', 'maintenance-occurrences', 'maintenance'] as const) {
        await payload.delete({
          collection,
          where: { organization: { equals: org.id } },
          overrideAccess: true,
        })
      }
      await payload.delete({
        collection: 'status-pages',
        where: { organization: { equals: org.id } },
      })
      await payload.delete({ collection: 'monitors', where: { organization: { equals: org.id } } })
      await payload.delete({ collection: 'organizations', where: { id: { equals: org.id } } })
    }
    await closeRateLimitStore()
  })

  describe('public ids', () => {
    it('are assigned on create, kept on update and never taken from the client', async () => {
      expect(isPublicId(outage.publicId)).toBe(true)
      expect(isPublicId(completed.publicId)).toBe(true)
      expect(outage.publicId).not.toBe(String(outage.id))

      const spoofed = await payload.create({
        collection: 'incidents',
        data: {
          statusPage: page.id,
          title: 'Spoofed',
          publicId: 'aaaaaaaa',
          updates: [{ status: 'resolved', message: '', postedAt: iso(-DAY) }],
        } as RequiredDataFromCollectionSlug<'incidents'>,
        overrideAccess: true,
      })
      expect(spoofed.publicId).not.toBe('aaaaaaaa')
      const updated = await payload.update({
        collection: 'incidents',
        id: spoofed.id,
        data: { title: 'Renamed', publicId: 'bbbbbbbb' } as Partial<Incident>,
        overrideAccess: true,
      })
      expect(updated.publicId).toBe(spoofed.publicId)
      await payload.delete({ collection: 'incidents', id: spoofed.id, overrideAccess: true })
    })

    it('derives a stable id for documents stored before public ids existed', async () => {
      const derived = derivePublicId('incidents', legacy.id)
      expect(isPublicId(derived)).toBe(true)
      const event = await getIncidentEvent(payload, page, derived)
      expect(event?.incident.title).toBe('Old incident')
      expect(event?.incident.publicId).toBe(derived)

      // The next write stores the derived id, so the permalink never changes.
      const saved = await payload.update({
        collection: 'incidents',
        id: legacy.id,
        data: { title: 'Old incident' },
        overrideAccess: true,
      })
      expect(saved.publicId).toBe(derived)
      expect((await getIncidentEvent(payload, page, derived))?.incident.title).toBe('Old incident')
    })
  })

  describe('history', () => {
    it('lists incidents and finished maintenance of the page, newest first', async () => {
      const all = await history('')
      expect(titles(all)).toEqual([
        'Slow support replies',
        'API outage',
        'Database upgrade',
        'Database upgrade',
        'Old incident',
      ])
      expect(all.totalEvents).toBe(5)
      // Upcoming windows, other pages' incidents and maintenance are not history.
      const ids = all.events.map((e) => e.publicId)
      expect(ids).not.toContain(foreign.publicId)
      expect(ids).not.toContain(pausedScheduled.publicId)
      expect(ids).not.toContain(unrelatedCompleted.publicId)
      expect(all.components.map((c) => c.name)).toEqual(['API', 'Website', 'Support'])
      expect(all.months.length).toBeGreaterThanOrEqual(3)

      const [ongoing, resolved, window] = all.events
      expect(ongoing).toMatchObject({ kind: 'incident', ongoing: true, end: null })
      expect(resolved).toMatchObject({
        kind: 'incident',
        status: 'resolved',
        impact: 'major_outage',
        components: [{ id: apiComponent, name: 'API' }],
        latest: { status: 'resolved', message: 'Fixed.' },
      })
      expect(window).toMatchObject({
        kind: 'maintenance',
        status: 'completed',
        components: [{ id: apiComponent, name: 'API' }],
        start: completed.startedAt,
        end: completed.completedAt,
      })
    })

    it('filters by type, component and month and paginates', async () => {
      expect(titles(await history('type=maintenance'))).toEqual([
        'Database upgrade',
        'Database upgrade',
      ])
      expect(titles(await history('type=incident'))).toEqual([
        'Slow support replies',
        'API outage',
        'Old incident',
      ])
      expect(titles(await history(`component=${apiComponent}`))).toEqual([
        'API outage',
        'Database upgrade',
        'Database upgrade',
      ])
      expect(titles(await history(`component=${staticComponent}&type=incident`))).toEqual([
        'Slow support replies',
      ])
      // Unknown components are ignored rather than matching nothing.
      expect((await history('component=nope')).filters.component).toBeNull()

      const month = new Date(Date.now() - 70 * DAY).toISOString().slice(0, 7)
      const old = await history(`month=${month}&type=incident`)
      expect(titles(old)).toEqual(['Old incident'])

      const first = await listStatusPageEvents(payload, page, parseEventFilters(null), {
        perPage: 2,
      })
      expect(first).toMatchObject({ page: 1, totalPages: 3, totalEvents: 5 })
      const last = await listStatusPageEvents(
        payload,
        page,
        parseEventFilters(new URLSearchParams('page=99')),
        { perPage: 2 },
      )
      expect(last.page).toBe(3)
      expect(titles(last)).toEqual(['Old incident'])
    })

    it('shows the last days of incidents on the main page, quiet days included', async () => {
      const res = await call(
        publicRoute,
        `http://localhost:3000/api/status-pages/${page.slug}/public`,
        { slug: page.slug },
      )
      const data = (await res.json()) as PublicStatusPageData
      expect(data.pastIncidentsDays).toBe(5)
      expect(data.pastIncidents).toHaveLength(5)
      const listed = data.pastIncidents.flatMap((day) => day.incidents.map((i) => i.title))
      expect(listed).toEqual(['Slow support replies', 'API outage'])
      expect(data.pastIncidents.some((day) => day.incidents.length === 0)).toBe(true)
      expect(data.incidents[0]?.publicId).toBe(degraded.publicId)
      expect(data.maintenance.every((m) => isPublicId(m.publicId))).toBe(true)
    })
  })

  describe('permalinks', () => {
    it('finds incidents of the page only', async () => {
      const event = await getIncidentEvent(payload, page, outage.publicId as string)
      expect(event?.incident.updates.map((u) => u.status)).toEqual(['resolved', 'investigating'])
      expect(event?.summary.end).toBe(event?.incident.resolvedAt)
      expect(await getIncidentEvent(payload, page, foreign.publicId as string)).toBeNull()
      expect(await getIncidentEvent(payload, page, 'zzzzzzzz')).toBeNull()
      expect(await getIncidentEvent(payload, page, String(outage.id))).toBeNull()
    })

    it('finds public maintenance windows of the page only', async () => {
      const event = await getMaintenanceEvent(payload, page, completed.publicId as string)
      expect(event?.maintenance.title).toBe('Database upgrade')
      expect(event?.maintenance.updates[0]?.message).toBe('All done.')
      expect(event?.summary.components).toEqual([{ id: apiComponent, name: 'API' }])
      expect(await getMaintenanceEvent(payload, page, cancelled.publicId as string)).not.toBeNull()
      // A paused maintenance's upcoming window is not announced; another page's window is not ours.
      expect(
        await getMaintenanceEvent(payload, page, pausedScheduled.publicId as string),
      ).toBeNull()
      expect(
        await getMaintenanceEvent(payload, page, unrelatedCompleted.publicId as string),
      ).toBeNull()
      expect(
        await getMaintenanceEvent(payload, otherPage, unrelatedCompleted.publicId as string),
      ).not.toBeNull()
    })

    it('serves the JSON API with 404s for unknown events and kinds', async () => {
      const url = (kind: string, id: string) =>
        `http://localhost:3000/api/status-pages/${page.slug}/events/${kind}/${id}`
      const ok = await call(eventRoute, url('incident', outage.publicId as string), {
        slug: page.slug,
        kind: 'incident',
        id: outage.publicId as string,
      })
      expect(ok.status).toBe(200)
      expect(((await ok.json()) as { incident: { title: string } }).incident.title).toBe(
        'API outage',
      )
      for (const [kind, id] of [
        ['incident', foreign.publicId as string],
        ['maintenance', outage.publicId as string],
        ['other', outage.publicId as string],
      ]) {
        const res = await call(eventRoute, url(kind, id), { slug: page.slug, kind, id })
        expect(res.status, `${kind}/${id}`).toBe(404)
      }
      const list = await call(
        eventsRoute,
        `http://localhost:3000/api/status-pages/${page.slug}/events?type=maintenance`,
        { slug: page.slug },
      )
      expect(list.status).toBe(200)
      expect(titles((await list.json()) as EventHistory)).toEqual([
        'Database upgrade',
        'Database upgrade',
      ])
    })

    it('links feed items to the permalinks', async () => {
      const res = await call(rssRoute, `http://localhost:3000/status/${page.slug}/rss`, {
        slug: page.slug,
      })
      expect(await res.text()).toContain(
        `<link>http://localhost:3000/status/${page.slug}/events/incident/${outage.publicId}</link>`,
      )
    })
  })

  describe('access protection', () => {
    let lockedIncident: Incident

    beforeAll(async () => {
      lockedIncident = await createIncident(lockedPage, 'Secret incident', [
        { status: 'investigating', message: 'Hidden.', postedAt: iso(-60_000) },
      ])
    })

    it('answers 401 on the history and permalinks without access', async () => {
      const id = lockedIncident.publicId as string
      const base = `http://localhost:3000/api/status-pages/${lockedPage.slug}/events`
      const denied = await call(eventsRoute, base, { slug: lockedPage.slug })
      expect(denied.status).toBe(401)
      expect(await denied.text()).not.toContain('Secret incident')
      const deniedOne = await call(eventRoute, `${base}/incident/${id}`, {
        slug: lockedPage.slug,
        kind: 'incident',
        id,
      })
      expect(deniedOne.status).toBe(401)

      const pw = `?pw=${encodeURIComponent(PASSWORD)}`
      const allowed = await call(eventRoute, `${base}/incident/${id}${pw}`, {
        slug: lockedPage.slug,
        kind: 'incident',
        id,
      })
      expect(allowed.status).toBe(200)
      expect(allowed.headers.get('cache-control')).toBe('private, no-store')
      expect(allowed.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    })

    it('returns to the permalink after signing in, and only below the page', async () => {
      const login = (next: string, password = PASSWORD) =>
        call(
          accessRoute,
          `http://localhost:3000/api/status-pages/${lockedPage.slug}/access`,
          { slug: lockedPage.slug },
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ password, next }).toString(),
          },
        )
      const path = `/events/incident/${lockedIncident.publicId}`
      const ok = await login(path)
      expect(ok.status).toBe(303)
      expect(ok.headers.get('location')).toBe(`/status/${lockedPage.slug}${path}`)

      const wrong = await login(path, 'wrong password')
      expect(wrong.headers.get('location')).toBe(
        `/status/${lockedPage.slug}/login?error=invalid&next=${encodeURIComponent(path)}`,
      )

      for (const next of ['//evil.example', 'https://evil.example/', '/admin']) {
        const res = await login(next)
        expect(res.headers.get('location'), next).toBe(`/status/${lockedPage.slug}`)
      }
      clearVerifiedPasswords()
    })
  })

  describe('sitemap and robots', () => {
    it('lists the page, the history and every public permalink of indexable pages', async () => {
      const res = await call(
        sitemapRoute,
        `http://localhost:3000/status/${page.slug}/sitemap.xml`,
        {
          slug: page.slug,
        },
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/xml')
      const xml = await res.text()
      const base = `http://localhost:3000/status/${page.slug}`
      expect(xml).toContain(`<loc>${base}</loc>`)
      expect(xml).toContain(`<loc>${base}/events</loc>`)
      expect(xml).toContain(`<loc>${base}/events/incident/${outage.publicId}</loc>`)
      expect(xml).toContain(`<loc>${base}/events/maintenance/${completed.publicId}</loc>`)
      expect(xml).not.toContain(pausedScheduled.publicId as string)
      expect(xml).not.toContain(foreign.publicId as string)
    })

    it('uses the custom domain the request arrived on', async () => {
      const host = `history-${run}.example.com`
      const res = await call(
        sitemapRoute,
        `http://localhost:3000/status/${page.slug}/sitemap.xml`,
        { slug: page.slug },
        { headers: { 'x-forwarded-host': host, 'x-forwarded-proto': 'https' } },
      )
      const xml = await res.text()
      expect(xml).toContain(`<loc>https://${host}/events/incident/${outage.publicId}</loc>`)
      expect(xml).not.toContain('/status/')

      const robots = await call(
        robotsRoute,
        `http://localhost:3000/status/${page.slug}/robots.txt`,
        { slug: page.slug },
        { headers: { 'x-forwarded-host': host, 'x-forwarded-proto': 'https' } },
      )
      const text = await robots.text()
      expect(text).toContain('Allow: /')
      expect(text).toContain(`Sitemap: https://${host}/sitemap.xml`)
    })

    it('has no sitemap and disallows crawling for protected or non-indexed pages', async () => {
      for (const target of [otherPage, lockedPage]) {
        const sitemap = await call(
          sitemapRoute,
          `http://localhost:3000/status/${target.slug}/sitemap.xml`,
          { slug: target.slug },
        )
        expect(sitemap.status, target.slug).toBe(404)
        const robots = await call(
          robotsRoute,
          `http://localhost:3000/status/${target.slug}/robots.txt`,
          { slug: target.slug },
        )
        expect(await robots.text()).toBe('User-agent: *\nDisallow: /\n')
      }
      const unknown = await call(sitemapRoute, 'http://localhost:3000/status/nope/sitemap.xml', {
        slug: `nope-${run}`,
      })
      expect(unknown.status).toBe(404)
    })
  })
})
