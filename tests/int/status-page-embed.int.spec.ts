import { gzipSync } from 'node:zlib'

import { NextRequest } from 'next/server'
import { getPayload, type Payload } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import { PATCH as patchPageRoute } from '@/app/api/orgs/[orgId]/status-pages/[id]/route'
import { GET as embedPolicyRoute } from '@/app/api/status-pages/[slug]/embed-policy/route'
import { GET as resolveDomainRoute } from '@/app/api/status-pages/resolve-domain/route'
import { GET as statusRoute } from '@/app/status/[slug]/api/v2/status.json/route'
import { GET as widgetRoute } from '@/app/status/[slug]/widget.js/route'
import {
  EMBED_THEME_HEADER,
  frameAncestorsFor,
  parseEmbedSections,
  statusPageEmbedUrl,
} from '@/lib/status-page-embed'
import { proxy } from '@/proxy'
import { closeRateLimitStore } from '@/server/security/rate-limit'
import { resetInstanceSettingsCache } from '@/server/settings'
import type { Organization, StatusPage, User } from '@/payload-types'

let payload: Payload

const run = Date.now().toString(36)
const PASSWORD = 'password-123'
const userEmail = (name: string) => `${name}+embed-${run}@marmot.test`
const BASE = 'http://localhost:3000'

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>

const call = (
  handler: unknown,
  url: string,
  params: Record<string, string>,
  init: RequestInit = {},
): Promise<Response> =>
  (handler as Handler)(new Request(url, init), { params: Promise.resolve(params) })

async function as(user: { id: User['id'] }) {
  const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
  return { ...fresh, collection: 'users' as const }
}

async function sessionHeaders(name: string): Promise<Record<string, string>> {
  const { token } = await payload.login({
    collection: 'users',
    data: { email: userEmail(name), password: PASSWORD },
  })
  return { Cookie: `payload-token=${token}`, Origin: BASE, 'Content-Type': 'application/json' }
}

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

/**
 * The proxy looks pages up over HTTP; in tests those requests go straight to the route handlers.
 */
function routeProxyFetches() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const policy = /^\/api\/status-pages\/([^/]+)\/embed-policy$/.exec(url.pathname)
    if (policy) return call(embedPolicyRoute, url.href, { slug: policy[1] })
    if (url.pathname === '/api/status-pages/resolve-domain') {
      return resolveDomainRoute(new Request(url.href))
    }
    throw new Error(`unexpected fetch ${url.href}`)
  })
}

const proxyRequest = (path: string, headers: Record<string, string> = {}) =>
  proxy(new NextRequest(new URL(path, BASE), { headers }))

let owner: User
let viewer: User
let org: Organization
let page: StatusPage

async function createPage(slug: string, data: Partial<StatusPage> = {}): Promise<StatusPage> {
  return payload.create({
    collection: 'status-pages',
    data: { organization: org.id, title: `Embed ${slug}`, slug: `embed-${slug}-${run}`, ...data },
    overrideAccess: true,
  })
}

