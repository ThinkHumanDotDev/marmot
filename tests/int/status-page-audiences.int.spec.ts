import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest'

import config from '@payload-config'
import { GET as previewRoute } from '@/app/api/orgs/[orgId]/status-pages/[id]/audiences/[audienceId]/preview/route'
import {
  GET as listAudiencesRoute,
  POST as createAudienceRoute,
} from '@/app/api/orgs/[orgId]/status-pages/[id]/audiences/route'
import { POST as accessRoute } from '@/app/api/status-pages/[slug]/access/route'
import { GET as chartsRoute } from '@/app/api/status-pages/[slug]/charts/route'
import { GET as eventRoute } from '@/app/api/status-pages/[slug]/events/[kind]/[id]/route'
import { GET as metricsRoute } from '@/app/api/status-pages/[slug]/metrics/route'
import { GET as eventsRoute } from '@/app/api/status-pages/[slug]/events/route'
import { GET as publicRoute } from '@/app/api/status-pages/[slug]/public/route'
import { POST as subscribeRoute } from '@/app/api/status-pages/[slug]/subscribe/route'
import {
  GET as subscriptionRoute,
  PATCH as patchSubscriptionRoute,
} from '@/app/api/status-pages/[slug]/subscriptions/[token]/route'
import { GET as componentsRoute } from '@/app/status/[slug]/api/v2/components.json/route'
import { GET as incidentsRoute } from '@/app/status/[slug]/api/v2/incidents.json/route'
import { GET as maintenancesRoute } from '@/app/status/[slug]/api/v2/scheduled-maintenances.json/route'
import { GET as statusRoute } from '@/app/status/[slug]/api/v2/status.json/route'
import { GET as summaryRoute } from '@/app/status/[slug]/api/v2/summary.json/route'
import { GET as pageBadgeRoute } from '@/app/status/[slug]/badge.svg/route'
import { GET as eventMarkdownRoute } from '@/app/status/[slug]/event-md/[kind]/[id]/route'
import { GET as atomRoute } from '@/app/status/[slug]/feed/atom/route'
import { GET as jsonFeedRoute } from '@/app/status/[slug]/feed/json/route'
import { GET as markdownRoute } from '@/app/status/[slug]/index.md/route'
import { GET as llmsRoute } from '@/app/status/[slug]/llms.txt/route'
import { GET as icsRoute } from '@/app/status/[slug]/maintenance.ics/route'
import { GET as rssRoute } from '@/app/status/[slug]/rss/route'
import { GET as widgetRoute } from '@/app/status/[slug]/widget.js/route'
import { addOrgMembership } from '@/access/memberships'
import {
  audienceComponents,
  audienceSubscriberWants,
  incidentComponentIds,
  isAudienceMember,
} from '@/lib/status-page-audiences'
import type {
  Incident,
  Maintenance,
  Monitor,
  Organization,
  StatusPage,
  StatusPageAudience,
  StatusPageViewer,
  User,
} from '@/payload-types'
import { serveBadge } from '@/server/badges'
import { renderStatusPageBadge, statusPageBadgeOptions } from '@/server/badges/status-page'
import { closeRateLimitStore } from '@/server/security/rate-limit'
import { resetInstanceSettingsCache } from '@/server/settings'
import { accessCookieName, signAccessToken } from '@/server/status-pages/access'
import {
  findPageAudiences,
  lockAudiencePage,
  scopePageForVisitor,
} from '@/server/status-pages/audiences'
import { closeMagicLinkStore, settleMagicLinkDeliveries } from '@/server/status-pages/magic-link'
import { findPublishedStatusPage } from '@/server/status-pages/public'
import {
  countRecipients,
  loadPageContext,
  namesForSubscriber,
} from '@/server/status-pages/subscribers/batches'
import { subscriberLinkToken } from '@/server/status-pages/subscribers/tokens'

let payload: Payload

