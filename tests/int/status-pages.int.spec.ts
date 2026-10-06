import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { GET as publicRoute } from '@/app/api/status-pages/[slug]/public/route'
import { GET as resolveDomainRoute } from '@/app/api/status-pages/resolve-domain/route'
import { GET as manifestRoute } from '@/app/status/[slug]/manifest.json/route'
import { GET as rssRoute } from '@/app/status/[slug]/rss/route'
import { overallStatus, type PublicStatusPageData } from '@/server/status-pages/public'
import { renderRss } from '@/server/status-pages/rss'
import type { Monitor, Organization, StatusPage, User } from '@/payload-types'

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+sp-${run}@marmot.test`

type RequestUser = User & { collection: 'users' }

async function as(user: { id: User['id'] }): Promise<RequestUser> {
  const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
  return { ...fresh, collection: 'users' }
}

async function createUser(name: string): Promise<User> {
  return payload.create({
    collection: 'users',
    data: { email: email(name), password: 'password-123', name },
  })
}

async function addMembership(user: User, org: Organization, role: 'member' | 'viewer') {
  const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
  const rows = (fresh.organizations ?? []).map((row) => ({
    id: row.id,
    organization: typeof row.organization === 'object' ? row.organization.id : row.organization,
    role: row.role,
  }))
  await payload.update({
    collection: 'users',
    id: user.id,
    data: { organizations: [...rows, { organization: org.id, role }] },
    depth: 0,
  })
}

const MONITOR_DEFAULTS = {
  type: 'manual' as const,
  active: true,
  interval: 60,
  retryInterval: 60,
  maxRetries: 0,
  resendInterval: 0,
  timeout: 48,
}

const call = <T extends (...args: never[]) => Promise<Response>>(
  handler: T,
  url: string,
  params: Record<string, string>,
) =>
  (
    handler as unknown as (
      req: Request,
      ctx: { params: Promise<typeof params> },
    ) => Promise<Response>
  )(new Request(url), { params: Promise.resolve(params) })

/** Payload wraps field errors as "The following field is invalid"; the message lives in `data`. */
async function expectValidationError(promise: Promise<unknown>, message: RegExp) {
  const error = await promise.then(
    () => null,
    (err: unknown) => err as { data?: { errors?: { message: string }[] } },
  )
  expect(error, 'expected the operation to fail').not.toBeNull()
  const messages = error?.data?.errors?.map((e) => e.message) ?? []
  expect(
    messages.some((m) => message.test(m)),
    `got ${JSON.stringify(messages)}`,
  ).toBe(true)
}

let owner: User
let viewer: User
let outsider: User
let org: Organization
let otherOrg: Organization
let monitor: Monitor
let foreignMonitor: Monitor
let published: StatusPage
let draft: StatusPage

describe('status pages', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })

    owner = await createUser('owner')
    viewer = await createUser('viewer')
    outsider = await createUser('outsider')

    org = await payload.create({
      collection: 'organizations',
      data: { name: 'SP Acme', slug: `sp-acme-${run}` },
      user: await as(owner),
      overrideAccess: false,
    })
    otherOrg = await payload.create({
      collection: 'organizations',
      data: { name: 'SP Other', slug: `sp-other-${run}` },
      user: await as(outsider),
      overrideAccess: false,
    })
    await addMembership(viewer, org, 'viewer')

    monitor = await payload.create({
      collection: 'monitors',
      data: {
        ...MONITOR_DEFAULTS,
        name: 'Website',
        type: 'http',
        url: 'https://example.com',
        organization: org.id,
        status: { lastStatus: 'up', lastCheckAt: new Date().toISOString(), lastPing: 42 },
      },
    })
    foreignMonitor = await payload.create({
      collection: 'monitors',
      data: { ...MONITOR_DEFAULTS, name: 'Foreign', organization: otherOrg.id },
    })

    const now = Date.now()
    for (let i = 0; i < 3; i++) {
      await payload.create({
        collection: 'heartbeats',
        data: {
          monitor: monitor.id,
          organization: org.id,
          status: i === 1 ? 'down' : 'up',
          ping: 40 + i,
          time: new Date(now - (3 - i) * 60_000).toISOString(),
        },
      })
    }

    published = await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'Acme Status',
        slug: `acme-${run}`,
        description: 'Live status of Acme services.',
        published: true,
        customCSS: 'h1 { color: red }',
        domains: [{ hostname: `Status-${run}.Example.com` }],
        groups: [{ name: 'Core', monitors: [{ monitor: monitor.id, sendUrl: true }] }],
      },
      user: await as(owner),
      overrideAccess: false,
    })
    draft = await payload.create({
      collection: 'status-pages',
      data: { organization: org.id, title: 'Acme Draft', slug: `acme-draft-${run}` },
      user: await as(owner),
      overrideAccess: false,
    })
  })

  afterAll(async () => {
    const orgIds = [org?.id, otherOrg?.id].filter(Boolean)
    if (orgIds.length) {
      await payload.delete({ collection: 'incidents', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'status-pages', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'heartbeats', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'monitors', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
    }
    await payload.delete({ collection: 'users', where: { email: { like: `+sp-${run}@` } } })
  })

  describe('collection access', () => {
    const slugsVisibleTo = async (user?: RequestUser) => {
      const { docs } = await payload.find({
        collection: 'status-pages',
        where: { organization: { in: [org.id, otherOrg.id] } },
        user,
        overrideAccess: false,
        disableErrors: true,
        depth: 0,
        limit: 50,
      })
      return docs.map((d) => d.slug).sort()
    }

    it('anonymous visitors only see published pages', async () => {
      expect(await slugsVisibleTo(undefined)).toEqual([published.slug])
    })

    it('organization members (even viewers) see drafts of their organization', async () => {
      expect(await slugsVisibleTo(await as(owner))).toEqual([draft.slug, published.slug].sort())
      expect(await slugsVisibleTo(await as(viewer))).toEqual([draft.slug, published.slug].sort())
    })

    it('members of another organization only see published pages', async () => {
      expect(await slugsVisibleTo(await as(outsider))).toEqual([published.slug])
    })

    it('normalises slugs and hostnames and rejects reserved slugs', async () => {
      expect(published.domains?.[0]?.hostname).toBe(`status-${run}.example.com`)
      await expectValidationError(
        payload.create({
          collection: 'status-pages',
          data: { organization: org.id, title: 'Nope', slug: 'admin' },
          user: await as(owner),
          overrideAccess: false,
        }),
        /reserved/i,
      )
    })

    it('viewers and outsiders cannot create or update pages', async () => {
      await expect(
        payload.create({
          collection: 'status-pages',
          data: { organization: org.id, title: 'Viewer page', slug: `viewer-${run}` },
          user: await as(viewer),
          overrideAccess: false,
        }),
      ).rejects.toThrow()
      await expect(
        payload.update({
          collection: 'status-pages',
          id: published.id,
          data: { title: 'Hijacked' },
          user: await as(outsider),
          overrideAccess: false,
        }),
      ).rejects.toThrow()
    })

    it('refuses monitors from another organization and duplicate hostnames', async () => {
      await expectValidationError(
        payload.update({
          collection: 'status-pages',
          id: published.id,
          data: { groups: [{ name: 'Bad', monitors: [{ monitor: foreignMonitor.id }] }] },
          user: await as(owner),
          overrideAccess: false,
        }),
        /same organization/i,
      )

      await expectValidationError(
        payload.update({
          collection: 'status-pages',
          id: draft.id,
          data: { domains: [{ hostname: `status-${run}.example.com` }] },
          user: await as(owner),
          overrideAccess: false,
        }),
        /already used/i,
      )
    })
  })

  describe('incidents', () => {
    it('derive their organization from the status page and resolve with a timestamp', async () => {
      // Naming another organization is refused by access control before any hook runs.
      await expect(
        payload.create({
          collection: 'incidents',
          data: { statusPage: published.id, organization: otherOrg.id, title: 'Nope' },
          user: await as(owner),
          overrideAccess: false,
        }),
      ).rejects.toThrow(/not allowed/i)

      const incident = await payload.create({
        collection: 'incidents',
        data: {
          statusPage: published.id,
          organization: org.id,
          title: 'Elevated error rates',
          content: 'We are **investigating**.\n\n- API\n- Dashboard',
          style: 'warning',
        },
        user: await as(owner),
        overrideAccess: false,
      })
      const orgId =
        typeof incident.organization === 'object' ? incident.organization.id : incident.organization
      expect(String(orgId)).toBe(String(org.id))
      expect(incident.active).toBe(true)
      expect(incident.pinned).toBe(true)

      const resolved = await payload.update({
        collection: 'incidents',
        id: incident.id,
        data: { active: false },
        user: await as(owner),
        overrideAccess: false,
      })
      expect(resolved.resolvedAt).toBeTruthy()
      expect(resolved.pinned).toBe(false)
    })

    it('are not readable anonymously or by other organizations', async () => {
      const anon = await payload.find({
        collection: 'incidents',
        where: { statusPage: { equals: published.id } },
        overrideAccess: false,
        disableErrors: true,
        depth: 0,
      })
      expect(anon.docs).toHaveLength(0)
      const other = await payload.find({
        collection: 'incidents',
        where: { statusPage: { equals: published.id } },
        user: await as(outsider),
        overrideAccess: false,
        disableErrors: true,
        depth: 0,
      })
      expect(other.docs).toHaveLength(0)
    })
  })

  describe('public API', () => {
    it('returns the public payload for a published page', async () => {
      await payload.create({
        collection: 'incidents',
        data: {
          statusPage: published.id,
          organization: org.id,
          title: 'Scheduled upgrade',
          style: 'info',
        },
        user: await as(owner),
        overrideAccess: false,
      })

      const res = await call(publicRoute, 'http://localhost/api/status-pages/x/public', {
        slug: published.slug,
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('public, max-age=30')

      const body = (await res.json()) as PublicStatusPageData
      expect(body.config).toMatchObject({
        slug: published.slug,
        title: 'Acme Status',
        description: 'Live status of Acme services.',
        theme: 'auto',
        published: true,
        showPoweredBy: true,
        customCSS: 'h1 { color: red }',
      })
      expect(body.config).not.toHaveProperty('organization')
      expect(body.config).not.toHaveProperty('domains')
      expect(body.overall).toBe('up')
      expect(body.maintenance).toEqual([])
      expect(body.groups).toHaveLength(1)
      expect(body.groups[0].name).toBe('Core')
      const m = body.groups[0].monitors[0]
      expect(m).toMatchObject({
        id: String(monitor.id),
        name: 'Website',
        url: 'https://example.com',
        status: 'up',
      })
      expect(m.beats.map((b) => b.status)).toEqual(['up', 'down', 'up'])
      expect(typeof m.uptime24h).toBe('number')
      expect(typeof m.uptime30d).toBe('number')
      // Active incidents only, pinned first.
      expect(body.incidents.map((i) => i.title)).toEqual(['Scheduled upgrade'])
      expect(body.incidents[0]).not.toHaveProperty('organization')
    })

    it('404s for drafts and unknown slugs', async () => {
      const res = await call(publicRoute, 'http://localhost/api/status-pages/x/public', {
        slug: draft.slug,
      })
      expect(res.status).toBe(404)
      const missing = await call(publicRoute, 'http://localhost/api/status-pages/x/public', {
        slug: `nope-${run}`,
      })
      expect(missing.status).toBe(404)
    })

    it('hides monitors that no longer belong to the organization or are paused', async () => {
      await payload.update({ collection: 'monitors', id: monitor.id, data: { active: false } })
      const res = await call(publicRoute, 'http://localhost/api/status-pages/x/public', {
        slug: published.slug,
      })
      const body = (await res.json()) as PublicStatusPageData
      expect(body.groups[0].monitors).toHaveLength(0)
      expect(body.overall).toBe('unknown')
      await payload.update({ collection: 'monitors', id: monitor.id, data: { active: true } })
    })

    it('computes the overall status like Uptime Kuma', () => {
      expect(overallStatus([])).toBe('unknown')
      expect(overallStatus(['unknown'])).toBe('unknown')
      expect(overallStatus(['up', 'up'])).toBe('up')
      expect(overallStatus(['up', 'down'])).toBe('partial')
      expect(overallStatus(['up', 'pending'])).toBe('partial')
      expect(overallStatus(['down', 'pending'])).toBe('down')
      expect(overallStatus(['down', 'maintenance'])).toBe('maintenance')
    })

    it('resolves custom domains to slugs', async () => {
      const res = await resolveDomainRoute(
        new Request(
          `http://localhost/api/status-pages/resolve-domain?host=STATUS-${run}.example.com:443`,
        ),
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ slug: published.slug })

      const unknown = await resolveDomainRoute(
        new Request('http://localhost/api/status-pages/resolve-domain?host=nobody.example.com'),
      )
      expect(unknown.status).toBe(404)
      const invalid = await resolveDomainRoute(
        new Request('http://localhost/api/status-pages/resolve-domain?host=not%20a%20host'),
      )
      expect(invalid.status).toBe(400)
    })
  })

  describe('RSS and manifest', () => {
    it('renders a valid RSS 2.0 document with incidents', async () => {
      const res = await call(rssRoute, `http://localhost/status/${published.slug}/rss`, {
        slug: published.slug,
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/rss+xml')
      const xml = await res.text()
      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
      expect(xml).toContain('<rss version="2.0"')
      expect(xml).toContain('<title>Acme Status status</title>')
      expect(xml).toContain('<title>Scheduled upgrade</title>')
      expect(xml).toContain('<title>[Resolved] Elevated error rates</title>')
      expect(xml).toContain(`<link>http://localhost:3000/status/${published.slug}</link>`)
      // Markdown is rendered and escaped inside <description>.
      expect(xml).toContain('&lt;strong&gt;investigating&lt;/strong&gt;')
      expect(xml).toContain('&lt;ul&gt;&lt;li&gt;API&lt;/li&gt;')
      // Balanced tags.
      expect((xml.match(/<item>/g) ?? []).length).toBe((xml.match(/<\/item>/g) ?? []).length)
    })

    it('404s for unpublished pages', async () => {
      const res = await call(rssRoute, `http://localhost/status/${draft.slug}/rss`, {
        slug: draft.slug,
      })
      expect(res.status).toBe(404)
    })

    it('escapes XML special characters', () => {
      const xml = renderRss({
        title: 'A & B <C>',
        description: '"quoted"',
        link: 'http://x/?a=1&b=2',
        language: 'en',
        feedUrl: 'http://x/rss',
        items: [
          {
            title: '<script>',
            description: "it's",
            link: 'http://x',
            guid: 'g&1',
            pubDate: new Date(0),
          },
        ],
      })
      expect(xml).toContain('<title>A &amp; B &lt;C&gt;</title>')
      expect(xml).toContain('<link>http://x/?a=1&amp;b=2</link>')
      expect(xml).toContain('<title>&lt;script&gt;</title>')
      expect(xml).toContain('<guid isPermaLink="false">g&amp;1</guid>')
      expect(xml).toContain('<pubDate>Thu, 01 Jan 1970 00:00:00 GMT</pubDate>')
    })

    it('serves a web app manifest', async () => {
      const res = await call(
        manifestRoute,
        `http://localhost/status/${published.slug}/manifest.json`,
        {
          slug: published.slug,
        },
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        name: 'Acme Status',
        start_url: `/status/${published.slug}`,
        display: 'standalone',
        icons: [],
      })
    })
  })
})