describe('status page embedding (#109)', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    resetInstanceSettingsCache()
    owner = await payload.create({
      collection: 'users',
      data: { email: userEmail('owner'), password: PASSWORD, name: 'owner' },
    })
    viewer = await payload.create({
      collection: 'users',
      data: { email: userEmail('viewer'), password: PASSWORD, name: 'viewer' },
    })
    org = await payload.create({
      collection: 'organizations',
      data: { name: 'Embed Acme', slug: `embed-acme-${run}` },
      user: await as(owner),
      overrideAccess: false,
    })
    await addOrgMembership({ payload, userId: viewer.id, orgId: org.id, role: 'viewer' })
    page = await createPage('main', {
      published: true,
      autoRefreshInterval: 60,
      domains: [{ hostname: `status-${run}.embed.test` }],
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await payload.updateGlobal({ slug: 'instance-settings', data: { trustProxy: false } })
    resetInstanceSettingsCache()
    if (org?.id) {
      await payload.delete({
        collection: 'status-pages',
        where: { organization: { equals: org.id } },
        overrideAccess: true,
      })
      await payload.delete({ collection: 'organizations', id: org.id, overrideAccess: true })
    }
    for (const user of [owner, viewer]) {
      if (user?.id) await payload.delete({ collection: 'users', id: user.id, overrideAccess: true })
    }
    await closeRateLimitStore()
  })

  describe('settings', () => {
    it('is off by default', () => {
      expect(page.allowEmbedding).toBe('off')
      expect(frameAncestorsFor(page)).toBe("'none'")
    })

    it('normalizes and de-duplicates origins, and rejects anything that is not an origin', async () => {
      const updated = await payload.update({
        collection: 'status-pages',
        id: page.id,
        data: {
          allowEmbedding: 'origins',
          embedOrigins: [
            { origin: ' HTTPS://Docs.Acme.com/ ' },
            { origin: 'https://docs.acme.com' },
            { origin: 'https://*.acme.com' },
            { origin: 'http://localhost:8080' },
          ],
        },
        overrideAccess: true,
      })
      expect(updated.embedOrigins?.map((row) => row.origin)).toEqual([
        'https://docs.acme.com',
        'https://*.acme.com',
        'http://localhost:8080',
      ])
      expect(frameAncestorsFor(updated)).toBe(
        'https://docs.acme.com https://*.acme.com http://localhost:8080',
      )

      for (const origin of [
        'docs.acme.com',
        'https://docs.acme.com/help',
        "https://docs.acme.com; script-src 'unsafe-inline'",
        'https://docs.acme.com https://evil.test',
        "'self'",
        'javascript:alert(1)',
        'https://acme.com:99999',
      ]) {
        await expectValidationError(
          payload.update({
            collection: 'status-pages',
            id: page.id,
            data: { embedOrigins: [{ origin }] },
            overrideAccess: true,
          }),
          /is not an origin/,
        )
      }
    })

    it('needs at least one origin for "origins"', async () => {
      const other = await createPage('empty', { published: true })
      await expectValidationError(
        payload.update({
          collection: 'status-pages',
          id: other.id,
          data: { allowEmbedding: 'origins', embedOrigins: [] },
          overrideAccess: true,
        }),
        /at least one origin/,
      )
    })

    it('can be changed by editors through the builder API, not by viewers', async () => {
      const url = `${BASE}/api/orgs/${org.id}/status-pages/${page.id}`
      const params = { orgId: String(org.id), id: String(page.id) }
      const body = JSON.stringify({ allowEmbedding: 'any' })

      const denied = await call(patchPageRoute, url, params, {
        method: 'PATCH',
        headers: await sessionHeaders('viewer'),
        body,
      })
      expect([403, 404]).toContain(denied.status)
      const unchanged = await payload.findByID({ collection: 'status-pages', id: page.id })
      expect(unchanged.allowEmbedding).toBe('origins')

      const res = await call(patchPageRoute, url, params, {
        method: 'PATCH',
        headers: await sessionHeaders('owner'),
        body,
      })
      expect(res.status).toBe(200)
      const { doc } = (await res.json()) as { doc: StatusPage }
      expect(doc.allowEmbedding).toBe('any')
      // The origins are kept for switching back.
      expect(doc.embedOrigins?.length).toBe(3)
    })
  })

  describe('frame-ancestors policy', () => {
    const policy = async (slug: string) => {
      const res = await call(embedPolicyRoute, `${BASE}/api/status-pages/${slug}/embed-policy`, {
        slug,
      })
      expect(res.status).toBe(200)
      return ((await res.json()) as { frameAncestors: string }).frameAncestors
    }

    it('follows the setting of a published public page', async () => {
      const off = await createPage('off', { published: true })
      const any = await createPage('any', { published: true, allowEmbedding: 'any' })
      const listed = await createPage('listed', {
        published: true,
        allowEmbedding: 'origins',
        embedOrigins: [{ origin: 'https://docs.acme.com' }],
      })
      expect(await policy(off.slug)).toBe("'none'")
      expect(await policy(any.slug)).toBe('*')
      expect(await policy(listed.slug)).toBe('https://docs.acme.com')
    })

    it("is 'none' for drafts, protected pages and unknown slugs whatever the setting", async () => {
      const draft = await createPage('draft', { published: false, allowEmbedding: 'any' })
      const locked = await createPage('locked', {
        published: true,
        allowEmbedding: 'any',
        access: 'password',
        password: 'embed password 1',
      })
      const office = await createPage('office', {
        published: true,
        allowEmbedding: 'origins',
        embedOrigins: [{ origin: 'https://intranet.acme.com' }],
        access: 'ip-allowlist',
        allowedIpRanges: [{ cidr: '203.0.113.0/24' }],
      })
      expect(await policy(draft.slug)).toBe("'none'")
      expect(await policy(locked.slug)).toBe("'none'")
      expect(await policy(office.slug)).toBe("'none'")
      expect(await policy(`missing-${run}`)).toBe("'none'")
    })
  })

  describe('proxy headers', () => {
    it('sends the page its frame-ancestors and refuses framing everywhere else', async () => {
      const listed = await createPage('proxy', {
        published: true,
        allowEmbedding: 'origins',
        embedOrigins: [{ origin: 'https://docs.acme.com' }],
      })
      routeProxyFetches()

      const res = await proxyRequest(`/status/${listed.slug}?embed=all`)
      expect(res.headers.get('content-security-policy')).toBe(
        'frame-ancestors https://docs.acme.com',
      )
      expect(res.headers.get('x-frame-options')).toBeNull()

      for (const path of ['/login', '/events', '/manage/token', '/rss', '/widget.js']) {
        const sub = await proxyRequest(`/status/${listed.slug}${path}`)
        expect(sub.headers.get('content-security-policy'), path).toBe("frame-ancestors 'none'")
        expect(sub.headers.get('x-frame-options'), path).toBe('DENY')
      }
      const markdown = await proxyRequest(`/status/${listed.slug}.md`)
      expect(markdown.headers.get('x-frame-options')).toBe('DENY')

      // Embedding off (the default).
      const off = await proxyRequest(`/status/${page.slug}-missing`)
      expect(off.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
      expect(off.headers.get('x-frame-options')).toBe('DENY')
    })

    it('denies framing when the policy lookup fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'))
      const res = await proxyRequest(`/status/${page.slug}`)
      expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
      expect(res.headers.get('x-frame-options')).toBe('DENY')
    })

    it('passes ?theme= of an embed to the layout and drops visitors’ own header', async () => {
      routeProxyFetches()
      const override = (res: Response) =>
        res.headers.get(`x-middleware-request-${EMBED_THEME_HEADER}`)

      expect(override(await proxyRequest(`/status/${page.slug}?embed=all&theme=dark`))).toBe('dark')
      expect(override(await proxyRequest(`/status/${page.slug}?embed=all&theme=neon`))).toBeNull()
      // No embed mode: `?theme=` alone is ignored, and a forged header never reaches the page.
      const forged = await proxyRequest(`/status/${page.slug}?theme=dark`, {
        [EMBED_THEME_HEADER]: 'dark',
      })
      expect(override(forged)).toBeNull()
      expect(forged.headers.get('x-middleware-override-headers')).not.toContain(EMBED_THEME_HEADER)
    })

    it('applies the policy on custom domains', async () => {
      await payload.update({
        collection: 'status-pages',
        id: page.id,
        data: { allowEmbedding: 'any' },
        overrideAccess: true,
      })
      routeProxyFetches()
      const host = { 'x-forwarded-host': `status-${run}.embed.test` }

      const root = await proxyRequest('/?embed=banner', host)
      expect(root.headers.get('x-middleware-rewrite')).toContain(`/status/${page.slug}`)
      expect(root.headers.get('content-security-policy')).toBe('frame-ancestors *')
      expect(root.headers.get('x-frame-options')).toBeNull()

      const login = await proxyRequest('/login', host)
      expect(login.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
      expect(login.headers.get('x-frame-options')).toBe('DENY')
    })
  })

  describe('widget', () => {
    it('serves a small dependency-free script for public pages', async () => {
      const res = await call(widgetRoute, `${BASE}/status/${page.slug}/widget.js`, {
        slug: page.slug,
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/javascript')
      expect(res.headers.get('cache-control')).toMatch(/^public, max-age=\d+/)
      const script = await res.text()
      expect(script).toContain(`${BASE}/status/${page.slug}/api/v2/status.json`)
      expect(script).toContain('"interval":60')
      expect(script).toContain("credentials: 'omit'")
      expect(script).not.toMatch(/\bimport\b|\brequire\(/)
      expect(gzipSync(script).length).toBeLessThan(5 * 1024)
    })

    it('has no widget for protected pages, with or without credentials', async () => {
      const locked = await createPage('widget-locked', {
        published: true,
        access: 'password',
        password: 'embed password 2',
      })
      for (const query of ['', '?pw=embed%20password%202']) {
        const res = await call(widgetRoute, `${BASE}/status/${locked.slug}/widget.js${query}`, {
          slug: locked.slug,
        })
        expect(res.status).toBe(404)
        expect(res.headers.get('cache-control')).toBe('no-store')
        expect(await res.text()).not.toContain(locked.title)
      }
      const draft = await createPage('widget-draft', { published: false })
      const res = await call(widgetRoute, `${BASE}/status/${draft.slug}/widget.js`, {
        slug: draft.slug,
      })
      expect(res.status).toBe(404)
    })

    it('reads a status.json that other sites cannot read for IP-restricted visitors', async () => {
      await payload.updateGlobal({ slug: 'instance-settings', data: { trustProxy: true } })
      resetInstanceSettingsCache()
      const office = await createPage('widget-office', {
        published: true,
        access: 'ip-allowlist',
        allowedIpRanges: [{ cidr: '203.0.113.0/24' }],
      })
      const res = await call(
        statusRoute,
        `${BASE}/status/${office.slug}/api/v2/status.json`,
        { slug: office.slug },
        { headers: { 'X-Forwarded-For': '203.0.113.7', Origin: 'https://evil.test' } },
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
      expect(res.headers.get('cache-control')).toBe('private, no-store')

      // Public pages keep CORS for the widget.
      const open = await call(statusRoute, `${BASE}/status/${page.slug}/api/v2/status.json`, {
        slug: page.slug,
      })
      expect(open.headers.get('access-control-allow-origin')).toBe('*')
    })
  })

  describe('embed URLs', () => {
    it('parses sections and builds snippet URLs', () => {
      expect(parseEmbedSections(undefined)).toBeNull()
      expect(parseEmbedSections('all')).toHaveLength(5)
      expect(parseEmbedSections('')).toHaveLength(5)
      expect(parseEmbedSections('Components, banner,nope')).toEqual(['banner', 'components'])
      const options = { sections: ['banner', 'components'] as const, theme: 'dark' as const }
      expect(
        statusPageEmbedUrl(`${BASE}/status/acme`, {
          ...options,
          sections: [...options.sections],
          height: 600,
        }),
      ).toBe(`${BASE}/status/acme?embed=banner,components&theme=dark`)
      expect(
        statusPageEmbedUrl('https://status.acme.com', {
          sections: ['banner', 'maintenance', 'incidents', 'components', 'history'],
          theme: 'page',
          height: 600,
        }),
      ).toBe('https://status.acme.com/?embed=all')
    })
  })
})