const run = Date.now().toString(36)
const BASE = 'http://localhost:3000'
const PASSWORD = 'password-123'
const ACME = `acme-${run}.com`
const BETA = `beta-${run}.com`
const alice = `alice@${ACME}`
const bob = `bob@${BETA}`
const mallory = `mallory@other-${run}.com`

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

const call = (
  handler: unknown,
  url: string,
  params: Record<string, string>,
  init: RequestInit = {},
): Promise<Response> =>
  (handler as Handler)(new Request(url, init), { params: Promise.resolve(params) })

const iso = (ms: number) => new Date(Date.now() + ms).toISOString()
const HOUR = 60 * 60_000

let owner: User
let org: Organization
let acmeMonitor: Monitor
let betaMonitor: Monitor
let page: StatusPage
let acmeC: string
let betaC: string
let docsC: string
let acme: StatusPageAudience
let beta: StatusPageAudience
let acmeIncident: Incident
let betaIncident: Incident
let wideIncident: Incident
let acmeWork: Maintenance
let betaWork: Maintenance
let acmeOccurrence: string
let betaOccurrence: string
let aliceCookie: string
let bobCookie: string
let malloryCookie: string
let sendEmail: MockInstance<Payload['sendEmail']>

type RequestUser = User & { collection: 'users' }

async function as(user: { id: User['id'] }): Promise<RequestUser> {
  const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
  return { ...fresh, collection: 'users' }
}

async function viewerCookie(email: string): Promise<string> {
  const viewer = (await payload.create({
    collection: 'status-page-viewers',
    data: {
      organization: org.id,
      page: page.id,
      email,
      status: 'active',
    } as RequiredDataFromCollectionSlug<'status-page-viewers'>,
    overrideAccess: true,
  })) as StatusPageViewer
  const fresh = await payload.findByID({
    collection: 'status-pages',
    id: page.id,
    depth: 0,
    overrideAccess: true,
  })
  const token = await signAccessToken(fresh, { viewer: viewer.id })
  return `${accessCookieName(page.id)}=${token}`
}

/** GET of a `/status/:slug/…` route as the visitor holding `cookie`. */
const visit = (
  handler: unknown,
  suffix: string,
  cookie: string,
  extra: Record<string, string> = {},
) =>
  call(
    handler,
    `${BASE}/status/${page.slug}${suffix}`,
    { slug: page.slug, ...extra },
    {
      headers: { Cookie: cookie },
    },
  )

const BETA_SECRETS = ['Beta API', 'Beta outage', 'Beta upgrade']
const ACME_SECRETS = ['Acme API', 'Acme outage', 'Acme upgrade']

function expectOnly(body: string, visible: string[], hidden: string[], where: string) {
  for (const text of visible) expect(body, `${where} shows "${text}"`).toContain(text)
  for (const text of hidden) expect(body, `${where} hides "${text}"`).not.toContain(text)
}

async function createMaintenance(title: string, monitor: Monitor): Promise<[Maintenance, string]> {
  const doc = (await payload.create({
    collection: 'maintenance',
    overrideAccess: true,
    depth: 0,
    data: {
      organization: org.id,
      strategy: 'manual',
      timezone: 'UTC',
      active: false,
      reminders: [],
      title,
      monitors: [monitor.id],
      statusPages: [page.id],
    } as RequiredDataFromCollectionSlug<'maintenance'>,
  })) as Maintenance
  const occurrence = await payload.create({
    collection: 'maintenance-occurrences',
    overrideAccess: true,
    depth: 0,
    data: {
      maintenance: doc.id,
      start: iso(-3 * HOUR),
      end: iso(-2 * HOUR),
      startedAt: iso(-3 * HOUR),
      completedAt: iso(-2 * HOUR),
      state: 'completed',
    } as RequiredDataFromCollectionSlug<'maintenance-occurrences'>,
  })
  return [doc, String(occurrence.publicId)]
}

