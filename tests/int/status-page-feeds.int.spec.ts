import { readFileSync } from 'node:fs'
import path from 'node:path'

import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { GET as openapiRoute } from '@/app/status/[slug]/api/openapi.json/route'
import { GET as componentsRoute } from '@/app/status/[slug]/api/v2/components.json/route'
import { GET as incidentsRoute } from '@/app/status/[slug]/api/v2/incidents.json/route'
import { GET as maintenancesRoute } from '@/app/status/[slug]/api/v2/scheduled-maintenances.json/route'
import { GET as statusRoute } from '@/app/status/[slug]/api/v2/status.json/route'
import {
  GET as summaryRoute,
  OPTIONS as summaryOptions,
} from '@/app/status/[slug]/api/v2/summary.json/route'
import { GET as atomRoute } from '@/app/status/[slug]/feed/atom/route'
import { GET as jsonFeedRoute } from '@/app/status/[slug]/feed/json/route'
import { GET as incidentMarkdownRoute } from '@/app/status/[slug]/incident-md/[id]/route'
import { GET as markdownRoute } from '@/app/status/[slug]/index.md/route'
import { GET as llmsRoute } from '@/app/status/[slug]/llms.txt/route'
import { GET as icsRoute } from '@/app/status/[slug]/maintenance.ics/route'
import { GET as rssRoute } from '@/app/status/[slug]/rss/route'
import { closeRateLimitStore } from '@/server/security/rate-limit'
import { resetInstanceSettingsCache } from '@/server/settings'
import { clearVerifiedPasswords } from '@/server/status-pages/access'
import type { JsonFeed } from '@/server/status-pages/feed-formats'
import type {
  SpIncident,
  SpScheduledMaintenance,
  SpSummary,
} from '@/server/status-pages/statuspage'
import type {
  Incident,
  Maintenance,
  MaintenanceOccurrence,
  Monitor,
  Organization,
  StatusPage,
} from '@/payload-types'
import { postOccurrenceUpdate } from '@/server/maintenance'

let payload: Payload

/** Every machine-readable endpoint of a page, for the access checks. */
const ENDPOINTS: [unknown, string][] = [
  [atomRoute, '/feed/atom'],
  [jsonFeedRoute, '/feed/json'],
  [rssRoute, '/rss'],
  [icsRoute, '/maintenance.ics'],
  [summaryRoute, '/api/v2/summary.json'],
  [statusRoute, '/api/v2/status.json'],
  [componentsRoute, '/api/v2/components.json'],
  [incidentsRoute, '/api/v2/incidents.json'],
  [maintenancesRoute, '/api/v2/scheduled-maintenances.json'],
  [markdownRoute, '/index.md'],
  [llmsRoute, '/llms.txt'],
  [openapiRoute, '/api/openapi.json'],
]

const run = Date.now().toString(36)
const PASSWORD = 'feeds password 1'

const MONITOR_DEFAULTS = {
  type: 'manual' as const,
  active: true,
  interval: 60,
  retryInterval: 60,
  maxRetries: 0,
  resendInterval: 0,
  timeout: 48,
}

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>

const BASE = 'http://localhost:3000'

const get = (
  handler: unknown,
  slug: string,
  suffix: string,
  init: RequestInit = {},
  params: Record<string, string> = {},
): Promise<Response> =>
  (handler as Handler)(new Request(`${BASE}/status/${slug}${suffix}`, init), {
    params: Promise.resolve({ slug, ...params }),
  })

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString()

