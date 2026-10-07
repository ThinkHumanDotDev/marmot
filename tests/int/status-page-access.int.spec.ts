import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { POST as accessRoute } from '@/app/api/status-pages/[slug]/access/route'
import { GET as publicRoute } from '@/app/api/status-pages/[slug]/public/route'
import { GET as resolveDomainRoute } from '@/app/api/status-pages/resolve-domain/route'
import { GET as manifestRoute } from '@/app/status/[slug]/manifest.json/route'
import { GET as rssRoute } from '@/app/status/[slug]/rss/route'
import { serveBadge } from '@/server/badges'
import { buildMarmotExport } from '@/server/import-export/marmot'
import { closeRateLimitStore } from '@/server/security/rate-limit'
import { resetInstanceSettingsCache } from '@/server/settings'
import {
  accessCookieName,
  checkStatusPageAccess,
  clearVerifiedPasswords,
  STATUS_PAGE_PASSWORD_PAGE_RATE_LIMIT,
  STATUS_PAGE_PASSWORD_RATE_LIMIT,
} from '@/server/status-pages/access'
import type { Monitor, Organization, StatusPage, User } from '@/payload-types'

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+spa-${run}@marmot.test`
const PASSWORD = 'correct horse battery'

type RequestUser = User & { collection: 'users' }

async function as(user: { id: User['id'] }): Promise<RequestUser> {
  const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
  return { ...fresh, collection: 'users' }
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

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>

const call = (
  handler: unknown,
  url: string,
  params: Record<string, string>,
  init: RequestInit = {},
): Promise<Response> =>
  (handler as Handler)(new Request(url, init), { params: Promise.resolve(params) })

/** `Cookie` header value from a `Set-Cookie` response header. */
const cookieFrom = (res: Response): string => {
  const header = res.headers.get('set-cookie') ?? ''
  return header.split(';')[0] ?? ''
}

/** Reads the stored hash the way server code does (field access hides it from everyone else). */
const storedHash = async (id: StatusPage['id']) =>
  (await payload.findByID({ collection: 'status-pages', id, depth: 0, overrideAccess: true }))
    .passwordHash

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
let org: Organization
let monitor: Monitor
let sharedMonitor: Monitor
let page: StatusPage
let publicPage: StatusPage
let cookie: string

const host = () => `status-${run}.example.com`
const pageUrl = (suffix = '') => `http://localhost:3000/status/${page.slug}${suffix}`
const apiUrl = (suffix = '') => `http://localhost:3000/api/status-pages/${page.slug}${suffix}`

async function login(password: string, headers: Record<string, string> = {}) {
  return call(
    accessRoute,
    apiUrl('/access'),
    { slug: page.slug },
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ password }),
    },
  )
}

async function loginForm(password: string, headers: Record<string, string> = {}) {
  return call(
    accessRoute,
    apiUrl('/access'),
    { slug: page.slug },
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({ password }).toString(),
    },
  )
}