describe('audience-specific status pages (#151)', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    resetInstanceSettingsCache()
    sendEmail = vi.spyOn(payload, 'sendEmail').mockResolvedValue(undefined)

    owner = await payload.create({
      collection: 'users',
      data: { email: `owner+aud-${run}@marmot.test`, password: PASSWORD, name: 'owner' },
    })
    org = await payload.create({
      collection: 'organizations',
      data: { name: 'Audience Acme', slug: `aud-${run}` },
      user: await as(owner),
      overrideAccess: false,
    })
    await addOrgMembership({ payload, userId: owner.id, orgId: org.id, role: 'owner' }).catch(
      () => undefined,
    )

    const status = { lastStatus: 'up' as const, lastCheckAt: iso(-60_000), lastPing: 9 }
    acmeMonitor = await payload.create({
      collection: 'monitors',
      data: { ...MONITOR_DEFAULTS, name: 'Acme API', organization: org.id, status },
    })
    betaMonitor = await payload.create({
      collection: 'monitors',
      data: { ...MONITOR_DEFAULTS, name: 'Beta API', organization: org.id, status },
    })

    page = await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'Customer status',
        slug: `aud-page-${run}`,
        published: true,
        access: 'audience',
        subscriptions: { enabled: true, channels: ['email'], deliveryMode: 'review' },
        groups: [
          { name: 'Acme cluster', monitors: [{ monitor: acmeMonitor.id, showChart: true }] },
          { name: 'Beta cluster', monitors: [{ monitor: betaMonitor.id, showChart: true }] },
          { name: 'Shared', monitors: [{ type: 'static', name: 'Docs site' }] },
        ],
      } as never,
      overrideAccess: true,
    })
    acmeC = String(page.groups?.[0]?.monitors?.[0]?.id)
    betaC = String(page.groups?.[1]?.monitors?.[0]?.id)
    docsC = String(page.groups?.[2]?.monitors?.[0]?.id)

    acme = await payload.create({
      collection: 'status-page-audiences',
      data: {
        statusPage: page.id,
        organization: org.id,
        name: 'Acme Corp',
        components: [acmeC, docsC],
        emails: [alice.toUpperCase()],
      },
      user: await as(owner),
      overrideAccess: false,
    })
    beta = await payload.create({
      collection: 'status-page-audiences',
      data: {
        statusPage: page.id,
        organization: org.id,
        name: 'Beta Ltd',
        components: [betaC, docsC],
        emailDomains: [`@${BETA}`],
      },
      overrideAccess: true,
    })

    const incident = (title: string, component: string | null) =>
      payload.create({
        collection: 'incidents',
        data: {
          statusPage: page.id,
          title,
          updates: [
            {
              status: 'investigating',
              message: `${title} details`,
              postedAt: iso(-HOUR),
              components: component ? [{ component, impact: 'major_outage' }] : [],
            },
          ],
        } as RequiredDataFromCollectionSlug<'incidents'>,
        depth: 0,
        overrideAccess: true,
      })
    acmeIncident = await incident('Acme outage', acmeC)
    betaIncident = await incident('Beta outage', betaC)
    wideIncident = await incident('Global notice', null)
    ;[acmeWork, acmeOccurrence] = await createMaintenance('Acme upgrade', acmeMonitor)
    ;[betaWork, betaOccurrence] = await createMaintenance('Beta upgrade', betaMonitor)

    aliceCookie = await viewerCookie(alice)
    bobCookie = await viewerCookie(bob)
    malloryCookie = await viewerCookie(mallory)
  })

  afterAll(async () => {
    sendEmail?.mockRestore()
    await settleMagicLinkDeliveries()
    if (org?.id) {
      for (const collection of ['incidents', 'maintenance', 'metrics'] as const) {
        await payload.delete({
          collection,
          where: { organization: { equals: org.id } },
          overrideAccess: true,
        })
      }
      await payload.delete({
        collection: 'status-pages',
        where: { organization: { equals: org.id } },
        overrideAccess: true,
      })
      await payload.delete({
        collection: 'monitors',
        where: { organization: { equals: org.id } },
        overrideAccess: true,
      })
      await payload.delete({ collection: 'organizations', id: org.id, overrideAccess: true })
    }
    if (owner?.id) await payload.delete({ collection: 'users', id: owner.id, overrideAccess: true })
    await closeMagicLinkStore()
    await closeRateLimitStore()
  })

  describe('rules', () => {
    it('matches members by address or domain and unions their components', () => {
      expect(isAudienceMember(acme, alice)).toBe(true)
      expect(isAudienceMember(acme, `eve@${ACME}`)).toBe(false)
      expect(isAudienceMember(beta, `anyone@${BETA}`)).toBe(true)
      expect([...audienceComponents([acme, beta])].sort()).toEqual([acmeC, betaC, docsC].sort())
      expect([...incidentComponentIds(acmeIncident)]).toEqual([acmeC])
    })

    it('reaches subscribers only within their audiences', () => {
      const allowed = new Set([acmeC, docsC])
      expect(audienceSubscriberWants([], allowed, [acmeC])).toBe(true)
      expect(audienceSubscriberWants([], allowed, [betaC])).toBe(false)
      expect(audienceSubscriberWants([], allowed, [])).toBe(true)
      expect(audienceSubscriberWants([docsC], allowed, [acmeC])).toBe(false)
      expect(audienceSubscriberWants([], null, [])).toBe(false)
    })

    it('normalizes audiences and refuses components of other pages', async () => {
      expect(acme.emails).toEqual([alice])
      expect(beta.emailDomains).toEqual([BETA])
      await expect(
        payload.create({
          collection: 'status-page-audiences',
          data: {
            statusPage: page.id,
            organization: org.id,
            name: 'Broken',
            components: ['not-a-component'],
          },
          overrideAccess: true,
        }),
      ).rejects.toThrow()
      await expect(
        payload.create({
          collection: 'status-page-audiences',
          data: { statusPage: page.id, organization: org.id, name: 'Acme Corp' },
          overrideAccess: true,
        }),
      ).rejects.toThrow()
    })

    it('locks audience pages until they are scoped', async () => {
      const found = await findPublishedStatusPage(payload, page.slug)
      expect(found?.groups).toEqual([])
      // A copy made by spreading stays locked: nothing to scope from.
      expect(
        scopePageForVisitor({ ...found! }, { allowed: true, audience: undefined }).groups,
      ).toEqual([])
      const scoped = scopePageForVisitor(found!, {
        allowed: true,
        audience: { audiences: [String(acme.id)], components: [acmeC] },
      })
      expect(scoped.groups?.map((g) => g.name)).toEqual(['Acme cluster'])
      expect(JSON.stringify(lockAudiencePage(page))).not.toContain('Beta cluster')
    })
  })

  describe('access', () => {
    it('admits members of an audience and nobody else', async () => {
      for (const cookie of ['', malloryCookie]) {
        const res = await call(
          publicRoute,
          `${BASE}/api/status-pages/${page.slug}/public`,
          {
            slug: page.slug,
          },
          { headers: cookie ? { Cookie: cookie } : {} },
        )
        expect(res.status).toBe(401)
      }
      const res = await call(
        publicRoute,
        `${BASE}/api/status-pages/${page.slug}/public`,
        {
          slug: page.slug,
        },
        { headers: { Cookie: aliceCookie } },
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('private, no-store')
    })

    it('sends sign-in links to members only', async () => {
      sendEmail.mockClear()
      const ask = (email: string) =>
        call(
          accessRoute,
          `${BASE}/api/status-pages/${page.slug}/access`,
          { slug: page.slug },
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-forwarded-for': `198.51.100.${email.length}`,
            },
            body: JSON.stringify({ email }),
          },
        )
      expect((await ask(`carol@${BETA}`)).status).toBe(202)
      expect((await ask(mallory)).status).toBe(202)
      await settleMagicLinkDeliveries()
      const recipients = sendEmail.mock.calls.map(([message]) => (message as { to: string }).to)
      expect(recipients).toEqual([`carol@${BETA}`])
    })

    it('signs a viewer out when no audience lists them any more', async () => {
      const cookie = await viewerCookie(`dave@${ACME}`)
      const get = () =>
        call(
          publicRoute,
          `${BASE}/api/status-pages/${page.slug}/public`,
          { slug: page.slug },
          {
            headers: { Cookie: cookie },
          },
        )
      expect((await get()).status).toBe(401)
      await payload.update({
        collection: 'status-page-audiences',
        id: acme.id,
        data: { emails: [alice, `dave@${ACME}`] },
        overrideAccess: true,
      })
      expect((await get()).status).toBe(200)
      await payload.update({
        collection: 'status-page-audiences',
        id: acme.id,
        data: { emails: [alice] },
        overrideAccess: true,
      })
      expect((await get()).status).toBe(401)
    })
  })

  describe('every public route shows only the audience’s components and events', () => {
    it('public JSON', async () => {
      const res = await call(
        publicRoute,
        // Query parameters cannot widen the scope.
        `${BASE}/api/status-pages/${page.slug}/public?audience=${beta.id}&component=${betaC}`,
        { slug: page.slug },
        { headers: { Cookie: aliceCookie } },
      )
      const body = await res.text()
      expectOnly(
        body,
        ['Acme API', 'Acme outage', 'Acme upgrade', 'Docs site', 'Global notice'],
        BETA_SECRETS,
        'public JSON',
      )
      const data = JSON.parse(body) as { groups: { name: string }[]; overall: string }
      expect(data.groups.map((g) => g.name)).toEqual(['Acme cluster', 'Shared'])

      const forBob = await (
        await call(
          publicRoute,
          `${BASE}/api/status-pages/${page.slug}/public`,
          { slug: page.slug },
          {
            headers: { Cookie: bobCookie },
          },
        )
      ).text()
      expectOnly(
        forBob,
        ['Beta API', 'Beta outage', 'Beta upgrade', 'Docs site', 'Global notice'],
        ACME_SECRETS,
        'public JSON (Beta)',
      )
    })

    it('history and permalinks', async () => {
      const history = await call(
        eventsRoute,
        `${BASE}/api/status-pages/${page.slug}/events?component=${betaC}`,
        { slug: page.slug },
        { headers: { Cookie: aliceCookie } },
      )
      const filtered = (await history.json()) as { filters: { component: string | null } }
      expect(filtered.filters.component).toBeNull()
      const all = await (
        await call(
          eventsRoute,
          `${BASE}/api/status-pages/${page.slug}/events`,
          { slug: page.slug },
          {
            headers: { Cookie: aliceCookie },
          },
        )
      ).text()
      expectOnly(all, ['Acme outage', 'Acme upgrade', 'Global notice'], BETA_SECRETS, 'history')

      const permalink = (kind: string, id: string, cookie: string) =>
        call(
          eventRoute,
          `${BASE}/api/status-pages/${page.slug}/events/${kind}/${id}`,
          {
            slug: page.slug,
            kind,
            id,
          },
          { headers: { Cookie: cookie } },
        )
      expect((await permalink('incident', String(betaIncident.publicId), aliceCookie)).status).toBe(
        404,
      )
      expect((await permalink('maintenance', betaOccurrence, aliceCookie)).status).toBe(404)
      expect((await permalink('incident', String(acmeIncident.publicId), aliceCookie)).status).toBe(
        200,
      )
      expect((await permalink('incident', String(betaIncident.publicId), bobCookie)).status).toBe(
        200,
      )
      expect((await permalink('incident', String(wideIncident.publicId), bobCookie)).status).toBe(
        200,
      )
      expect((await permalink('maintenance', acmeOccurrence, bobCookie)).status).toBe(404)
    })

    it('feeds, calendar, Markdown and llms.txt', async () => {
      for (const [handler, suffix] of [
        [rssRoute, '/rss'],
        [atomRoute, '/feed/atom'],
        [jsonFeedRoute, '/feed/json'],
        [markdownRoute, '/index.md'],
        [llmsRoute, '/llms.txt'],
      ] as const) {
        const res = await visit(handler, suffix, aliceCookie)
        expect(res.status, suffix).toBe(200)
        expect(res.headers.get('cache-control'), suffix).toBe('private, no-store')
        expectOnly(await res.text(), suffix === '/llms.txt' ? [] : ['Acme'], BETA_SECRETS, suffix)
      }
      const ics = await (await visit(icsRoute, '/maintenance.ics', aliceCookie)).text()
      expectOnly(ics, ['Acme upgrade'], BETA_SECRETS, 'maintenance.ics')

      const md = (kind: string, id: string) =>
        visit(eventMarkdownRoute, `/event-md/${kind}/${id}`, aliceCookie, { kind, id })
      expect((await md('incident', String(betaIncident.publicId))).status).toBe(404)
      expect((await md('maintenance', betaOccurrence)).status).toBe(404)
      expect((await md('incident', String(acmeIncident.publicId))).status).toBe(200)
    })

    it('Statuspage-compatible JSON', async () => {
      for (const [handler, suffix] of [
        [summaryRoute, '/api/v2/summary.json'],
        [statusRoute, '/api/v2/status.json'],
        [componentsRoute, '/api/v2/components.json'],
        [incidentsRoute, '/api/v2/incidents.json'],
        [maintenancesRoute, '/api/v2/scheduled-maintenances.json'],
      ] as const) {
        const res = await visit(handler, suffix, bobCookie)
        expect(res.status, suffix).toBe(200)
        expectOnly(await res.text(), [], ACME_SECRETS, suffix)
      }
      const incidents = (await (
        await visit(incidentsRoute, '/api/v2/incidents.json', bobCookie)
      ).json()) as {
        incidents: { name: string }[]
      }
      expect(incidents.incidents.map((i) => i.name).sort()).toEqual([
        'Beta outage',
        'Global notice',
      ])
      const components = (await (
        await visit(componentsRoute, '/api/v2/components.json', bobCookie)
      ).json()) as { components: { name: string }[] }
      expect(components.components.map((c) => c.name)).toContain('Beta API')
      expect(components.components.map((c) => c.name)).not.toContain('Acme API')
    })

    it('latency charts', async () => {
      const charts = (cookie: string, query = '') =>
        call(
          chartsRoute,
          `${BASE}/api/status-pages/${page.slug}/charts${query}`,
          { slug: page.slug },
          {
            headers: { Cookie: cookie },
          },
        )
      const all = await charts(aliceCookie)
      expect(all.status).toBe(200)
      expectOnly(await all.text(), ['Acme API'], ['Beta API'], 'charts')
      expect((await charts(aliceCookie, `?component=${betaC}`)).status).toBe(404)
      expect((await charts(bobCookie, `?component=${betaC}`)).status).toBe(200)
    })

    it('custom metrics', async () => {
      const metric = (name: string, monitor: Monitor | null) =>
        payload.create({
          collection: 'metrics',
          overrideAccess: true,
          depth: 0,
          data: {
            organization: org.id,
            name,
            source: monitor ? 'monitor' : 'push',
            ...(monitor ? { monitor: monitor.id } : {}),
            visible: true,
            statusPages: [page.id],
          } as RequiredDataFromCollectionSlug<'metrics'>,
        })
      const acmeMetric = await metric('Acme latency metric', acmeMonitor)
      const betaMetric = await metric('Beta latency metric', betaMonitor)
      await metric('Fleet size metric', null)

      const metrics = (cookie: string, query = '') =>
        call(
          metricsRoute,
          `${BASE}/api/status-pages/${page.slug}/metrics${query}`,
          { slug: page.slug },
          { headers: { Cookie: cookie } },
        )
      const all = await metrics(aliceCookie)
      expect(all.status).toBe(200)
      expectOnly(
        await all.text(),
        ['Acme latency metric', 'Fleet size metric'],
        ['Beta latency metric'],
        'metrics',
      )
      expect((await metrics(aliceCookie, `?metric=${betaMetric.id}`)).status).toBe(404)
      expect((await metrics(aliceCookie, `?metric=${acmeMetric.id}`)).status).toBe(200)
      expect((await metrics(bobCookie, `?metric=${betaMetric.id}`)).status).toBe(200)
      expect((await metrics(bobCookie, `?metric=${acmeMetric.id}`)).status).toBe(404)
      expect((await metrics(malloryCookie)).status).toBe(401)
    })

    it('badges and the widget', async () => {
      const options = statusPageBadgeOptions(new URLSearchParams())
      const badge = await (await visit(pageBadgeRoute, '/badge.svg', aliceCookie)).text()
      expect(badge).toBe(renderStatusPageBadge('major', options))

      // Bob's audience has an outage too, but not Acme's: the shared docs component alone is fine.
      await payload.update({
        collection: 'status-page-audiences',
        id: beta.id,
        data: { components: [docsC] },
        overrideAccess: true,
      })
      const docsOnly = await (await visit(pageBadgeRoute, '/badge.svg', bobCookie)).text()
      expect(docsOnly).not.toBe(renderStatusPageBadge('major', options))
      await payload.update({
        collection: 'status-page-audiences',
        id: beta.id,
        data: { components: [betaC, docsC] },
        overrideAccess: true,
      })

      const monitorBadge = (monitor: Monitor, cookie: string) =>
        serveBadge(
          payload,
          new Request(`${BASE}/api/badge/${monitor.id}/status`, { headers: { Cookie: cookie } }),
          String(monitor.id),
          ['status'],
        )
      expect((await monitorBadge(betaMonitor, aliceCookie)).status).toBe(404)
      expect((await monitorBadge(acmeMonitor, aliceCookie)).status).toBe(200)
      expect((await monitorBadge(betaMonitor, bobCookie)).status).toBe(200)

      const widget = await visit(widgetRoute, '/widget.js', aliceCookie)
      expect(widget.status).toBe(404)
    })
  })

  describe('subscribers', () => {
    it('binds a subscription to the visitor’s audiences and scopes its management', async () => {
      const res = await call(
        subscribeRoute,
        `${BASE}/api/status-pages/${page.slug}/subscribe`,
        {
          slug: page.slug,
        },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', Cookie: aliceCookie },
          body: JSON.stringify({ channel: 'email', target: alice, audiences: [String(beta.id)] }),
        },
      )
      expect(res.status).toBe(202)

      const refused = await call(
        subscribeRoute,
        `${BASE}/api/status-pages/${page.slug}/subscribe`,
        {
          slug: page.slug,
        },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', Cookie: aliceCookie },
          body: JSON.stringify({ channel: 'email', target: `x+${alice}`, components: [betaC] }),
        },
      )
      expect(refused.status).toBe(400)

      const { docs } = await payload.find({
        collection: 'status-page-subscribers',
        where: { and: [{ statusPage: { equals: page.id } }, { target: { equals: alice } }] },
        depth: 0,
        overrideAccess: true,
        showHiddenFields: true,
      })
      const subscriber = docs[0]
      expect(subscriber.audiences?.map(String)).toEqual([String(acme.id)])
      await payload.update({
        collection: 'status-page-subscribers',
        id: subscriber.id,
        data: { confirmedAt: new Date().toISOString() },
        overrideAccess: true,
      })

      const token = subscriberLinkToken(subscriber)
      const manage = (init: RequestInit = {}) =>
        call(
          init.method === 'PATCH' ? patchSubscriptionRoute : subscriptionRoute,
          `${BASE}/api/status-pages/${page.slug}/subscriptions/${token}`,
          { slug: page.slug, token },
          init,
        )
      expect((await manage()).status).toBe(200)
      const patch = (components: string[]) =>
        manage({
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ components }),
        })
      expect((await patch([betaC])).status).toBe(400)
      expect((await patch([acmeC])).status).toBe(200)
      expect((await patch([])).status).toBe(200)

      // Owner-added subscriber without an audience: an audience page sends it nothing.
      await payload.create({
        collection: 'status-page-subscribers',
        data: {
          statusPage: page.id,
          organization: org.id,
          channel: 'email',
          target: `ops@${BETA}`,
          source: 'added_by_owner',
        } as RequiredDataFromCollectionSlug<'status-page-subscribers'>,
        overrideAccess: true,
      })

      const reach = async (components: string[]) =>
        (await countRecipients(payload, page, components)).total
      expect(await reach([acmeC])).toBe(1)
      expect(await reach([betaC])).toBe(0)
      expect(await reach([])).toBe(1)

      const ctx = await loadPageContext(payload, page.id)
      const names = namesForSubscriber(ctx!, subscriber)
      expect([...names.values()]).toContain('Acme API')
      expect([...names.values()]).not.toContain('Beta API')
    })

    it('refuses audiences of another page on subscribers', async () => {
      const other = await payload.create({
        collection: 'status-pages',
        data: { organization: org.id, title: 'Other', slug: `aud-other-${run}` } as never,
        overrideAccess: true,
      })
      await expect(
        payload.create({
          collection: 'status-page-subscribers',
          data: {
            statusPage: other.id,
            organization: org.id,
            channel: 'email',
            target: `x@${ACME}`,
            audiences: [acme.id],
          } as RequiredDataFromCollectionSlug<'status-page-subscribers'>,
          overrideAccess: true,
        }),
      ).rejects.toThrow()
    })
  })

  describe('builder', () => {
    it('lists, creates and previews audiences for members', async () => {
      const { token } = await payload.login({
        collection: 'users',
        data: { email: owner.email, password: PASSWORD },
      })
      const headers = { Cookie: `payload-token=${token}`, Origin: BASE }
      const params = { orgId: String(org.id), id: String(page.id) }
      const base = `${BASE}/api/orgs/${org.id}/status-pages/${page.id}/audiences`

      const list = await call(listAudiencesRoute, base, params, { headers })
      expect(list.status).toBe(200)
      expect(((await list.json()) as { docs: unknown[] }).docs).toHaveLength(2)

      const created = await call(createAudienceRoute, base, params, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Docs only', components: [docsC] }),
      })
      expect(created.status).toBe(201)
      expect((await findPageAudiences(payload, page.id)).map((a) => a.name)).toContain('Docs only')

      const preview = await call(
        previewRoute,
        `${base}/${acme.id}/preview`,
        {
          ...params,
          audienceId: String(acme.id),
        },
        { headers },
      )
      expect(preview.status).toBe(200)
      expectOnly(
        await preview.text(),
        ['Acme API', 'Acme outage', 'Global notice'],
        BETA_SECRETS,
        'preview',
      )

      const anonymous = await call(previewRoute, `${base}/${acme.id}/preview`, {
        ...params,
        audienceId: String(acme.id),
      })
      expect(anonymous.status).toBe(401)
    })
  })

  it('keeps maintenance of other audiences out of the uptime bars', async () => {
    const res = await call(
      publicRoute,
      `${BASE}/api/status-pages/${page.slug}/public`,
      {
        slug: page.slug,
      },
      { headers: { Cookie: aliceCookie } },
    )
    const body = await res.text()
    expect(body).not.toContain(betaWork.title)
    expect(body).toContain(acmeWork.title)
  })
})