/** Minimal XML well-formedness check: balanced tags, escaped text. */
function expectWellFormedXml(xml: string) {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, '')
  const stack: string[] = []
  const tag = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/g
  let last = 0
  for (let match = tag.exec(body); match; match = tag.exec(body)) {
    const between = body.slice(last, match.index)
    expect(between, `raw markup before <${match[2]}>`).not.toMatch(/[<>]/)
    expect(between).not.toMatch(/&(?!(amp|lt|gt|quot|apos|#\d+);)/)
    last = tag.lastIndex
    const [, closing, name, , selfClosing] = match
    if (selfClosing) continue
    if (closing) expect(stack.pop(), `closing </${name}>`).toBe(name)
    else stack.push(name)
  }
  expect(body.slice(last).trim()).toBe('')
  expect(stack).toEqual([])
}

/** Every key of `reference` (recursively, first array element) exists in `actual` with a compatible type. */
function expectShape(actual: unknown, reference: unknown, where = '$') {
  if (reference === null) return
  if (Array.isArray(reference)) {
    expect(Array.isArray(actual), `${where} is an array`).toBe(true)
    const sample = (actual as unknown[])[0]
    if (reference.length > 0 && sample !== undefined)
      expectShape(sample, reference[0], `${where}[0]`)
    return
  }
  if (typeof reference === 'object') {
    expect(actual && typeof actual === 'object', `${where} is an object`).toBe(true)
    for (const [key, value] of Object.entries(reference as Record<string, unknown>)) {
      expect(actual as object, `${where}.${key}`).toHaveProperty(key)
      const next = (actual as Record<string, unknown>)[key]
      if (next === null) continue
      expectShape(next, value, `${where}.${key}`)
    }
    return
  }
  expect(typeof actual, where).toBe(typeof reference)
}

const fixture = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'tests/fixtures/statuspage/summary.json'), 'utf8'),
) as SpSummary

let org: Organization
let api: Monitor
let web: Monitor
let page: StatusPage
let protectedPage: StatusPage
let otherPage: StatusPage
let apiC: string
let webC: string
let staticC: string
let openIncident: Incident
let resolvedIncident: Incident
let foreignIncident: Incident

const host = () => `feeds-${run}.example.com`

async function occurrencesOf(maintenanceId: string | number): Promise<MaintenanceOccurrence[]> {
  const { docs } = await payload.find({
    collection: 'maintenance-occurrences',
    where: { maintenance: { equals: maintenanceId } },
    sort: 'start',
    depth: 0,
    pagination: false,
  })
  return docs as MaintenanceOccurrence[]
}