describe('password-protected status pages', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    clearVerifiedPasswords()
    resetInstanceSettingsCache()

    owner = await payload.create({
      collection: 'users',
      data: { email: email('owner'), password: 'password-123', name: 'owner' },
    })
    org = await payload.create({
      collection: 'organizations',
      data: { name: 'SPA Acme', slug: `spa-acme-${run}` },
      user: await as(owner),
      overrideAccess: false,
    })
    monitor = await payload.create({
      collection: 'monitors',
      data: {
        ...MONITOR_DEFAULTS,
        name: 'Private API',
        organization: org.id,
        status: { lastStatus: 'up', lastCheckAt: new Date().toISOString(), lastPing: 12 },
      },
    })
    sharedMonitor = await payload.create({
      collection: 'monitors',
      data: {
        ...MONITOR_DEFAULTS,
        name: 'Website',
        organization: org.id,
        status: { lastStatus: 'up', lastCheckAt: new Date().toISOString(), lastPing: 10 },
      },
    })

    page = await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'Acme Internal',
        slug: `spa-internal-${run}`,
        description: 'Internal services.',
        published: true,
        access: 'password',
        password: PASSWORD,
        domains: [{ hostname: host() }],
        groups: [
          { name: 'Core', monitors: [{ monitor: monitor.id }, { monitor: sharedMonitor.id }] },
        ],
      } as never,
      user: await as(owner),
      overrideAccess: false,
    })
    publicPage = await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'Acme Public',
        slug: `spa-public-${run}`,
        published: true,
        groups: [{ name: 'Web', monitors: [{ monitor: sharedMonitor.id }] }],
      },
      user: await as(owner),
      overrideAccess: false,
    })
  })

  afterAll(async () => {
    if (org?.id) {
      await payload.delete({
        collection: 'status-pages',
        where: { organization: { equals: org.id } },
      })
      await payload.delete({ collection: 'monitors', where: { organization: { equals: org.id } } })
      await payload.delete({ collection: 'organizations', where: { id: { equals: org.id } } })
    }
    await payload.delete({ collection: 'users', where: { email: { like: `+spa-${run}@` } } })
    await closeRateLimitStore()
  })

  describe('collection', () => {
    it('stores a scrypt hash and never returns the password or the hash', async () => {
      const hash = await storedHash(page.id)
      expect(hash).toMatch(/^scrypt\$/)
      expect(hash).not.toContain(PASSWORD)

      const asOwner = await payload.findByID({
        collection: 'status-pages',
        id: page.id,
        depth: 0,
        user: await as(owner),
        overrideAccess: false,
      })
      expect(asOwner.access).toBe('password')
      expect(asOwner).not.toHaveProperty('passwordHash')
      expect(asOwner.password ?? undefined).toBeUndefined()
      expect(page).not.toHaveProperty('passwordHash')
    })

    it('requires a password of at least 8 characters for password mode', async () => {
      await expectValidationError(
        payload.create({
          collection: 'status-pages',
          data: {
            organization: org.id,
            title: 'No password',
            slug: `spa-nopw-${run}`,
            access: 'password',
          },
        }),
        /Set a password/,
      )
      await expectValidationError(
        payload.update({
          collection: 'status-pages',
          id: page.id,
          data: { password: 'short' } as never,
        }),
        /at least 8/,
      )
    })

    it('keeps the hash on unrelated updates; clients cannot write it directly', async () => {
      const before = await storedHash(page.id)
      await payload.update({
        collection: 'status-pages',
        id: page.id,
        data: { title: 'Acme Internal', passwordHash: 'scrypt$forged' },
        user: await as(owner),
        overrideAccess: false,
      })
      expect(await storedHash(page.id)).toBe(before)
    })

    it('hides protected pages from anonymous collection reads', async () => {
      const { docs } = await payload.find({
        collection: 'status-pages',
        where: { organization: { equals: org.id } },
        overrideAccess: false,
        depth: 0,
      })
      expect(docs.map((d) => d.slug)).toEqual([publicPage.slug])
    })

    it('drops the hash when a page goes back to public', async () => {
      const temp = await payload.create({
        collection: 'status-pages',
        data: {
          organization: org.id,
          title: 'Temp',
          slug: `spa-temp-${run}`,
          access: 'password',
          password: PASSWORD,
        } as never,
      })
      expect(await storedHash(temp.id)).toMatch(/^scrypt\$/)
      await payload.update({ collection: 'status-pages', id: temp.id, data: { access: 'public' } })
      expect(await storedHash(temp.id)).toBeNull()
      await payload.delete({ collection: 'status-pages', id: temp.id })
    })

    it('exports protected pages as drafts (the password is not exported)', async () => {
      const exported = await buildMarmotExport(payload, { orgId: org.id, user: await as(owner) })
      const bySlug = Object.fromEntries(exported.statusPages.map((p) => [p.slug, p]))
      expect(bySlug[page.slug]?.published).toBe(false)
      expect(bySlug[publicPage.slug]?.published).toBe(true)
      expect(JSON.stringify(exported)).not.toContain('scrypt$')
    })
  })

  describe('without access', () => {
    it('JSON endpoint answers 401, never cached', async () => {
      const res = await call(publicRoute, apiUrl('/public'), { slug: page.slug })
      expect(res.status).toBe(401)
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      const body = (await res.json()) as Record<string, unknown>
      expect(body.code).toBe('login-required')
      expect(JSON.stringify(body)).not.toContain('Private API')
    })

    it('RSS answers 401', async () => {
      const res = await call(rssRoute, pageUrl('/rss'), { slug: page.slug })
      expect(res.status).toBe(401)
      expect(await res.text()).not.toContain('Acme Internal')
    })

    it('manifest answers 401', async () => {
      const res = await call(manifestRoute, pageUrl('/manifest.json'), { slug: page.slug })
      expect(res.status).toBe(401)
    })

    it('badges of monitors only on protected pages are hidden (404)', async () => {
      const res = await serveBadge(
        payload,
        new Request(`http://localhost:3000/api/badge/${monitor.id}/status`),
        String(monitor.id),
        ['status'],
      )
      expect(res.status).toBe(404)
    })

    it('a monitor also on a public page keeps its public, cacheable badge', async () => {
      const res = await serveBadge(
        payload,
        new Request(`http://localhost:3000/api/badge/${sharedMonitor.id}/status`),
        String(sharedMonitor.id),
        ['status'],
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('public, max-age=300')
    })

    it('a wrong ?pw= is a 401', async () => {
      const res = await call(publicRoute, apiUrl('/public?pw=nope-nope-nope'), {
        slug: page.slug,
      })
      expect(res.status).toBe(401)
      expect(((await res.json()) as { code: string }).code).toBe('invalid-password')
    })
  })

  describe('login', () => {
    it('a wrong password is refused (JSON 401, form back to the login page)', async () => {
      const json = await login('wrong password')
      expect(json.status).toBe(401)
      expect(json.headers.get('set-cookie')).toBeNull()

      const form = await loginForm('wrong password')
      expect(form.status).toBe(303)
      expect(form.headers.get('location')).toBe(`/status/${page.slug}/login?error=invalid`)
      expect(form.headers.get('set-cookie')).toBeNull()
    })

    it('a correct password sets an HttpOnly cookie scoped to the page', async () => {
      const res = await loginForm(PASSWORD)
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toBe(`/status/${page.slug}`)
      const setCookie = res.headers.get('set-cookie') ?? ''
      expect(setCookie).toContain(`${accessCookieName(page.id)}=`)
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('SameSite=Lax')
      expect(setCookie).toMatch(/Max-Age=2592000/)
      cookie = cookieFrom(res)
    })

    it('refuses cross-site form posts', async () => {
      const res = await loginForm(PASSWORD, { Origin: 'https://evil.example.org' })
      expect(res.status).toBe(403)
    })

    it('on a custom domain, redirects stay on that domain', async () => {
      const ok = await loginForm(PASSWORD, { Host: host() })
      expect(ok.headers.get('location')).toBe('/')
      const bad = await loginForm('wrong password', { Host: host() })
      expect(bad.headers.get('location')).toBe('/login?error=invalid')
    })
  })

  describe('with access', () => {
    it('JSON endpoint serves the page with the cookie, privately', async () => {
      const res = await call(
        publicRoute,
        apiUrl('/public'),
        { slug: page.slug },
        {
          headers: { Cookie: cookie },
        },
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      const body = (await res.json()) as { groups: { monitors: { name: string }[] }[] }
      expect(body.groups[0].monitors.map((m) => m.name)).toContain('Private API')
      expect(JSON.stringify(body)).not.toContain('scrypt$')
    })

    it('JSON endpoint accepts ?pw= for machine clients', async () => {
      const res = await call(publicRoute, apiUrl(`/public?pw=${encodeURIComponent(PASSWORD)}`), {
        slug: page.slug,
      })
      expect(res.status).toBe(200)
    })

    it('RSS works with the cookie and with ?pw=', async () => {
      const withCookie = await call(
        rssRoute,
        pageUrl('/rss'),
        { slug: page.slug },
        {
          headers: { Cookie: cookie },
        },
      )
      expect(withCookie.status).toBe(200)
      expect(withCookie.headers.get('cache-control')).toBe('private, no-store')
      expect(await withCookie.text()).toContain('Acme Internal')

      const withParam = await call(rssRoute, pageUrl(`/rss?pw=${encodeURIComponent(PASSWORD)}`), {
        slug: page.slug,
      })
      expect(withParam.status).toBe(200)
    })

    it('manifest works with the cookie', async () => {
      const res = await call(
        manifestRoute,
        pageUrl('/manifest.json'),
        { slug: page.slug },
        {
          headers: { Cookie: cookie },
        },
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('private, no-store')
    })

    it('badges work with the cookie or ?pw=, never publicly cached', async () => {
      const withCookie = await serveBadge(
        payload,
        new Request(`http://localhost:3000/api/badge/${monitor.id}/status`, {
          headers: { Cookie: cookie },
        }),
        String(monitor.id),
        ['status'],
      )
      expect(withCookie.status).toBe(200)
      expect(withCookie.headers.get('cache-control')).toBe('private, no-store')

      const withParam = await serveBadge(
        payload,
        new Request(
          `http://localhost:3000/api/badge/${monitor.id}/status?pw=${encodeURIComponent(PASSWORD)}`,
        ),
        String(monitor.id),
        ['status'],
      )
      expect(withParam.status).toBe(200)
    })

    it('custom domains: the domain resolves and the rewritten feed honours the cookie', async () => {
      const resolved = await call(
        resolveDomainRoute,
        `http://localhost:3000/api/status-pages/resolve-domain?host=${host()}`,
        {},
      )
      expect(((await resolved.json()) as { slug: string }).slug).toBe(page.slug)

      // The proxy rewrites https://<host>/rss to /status/<slug>/rss and keeps the Host header.
      const denied = await call(rssRoute, `http://${host()}/status/${page.slug}/rss`, {
        slug: page.slug,
      })
      expect(denied.status).toBe(401)
      const allowed = await call(
        rssRoute,
        `http://${host()}/status/${page.slug}/rss`,
        { slug: page.slug },
        { headers: { Host: host(), Cookie: cookie } },
      )
      expect(allowed.status).toBe(200)
      expect(await allowed.text()).toContain(`<link>http://${host()}</link>`)
    })

    it('a cookie for one page does not open another protected page', async () => {
      const other = await payload.create({
        collection: 'status-pages',
        data: {
          organization: org.id,
          title: 'Other',
          slug: `spa-other-${run}`,
          published: true,
          access: 'password',
          password: PASSWORD,
        } as never,
      })
      const [name, value] = cookie.split('=')
      expect(name).toBe(accessCookieName(page.id))
      const forged = `${accessCookieName(other.id)}=${value}`
      const res = await call(
        publicRoute,
        `http://localhost:3000/api/status-pages/${other.slug}/public`,
        { slug: other.slug },
        { headers: { Cookie: forged } },
      )
      expect(res.status).toBe(401)
      await payload.delete({ collection: 'status-pages', id: other.id })
    })

    it('changing the password ends existing sessions', async () => {
      await payload.update({
        collection: 'status-pages',
        id: page.id,
        data: { password: 'a brand new password' } as never,
        user: await as(owner),
        overrideAccess: false,
      })
      const res = await call(
        publicRoute,
        apiUrl('/public'),
        { slug: page.slug },
        {
          headers: { Cookie: cookie },
        },
      )
      expect(res.status).toBe(401)

      const old = await call(publicRoute, apiUrl(`/public?pw=${encodeURIComponent(PASSWORD)}`), {
        slug: page.slug,
      })
      expect(old.status).toBe(401)
    })
  })

  describe('brute force', () => {
    it('throttles password attempts per page (429 with Retry-After)', async () => {
      const limit = STATUS_PAGE_PASSWORD_PAGE_RATE_LIMIT.points
      expect(limit).toBeGreaterThan(STATUS_PAGE_PASSWORD_RATE_LIMIT.points)
      const statuses: number[] = []
      for (let i = 0; i <= limit; i++) statuses.push((await login(`guess-${i}-guess`)).status)
      expect(statuses.filter((s) => s === 401).length).toBeGreaterThan(0)
      expect(statuses.at(-1)).toBe(429)

      // Blocked clients cannot even try the right password, through any surface.
      const blocked = await login('a brand new password')
      expect(blocked.status).toBe(429)
      expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/)
      const param = await call(
        publicRoute,
        apiUrl(`/public?pw=${encodeURIComponent('a brand new password')}`),
        { slug: page.slug },
      )
      expect(param.status).toBe(429)
      const form = await loginForm('a brand new password')
      expect(form.headers.get('location')).toBe(`/status/${page.slug}/login?error=rate-limited`)
    })
  })

  it('public pages are unaffected', async () => {
    const decision = await checkStatusPageAccess(payload, publicPage, { headers: new Headers() })
    expect(decision).toEqual({ allowed: true, via: 'public', restricted: false })
    const res = await call(
      publicRoute,
      `http://localhost:3000/api/status-pages/${publicPage.slug}/public`,
      { slug: publicPage.slug },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=30')
  })
})