describe('status page feeds and machine-readable outputs', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    clearVerifiedPasswords()

    org = await payload.create({
      collection: 'organizations',
      data: { name: 'Feeds Acme', slug: `feeds-acme-${run}` },
    })
    api = await payload.create({
      collection: 'monitors',
      data: {
        ...MONITOR_DEFAULTS,
        name: 'API',
        organization: org.id,
        status: { lastStatus: 'down', lastCheckAt: minutes(-1) },
      },
    })
    web = await payload.create({
      collection: 'monitors',
      data: {
        ...MONITOR_DEFAULTS,
        name: 'Website',
        organization: org.id,
        status: { lastStatus: 'up', lastCheckAt: minutes(-1) },
      },
    })
    for (const [status, at] of [
      ['up', -10],
      ['down', -5],
      ['down', -1],
    ] as const) {
      await payload.create({
        collection: 'heartbeats',
        data: { monitor: api.id, organization: org.id, status, time: minutes(at), ping: 10 },
      })
    }

    page = await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'Feeds & Co',
        slug: `feeds-${run}`,
        description: 'Status of **Feeds & Co**.',
        published: true,
        autoRefreshInterval: 120,
        domains: [{ hostname: host() }],
        groups: [
          { name: 'Core', monitors: [{ monitor: api.id }, { monitor: web.id }] },
          { name: 'Support', monitors: [{ type: 'static', name: 'Help desk' }] },
        ],
      } as never,
      overrideAccess: true,
    })
    apiC = String(page.groups?.[0]?.monitors?.[0]?.id)
    webC = String(page.groups?.[0]?.monitors?.[1]?.id)
    staticC = String(page.groups?.[1]?.monitors?.[0]?.id)

    protectedPage = await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'Feeds Internal',
        slug: `feeds-internal-${run}`,
        published: true,
        access: 'password',
        password: PASSWORD,
        groups: [{ name: 'Core', monitors: [{ monitor: web.id }] }],
      } as never,
      overrideAccess: true,
    })
    otherPage = await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'Other',
        slug: `feeds-other-${run}`,
        published: true,
        groups: [{ name: 'Core', monitors: [{ monitor: web.id }] }],
      },
      overrideAccess: true,
    })

    resolvedIncident = await payload.create({
      collection: 'incidents',
      data: {
        statusPage: page.id,
        organization: org.id,
        title: 'Slow <website>',
        updates: [
          {
            status: 'investigating',
            message: 'Pages are *slow*.',
            postedAt: minutes(-120),
            components: [{ component: webC, impact: 'partial_outage' }],
          },
          { status: 'resolved', message: 'Fixed.', postedAt: minutes(-60), components: [] },
        ],
      } as never,
      overrideAccess: true,
    })
    openIncident = await payload.create({
      collection: 'incidents',
      data: {
        statusPage: page.id,
        organization: org.id,
        title: 'API errors',
        updates: [
          {
            status: 'investigating',
            message: 'Errors on the API.',
            postedAt: minutes(-30),
            components: [{ component: apiC, impact: 'degraded_performance' }],
          },
          {
            status: 'identified',
            message: 'A bad deploy.',
            postedAt: minutes(-20),
            components: [
              { component: apiC, impact: 'major_outage' },
              { component: staticC, impact: 'degraded_performance' },
            ],
          },
        ],
      } as never,
      overrideAccess: true,
    })
    foreignIncident = await payload.create({
      collection: 'incidents',
      data: {
        statusPage: otherPage.id,
        organization: org.id,
        title: 'Elsewhere',
        updates: [{ status: 'investigating', message: 'x', postedAt: minutes(-5) }],
      } as never,
      overrideAccess: true,
    })

    await payload.create({
      collection: 'maintenance',
      data: {
        organization: org.id,
        title: 'Database upgrade',
        description: 'Short, planned; downtime.',
        strategy: 'single',
        active: true,
        timezone: 'UTC',
        dateRange: { start: minutes(24 * 60), end: minutes(24 * 60 + 60) },
        monitors: [api.id],
        statusPages: [page.id],
      } as never,
      overrideAccess: true,
    })
    // Cancelled occurrence (#154): announced in the calendar as cancelled, absent from the JSON.
    const toCancel = (await payload.create({
      collection: 'maintenance',
      data: {
        organization: org.id,
        title: 'Cancelled window',
        strategy: 'single',
        active: true,
        timezone: 'UTC',
        reminders: [],
        dateRange: { start: minutes(48 * 60), end: minutes(48 * 60 + 30) },
        statusPages: [page.id],
      } as never,
      overrideAccess: true,
    })) as Maintenance
    const [planned] = await occurrencesOf(toCancel.id)
    await postOccurrenceUpdate(payload, toCancel, planned, {
      status: 'cancelled',
      message: 'Not needed after all.',
    })

    // Running occurrence, moved on to verifying.
    const running = (await payload.create({
      collection: 'maintenance',
      data: {
        organization: org.id,
        title: 'Network work',
        strategy: 'single',
        active: true,
        timezone: 'UTC',
        reminders: [],
        dateRange: { start: minutes(-30), end: minutes(30) },
        statusPages: [page.id],
      } as never,
      overrideAccess: true,
    })) as Maintenance
    let [current] = await occurrencesOf(running.id)
    if (current.state === 'scheduled') {
      await postOccurrenceUpdate(payload, running, current, { status: 'in-progress' })
      ;[current] = await occurrencesOf(running.id)
    }
    await postOccurrenceUpdate(payload, running, current, {
      status: 'verifying',
      message: 'Checking the links.',
    })
  })

  afterAll(async () => {
    if (org?.id) {
      const where = { organization: { equals: org.id } }
      await payload.delete({ collection: 'maintenance-occurrences', where })
      await payload.delete({ collection: 'maintenance', where })
      await payload.delete({ collection: 'incidents', where })
      await payload.delete({ collection: 'status-pages', where })
      await payload.delete({ collection: 'heartbeats', where })
      await payload.delete({ collection: 'monitors', where })
      await payload.delete({ collection: 'organizations', where: { id: { equals: org.id } } })
    }
    await closeRateLimitStore()
  })

  describe('feeds', () => {
    it('renders an Atom 1.0 feed with one entry per update linked to the permalink', async () => {
      const res = await get(atomRoute, page.slug, '/feed/atom')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/atom+xml; charset=utf-8')
      const xml = await res.text()
      expectWellFormedXml(xml)
      expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">')
      expect(xml).toContain('<title type="text">Feeds &amp; Co status</title>')
      expect(xml).toContain(
        `<link rel="self" type="application/atom+xml" href="${BASE}/status/${page.slug}/feed/atom"/>`,
      )
      expect(xml).toContain('<author><name>Feeds &amp; Co</name></author>')
      expect(xml).toContain('<title type="text">[Identified] API errors</title>')
      expect(xml).toContain('<title type="text">Slow &lt;website&gt;</title>')
      expect(xml).toContain(`href="${BASE}/status/${page.slug}/incidents/${openIncident.id}"`)
      // 4 updates + the API monitor that is down.
      expect((xml.match(/<entry>/g) ?? []).length).toBe(5)
      const ids = [...xml.matchAll(/<entry>\s*<id>([^<]+)<\/id>/g)].map((m) => m[1])
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids.every((id) => id.startsWith('tag:'))).toBe(true)
      expect(xml).toContain('<title type="text">API is down</title>')
    })

    it('renders JSON Feed 1.1 with the same items', async () => {
      const res = await get(jsonFeedRoute, page.slug, '/feed/json')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/feed+json; charset=utf-8')
      const feed = (await res.json()) as JsonFeed
      expect(feed.version).toBe('https://jsonfeed.org/version/1.1')
      expect(feed.feed_url).toBe(`${BASE}/status/${page.slug}/feed/json`)
      expect(feed.home_page_url).toBe(`${BASE}/status/${page.slug}`)
      expect(feed.items).toHaveLength(5)
      for (const item of feed.items) {
        expect(typeof item.id).toBe('string')
        expect(item.content_html.length).toBeGreaterThan(0)
        expect(Number.isNaN(Date.parse(item.date_published))).toBe(false)
      }
      // Newest first; the monitor went down 5 minutes ago.
      expect(feed.items[0].title).toBe('API is down')
      expect(feed.items[1].title).toBe('[Identified] API errors')
      expect(feed.items[1].content_html).toContain('Affected: API (Major outage)')

      const atom = await (await get(atomRoute, page.slug, '/feed/atom')).text()
      for (const item of feed.items) expect(atom).toContain(`<id>${item.id}</id>`)
    })

    it('keeps RSS items in sync and links them to incident permalinks', async () => {
      const res = await get(rssRoute, page.slug, '/rss')
      expect(res.status).toBe(200)
      const xml = await res.text()
      expectWellFormedXml(xml)
      expect((xml.match(/<item>/g) ?? []).length).toBe(5)
      expect(xml).toContain(`<link>${BASE}/status/${page.slug}/incidents/${openIncident.id}</link>`)
    })
  })

  describe('iCalendar', () => {
    it('lists maintenance windows with stable UIDs, folding and cancelled windows', async () => {
      const res = await get(icsRoute, page.slug, '/maintenance.ics')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8')
      const ics = await res.text()
      const lines = ics.split('\r\n')
      expect(lines[0]).toBe('BEGIN:VCALENDAR')
      expect(lines.at(-1)).toBe('')
      expect(lines.at(-2)).toBe('END:VCALENDAR')
      for (const line of lines) {
        expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
        expect(line).not.toMatch(/\n|\r/)
      }
      expect(ics).toContain('X-PUBLISHED-TTL:PT1H')
      expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(3)
      expect((ics.match(/END:VEVENT/g) ?? []).length).toBe(3)
      expect(ics).toContain('SUMMARY:Database upgrade')
      expect(ics).toContain('DESCRIPTION:Short\\, planned\\; downtime.')
      expect(ics).toContain('STATUS:CONFIRMED')
      expect(ics).toContain('SUMMARY:Network work')
      const cancelled = ics.slice(ics.indexOf('SUMMARY:Cancelled window'))
      expect(cancelled.slice(0, cancelled.indexOf('END:VEVENT'))).toContain('STATUS:CANCELLED')
      expect((ics.match(/STATUS:CANCELLED/g) ?? []).length).toBe(1)
      expect(ics).toMatch(/SEQUENCE:\d+/)
      const uids = [...ics.matchAll(/UID:(.+)/g)].map((m) => m[1])
      expect(new Set(uids).size).toBe(3)
      expect(uids.every((uid) => uid.startsWith('maintenance-occurrence-'))).toBe(true)

      const again = await (await get(icsRoute, page.slug, '/maintenance.ics')).text()
      expect(again).toBe(ics)
    })
  })

  describe('Statuspage-compatible JSON', () => {
    it('serves summary.json in the Statuspage v2 shape', async () => {
      const res = await get(summaryRoute, page.slug, '/api/v2/summary.json')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
      const summary = (await res.json()) as SpSummary
      expectShape(summary, fixture)

      expect(summary.page).toMatchObject({
        id: String(page.id),
        name: 'Feeds & Co',
        url: `${BASE}/status/${page.slug}`,
      })

      const [core, apiRow, webRow, support, desk] = summary.components
      expect(core).toMatchObject({ name: 'Core', group: true, group_id: null })
      expect(core.components).toEqual([apiC, webC])
      expect(apiRow).toMatchObject({
        id: apiC,
        name: 'API',
        status: 'major_outage',
        group_id: core.id,
      })
      expect(webRow).toMatchObject({ id: webC, status: 'operational' })
      expect(support).toMatchObject({ name: 'Support', group: true, components: [staticC] })
      expect(desk).toMatchObject({ id: staticC, status: 'degraded_performance' })
      expect(core.status).toBe('major_outage')
      expect(summary.components.map((c) => c.position)).toEqual([1, 2, 3, 4, 5])

      // Only unresolved incidents.
      expect(summary.incidents.map((i) => i.id)).toEqual([String(openIncident.id)])
      const [incident] = summary.incidents
      expect(incident).toMatchObject({
        name: 'API errors',
        status: 'identified',
        impact: 'critical',
        resolved_at: null,
        shortlink: `${BASE}/status/${page.slug}/incidents/${openIncident.id}`,
      })
      expect(incident.incident_updates.map((u) => u.status)).toEqual([
        'identified',
        'investigating',
      ])
      expect(incident.incident_updates[0].affected_components).toEqual([
        { code: apiC, name: 'API', old_status: 'degraded_performance', new_status: 'major_outage' },
        {
          code: staticC,
          name: 'Help desk',
          old_status: 'operational',
          new_status: 'degraded_performance',
        },
      ])
      expect(incident.components.map((c) => c.id)).toEqual([apiC, staticC])

      // Running first, then upcoming; the cancelled occurrence is left out.
      expect(summary.scheduled_maintenances.map((m) => [m.name, m.status])).toEqual([
        ['Network work', 'verifying'],
        ['Database upgrade', 'scheduled'],
      ])
      const [work, upgrade] = summary.scheduled_maintenances
      expect(upgrade).toMatchObject({ impact: 'maintenance', scheduled_until: expect.any(String) })
      expect(upgrade.components.map((c) => c.id)).toEqual([apiC])
      expect(work.monitoring_at).not.toBeNull()
      expect(work.incident_updates[0]).toMatchObject({
        status: 'verifying',
        body: 'Checking the links.',
      })
      expect(work.incident_updates.length).toBeGreaterThanOrEqual(2)

      expect(summary.status).toEqual({ indicator: 'critical', description: 'Major System Outage' })
    })

    it('serves status.json and components.json', async () => {
      const status = (await (await get(statusRoute, page.slug, '/api/v2/status.json')).json()) as {
        page: SpSummary['page']
        status: SpSummary['status']
      }
      expect(Object.keys(status).sort()).toEqual(['page', 'status'])
      expect(status.status.indicator).toBe('critical')

      const components = (await (
        await get(componentsRoute, page.slug, '/api/v2/components.json')
      ).json()) as Pick<SpSummary, 'page' | 'components'>
      expect(Object.keys(components).sort()).toEqual(['components', 'page'])
      expect(components.components).toHaveLength(5)
      expectShape(components.components, fixture.components)
    })

    it('serves incidents.json with resolved incidents and their peak impact', async () => {
      const res = await get(incidentsRoute, page.slug, '/api/v2/incidents.json')
      const body = (await res.json()) as { incidents: SpIncident[] }
      expect(body.incidents.map((i) => i.id)).toEqual([
        String(openIncident.id),
        String(resolvedIncident.id),
      ])
      const resolved = body.incidents[1]
      expect(resolved).toMatchObject({ status: 'resolved', impact: 'major' })
      expect(resolved.resolved_at).not.toBeNull()
      expect(resolved.incident_updates[0].affected_components).toEqual([
        { code: webC, name: 'Website', old_status: 'partial_outage', new_status: 'operational' },
      ])
      expectShape(body.incidents, fixture.incidents)
    })

    it('serves scheduled-maintenances.json without paused windows', async () => {
      const res = await get(maintenancesRoute, page.slug, '/api/v2/scheduled-maintenances.json')
      const body = (await res.json()) as { scheduled_maintenances: SpScheduledMaintenance[] }
      expect(body.scheduled_maintenances.map((m) => m.name)).toEqual([
        'Database upgrade',
        'Network work',
      ])
      expectShape(body.scheduled_maintenances, fixture.scheduled_maintenances)
    })

    it('links to the custom domain when requested there', async () => {
      const res = await get(summaryRoute, page.slug, '/api/v2/summary.json', {
        headers: { host: host(), 'x-forwarded-proto': 'https' },
      })
      const summary = (await res.json()) as SpSummary
      expect(summary.page.url).toBe(`https://${host()}`)
      expect(summary.incidents[0].shortlink).toBe(`https://${host()}/incidents/${openIncident.id}`)

      const llms = await (
        await get(llmsRoute, page.slug, '/llms.txt', { headers: { host: host() } })
      ).text()
      expect(llms).toContain(`(http://${host()}/index.md)`)
      expect(llms).toContain(`(http://${host()}/api/v2/summary.json)`)
    })
  })

  describe('Markdown and llms.txt', () => {
    it('renders the page as Markdown', async () => {
      const res = await get(markdownRoute, page.slug, '/index.md')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
      const md = await res.text()
      expect(md.startsWith('# Feeds & Co\n')).toBe(true)
      expect(md).toContain('Status of **Feeds & Co**.')
      expect(md).toContain('### Core')
      expect(md).toContain('- API: Major outage')
      expect(md).toContain('- Website: Operational')
      expect(md).toContain('- Help desk: Degraded performance')
      expect(md).toContain(
        `### [API errors](${BASE}/status/${page.slug}/incidents/${openIncident.id})`,
      )
      expect(md).toContain('A bad deploy.')
      expect(md).not.toContain('Slow')
      expect(md).toContain('### Database upgrade')
      expect(md).toContain('### Network work')
      expect(md).toContain('- Status: Verifying')
      expect(md).toContain('Checking the links.')
      expect(md).not.toContain('Cancelled window')
      expect(md).toContain(`(${BASE}/status/${page.slug}/api/v2/summary.json)`)
    })

    it('renders an incident as Markdown and 404s for unknown or foreign incidents', async () => {
      const res = await get(
        incidentMarkdownRoute,
        page.slug,
        `/incident-md/${resolvedIncident.id}`,
        {},
        { id: String(resolvedIncident.id) },
      )
      expect(res.status).toBe(200)
      const md = await res.text()
      expect(md.startsWith('# Slow \\<website\\>\n')).toBe(true)
      expect(md).toContain('- Status: Resolved')
      expect(md).toContain('Pages are *slow*.')
      expect(md).toContain('_Affected: Website (Partial outage)_')

      for (const id of [String(foreignIncident.id), 'nope', '999999999']) {
        const missing = await get(
          incidentMarkdownRoute,
          page.slug,
          `/incident-md/${id}`,
          {},
          { id },
        )
        expect(missing.status).toBe(404)
        expect(missing.headers.get('content-type')).toBe('application/problem+json; charset=utf-8')
      }
    })

    it('describes the page in llms.txt', async () => {
      const res = await get(llmsRoute, page.slug, '/llms.txt')
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
      const txt = await res.text()
      expect(txt.startsWith('# Feeds & Co\n\n> Status of **Feeds & Co**.')).toBe(true)
      expect(txt).toContain(`(${BASE}/status/${page.slug}.md)`)
      for (const suffix of [
        '/feed/atom',
        '/feed/json',
        '/rss',
        '/maintenance.ics',
        '/api/v2/status.json',
        '/api/v2/scheduled-maintenances.json',
        '/api/openapi.json',
      ]) {
        expect(txt).toContain(`(${BASE}/status/${page.slug}${suffix})`)
      }
    })

    it('publishes an OpenAPI 3.1 document', async () => {
      const doc = (await (await get(openapiRoute, page.slug, '/api/openapi.json')).json()) as {
        openapi: string
        servers: { url: string }[]
        paths: Record<string, unknown>
      }
      expect(doc.openapi).toBe('3.1.0')
      expect(doc.servers[0].url).toBe(`${BASE}/status/${page.slug}`)
      expect(Object.keys(doc.paths)).toEqual(
        expect.arrayContaining(['/api/v2/summary.json', '/feed/atom', '/maintenance.ics']),
      )
    })
  })

  describe('public API conventions', () => {
    it('sends cache, ETag and CORS headers and answers 304 for a matching If-None-Match', async () => {
      const first = await get(summaryRoute, page.slug, '/api/v2/summary.json')
      expect(first.headers.get('cache-control')).toBe(
        'public, max-age=120, stale-while-revalidate=120',
      )
      expect(first.headers.get('access-control-allow-origin')).toBe('*')
      expect(first.headers.get('access-control-expose-headers')).toBe('ETag')
      const etag = first.headers.get('etag')
      expect(etag).toMatch(/^W\/"[\w-]+"$/)

      for (const handler of [summaryRoute, atomRoute, icsRoute, markdownRoute]) {
        const a = await get(handler, page.slug, '/x')
        const tag = a.headers.get('etag') as string
        const b = await get(handler, page.slug, '/x', { headers: { 'If-None-Match': tag } })
        expect(b.status).toBe(304)
        expect(await b.text()).toBe('')
        expect(b.headers.get('etag')).toBe(tag)
      }

      const stale = await get(summaryRoute, page.slug, '/x', {
        headers: { 'If-None-Match': 'W/"something-else"' },
      })
      expect(stale.status).toBe(200)

      const preflight = summaryOptions()
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-headers')).toBe('If-None-Match')
    })

    it('answers RFC 9457 problem details for unknown pages', async () => {
      const res = await get(summaryRoute, `missing-${run}`, '/api/v2/summary.json')
      expect(res.status).toBe(404)
      expect(res.headers.get('content-type')).toBe('application/problem+json; charset=utf-8')
      expect(await res.json()).toMatchObject({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Status page not found',
        code: 'not-found',
      })
    })

    it('protects password pages: 401 without access, private responses with ?pw=', async () => {
      const handlers = ENDPOINTS
      for (const [handler, suffix] of handlers) {
        const denied = await get(handler, protectedPage.slug, suffix)
        expect(denied.status, suffix).toBe(401)
        expect(denied.headers.get('content-type')).toBe('application/problem+json; charset=utf-8')
        expect(await denied.json()).toMatchObject({ status: 401, code: 'login-required' })

        const allowed = await get(
          handler,
          protectedPage.slug,
          `${suffix}?pw=${encodeURIComponent(PASSWORD)}`,
        )
        expect(allowed.status, suffix).toBe(200)
        expect(allowed.headers.get('cache-control')).toBe('private, no-store')
        expect(allowed.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      }

      const wrong = await get(summaryRoute, protectedPage.slug, '/api/v2/summary.json?pw=wrong')
      expect(wrong.status).toBe(401)
      expect(await wrong.json()).toMatchObject({ code: 'invalid-password' })
    })

    it('honours the email-domain and IP allow-list modes on every endpoint', async () => {
      const settings = await payload.findGlobal({ slug: 'instance-settings' })
      await payload.updateGlobal({ slug: 'instance-settings', data: { trustProxy: true } })
      resetInstanceSettingsCache()
      try {
        const base = {
          organization: org.id,
          published: true,
          groups: [{ name: 'Core', monitors: [{ monitor: web.id }] }],
        }
        const emailPage = await payload.create({
          collection: 'status-pages',
          data: {
            ...base,
            title: 'Feeds Staff',
            slug: `feeds-staff-${run}`,
            access: 'email-domain',
            allowedEmailDomains: [{ domain: 'feeds.example' }],
          } as never,
          overrideAccess: true,
        })
        const ipPage = await payload.create({
          collection: 'status-pages',
          data: {
            ...base,
            title: 'Feeds Office',
            slug: `feeds-office-${run}`,
            access: 'ip-allowlist',
            allowedIpRanges: [{ cidr: '203.0.113.0/24' }],
          } as never,
          overrideAccess: true,
        })

        for (const [handler, suffix] of ENDPOINTS) {
          // Email domain: only the session cookie opens it; `?pw=` means nothing.
          const email = await get(handler, emailPage.slug, `${suffix}?pw=anything`)
          expect(email.status, suffix).toBe(401)
          expect(await email.json()).toMatchObject({ status: 401, code: 'login-required' })

          const outside = await get(handler, ipPage.slug, suffix, {
            headers: { 'X-Forwarded-For': '198.51.100.7' },
          })
          expect(outside.status, suffix).toBe(403)
          expect(outside.headers.get('content-type')).toBe(
            'application/problem+json; charset=utf-8',
          )
          const problem = (await outside.json()) as { code: string; title: string }
          expect(problem).toMatchObject({ code: 'ip-not-allowed', title: 'Forbidden' })
          expect(JSON.stringify(problem)).not.toContain('Feeds Office')

          const inside = await get(handler, ipPage.slug, suffix, {
            headers: { 'X-Forwarded-For': '203.0.113.9' },
          })
          expect(inside.status, suffix).toBe(200)
          expect(inside.headers.get('cache-control')).toBe('private, no-store')
        }
      } finally {
        await payload.updateGlobal({
          slug: 'instance-settings',
          data: { trustProxy: Boolean(settings.trustProxy) },
        })
        resetInstanceSettingsCache()
      }
    })
  })
})
