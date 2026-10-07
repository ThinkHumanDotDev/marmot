import { createHash } from 'node:crypto'

import type { Redis } from 'ioredis'
import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import { GET as viewersRoute } from '@/app/api/orgs/[orgId]/status-pages/[id]/viewers/route'
import {
  DELETE as viewerDeleteRoute,
  PATCH as viewerRoute,
} from '@/app/api/orgs/[orgId]/status-pages/[id]/viewers/[viewerId]/route'
import { POST as accessRoute } from '@/app/api/status-pages/[slug]/access/route'
import { GET as publicRoute } from '@/app/api/status-pages/[slug]/public/route'
import { GET as manifestRoute } from '@/app/status/[slug]/manifest.json/route'
import { GET as rssRoute } from '@/app/status/[slug]/rss/route'
import { serveBadge } from '@/server/badges'
import { buildMarmotExport } from '@/server/import-export/marmot'
import { createRedis } from '@/server/redis'
import { closeRateLimitStore } from '@/server/security/rate-limit'
import { resetInstanceSettingsCache } from '@/server/settings'
import { accessCookieName, checkStatusPageAccess } from '@/server/status-pages/access'
import {
  closeMagicLinkStore,
  MAGIC_LINK_EMAIL_RATE_LIMIT,
  MAGIC_LINK_IP_RATE_LIMIT,
  MAGIC_LINK_TTL_SECONDS,
  settleMagicLinkDeliveries,
} from '@/server/status-pages/magic-link'
import type { Monitor, Organization, StatusPage, StatusPageViewer, User } from '@/payload-types'

let payload: Payload
let redis: Redis

const run = Date.now().toString(36)
const userEmail = (name: string) => `${name}+spr-${run}@marmot.test`
const DOMAIN = `acme-${run}.com`
const OTHER_DOMAIN = `other-${run}.com`
const visitor = (name: string, domain = DOMAIN) => `${name}@${domain}`
const PASSWORD = 'password-123'

type RequestUser = User & { collection: 'users' }

async function as(user: { id: User['id'] }): Promise<RequestUser> {
  const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
  return { ...fresh, collection: 'users' }
}

/** Builder routes authenticate the Payload cookie, which Payload only honours with a trusted `Origin`. */
const browser = (cookie: string) => ({ Cookie: cookie, Origin: 'http://localhost:3000' })

async function sessionCookie(name: string): Promise<string> {
  const { token } = await payload.login({
    collection: 'users',
    data: { email: userEmail(name), password: PASSWORD },
  })
  return `payload-token=${token}`
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

const cookieFrom = (res: Response): string => (res.headers.get('set-cookie') ?? '').split(';')[0]

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
 * A fresh documentation-range address per call (unique per test run too), so tests never share an
 * IP rate-limit bucket.
 */
let ipCounter = 0
const stamp = Date.now().toString(16).padStart(12, '0').match(/.{4}/g)!.join(':')
const freshIp = () => `2001:db8:${stamp}::${(++ipCounter).toString(16)}`

async function setTrustProxy(value: boolean) {
  await payload.updateGlobal({ slug: 'instance-settings', data: { trustProxy: value } })
  resetInstanceSettingsCache()
}

let owner: User
let viewerUser: User
let org: Organization
let emailMonitor: Monitor
let ipMonitor: Monitor
let emailPage: StatusPage
let ipPage: StatusPage
let sendEmail: MockInstance<Payload['sendEmail']>

const emailHost = () => `team-${run}.example.com`
const ipHost = () => `office-${run}.example.com`

describe('restricted status pages (email domain, IP allow-list)', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    redis = createRedis({ maxRetriesPerRequest: 1 })
    resetInstanceSettingsCache()
    sendEmail = vi.spyOn(payload, 'sendEmail').mockResolvedValue(undefined)

    owner = await payload.create({
      collection: 'users',
      data: { email: userEmail('owner'), password: PASSWORD, name: 'owner' },
    })
    viewerUser = await payload.create({
      collection: 'users',
      data: { email: userEmail('viewer'), password: PASSWORD, name: 'viewer' },
    })
    org = await payload.create({
      collection: 'organizations',
      data: { name: 'SPR Acme', slug: `spr-acme-${run}` },
      user: await as(owner),
      overrideAccess: false,
    })
    await addOrgMembership({ payload, userId: viewerUser.id, orgId: org.id, role: 'viewer' })

    const status = { lastStatus: 'up' as const, lastCheckAt: new Date().toISOString(), lastPing: 9 }
    emailMonitor = await payload.create({
      collection: 'monitors',
      data: { ...MONITOR_DEFAULTS, name: 'Team API', organization: org.id, status },
    })
    ipMonitor = await payload.create({
      collection: 'monitors',
      data: { ...MONITOR_DEFAULTS, name: 'Office VPN', organization: org.id, status },
    })

    emailPage = await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'Acme Team',
        slug: `spr-team-${run}`,
        published: true,
        access: 'email-domain',
        allowedEmailDomains: [{ domain: ` @${DOMAIN.toUpperCase()} ` }],
        domains: [{ hostname: emailHost() }],
        groups: [{ name: 'Team', monitors: [{ monitor: emailMonitor.id }] }],
      },
      user: await as(owner),
      overrideAccess: false,
    })
    ipPage = await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'Acme Office',
        slug: `spr-office-${run}`,
        published: true,
        access: 'ip-allowlist',
        allowedIpRanges: [
          { cidr: '203.0.113.0/24', label: 'Office' },
          { cidr: '2001:DB8:1::/48', label: 'VPN' },
        ],
        domains: [{ hostname: ipHost() }],
        groups: [{ name: 'Office', monitors: [{ monitor: ipMonitor.id }] }],
      },
      user: await as(owner),
      overrideAccess: false,
    })
  })

  afterAll(async () => {
    sendEmail?.mockRestore()
    await settleMagicLinkDeliveries()
    await setTrustProxy(false)
    if (org?.id) {
      await payload.delete({
        collection: 'status-pages',
        where: { organization: { equals: org.id } },
      })
      await payload.delete({ collection: 'monitors', where: { organization: { equals: org.id } } })
      await payload.delete({ collection: 'organizations', where: { id: { equals: org.id } } })
    }
    await payload.delete({ collection: 'users', where: { email: { like: `+spr-${run}@` } } })
    await redis?.quit()
    await closeMagicLinkStore()
    await closeRateLimitStore()
  })

  describe('collection', () => {
    it('normalizes allowed domains and IP ranges', () => {
      expect(emailPage.allowedEmailDomains?.map((r) => r.domain)).toEqual([DOMAIN])
      expect(ipPage.allowedIpRanges?.map((r) => [r.cidr, r.label])).toEqual([
        ['203.0.113.0/24', 'Office'],
        ['2001:db8:1::/48', 'VPN'],
      ])
    })

    it('refuses invalid entries and empty lists for the active mode', async () => {
      const base = { organization: org.id, title: 'Bad', slug: `spr-bad-${run}` }
      await expectValidationError(
        payload.create({
          collection: 'status-pages',
          data: { ...base, access: 'ip-allowlist', allowedIpRanges: [{ cidr: '10.0.0.0/33' }] },
        }),
        /not an IP address or CIDR range/,
      )
      await expectValidationError(
        payload.create({
          collection: 'status-pages',
          data: { ...base, access: 'ip-allowlist', allowedIpRanges: [{ cidr: 'office' }] },
        }),
        /"office" is not an IP address/,
      )
      await expectValidationError(
        payload.create({ collection: 'status-pages', data: { ...base, access: 'ip-allowlist' } }),
        /at least one IP range/,
      )
      await expectValidationError(
        payload.create({
          collection: 'status-pages',
          data: {
            ...base,
            access: 'email-domain',
            allowedEmailDomains: [{ domain: 'not a domain' }],
          },
        }),
        /not a domain name/,
      )
      await expectValidationError(
        payload.create({ collection: 'status-pages', data: { ...base, access: 'email-domain' } }),
        /at least one email domain/,
      )
    })

    it('hides restricted pages from anonymous collection reads', async () => {
      const { docs } = await payload.find({
        collection: 'status-pages',
        where: { organization: { equals: org.id } },
        overrideAccess: false,
        depth: 0,
      })
      expect(docs).toHaveLength(0)
    })

    it('exports restricted pages as drafts', async () => {
      const exported = await buildMarmotExport(payload, { orgId: org.id, user: await as(owner) })
      for (const page of exported.statusPages) expect(page.published).toBe(false)
    })

    it('viewers cannot be created through the API', async () => {
      await expect(
        payload.create({
          collection: 'status-page-viewers',
          data: {
            organization: org.id,
            page: emailPage.id,
            email: visitor('forged'),
            status: 'active',
          },
          user: await as(owner),
          overrideAccess: false,
        }),
      ).rejects.toThrow()
    })
  })

  describe('email domain', () => {
    const accessUrl = (host?: string) =>
      host
        ? `http://${host}/api/status-pages/${emailPage.slug}/access`
        : `http://localhost:3000/api/status-pages/${emailPage.slug}/access`
    const publicUrl = () => `http://localhost:3000/api/status-pages/${emailPage.slug}/public`

    function post(
      body: Record<string, string>,
      headers: Record<string, string> = {},
      host?: string,
    ) {
      return call(
        accessRoute,
        accessUrl(host),
        { slug: emailPage.slug },
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': freshIp(),
            ...(host ? { Host: host } : {}),
            ...headers,
          },
          body: JSON.stringify(body),
        },
      )
    }

    function postForm(body: Record<string, string>, headers: Record<string, string> = {}) {
      return call(
        accessRoute,
        accessUrl(),
        { slug: emailPage.slug },
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Forwarded-For': freshIp(),
            ...headers,
          },
          body: new URLSearchParams(body).toString(),
        },
      )
    }

    /** Requests a link for `address` and returns the token from the email (or null). */
    async function requestLink(address: string, host?: string): Promise<string | null> {
      sendEmail.mockClear()
      const res = await post({ email: address }, {}, host)
      expect(res.status).toBe(202)
      await settleMagicLinkDeliveries()
      const mail = sendEmail.mock.calls.at(-1)?.[0] as { text?: string } | undefined
      const match = mail?.text?.match(/[?&]token=([A-Za-z0-9_-]+)/)
      return match?.[1] ?? null
    }

    async function signIn(address: string): Promise<{ cookie: string; viewer: StatusPageViewer }> {
      const token = await requestLink(address)
      expect(token).toBeTruthy()
      const res = await post({ token: token! })
      expect(res.status).toBe(200)
      const { docs } = await payload.find({
        collection: 'status-page-viewers',
        where: { and: [{ page: { equals: emailPage.id } }, { email: { equals: address } }] },
        depth: 0,
        overrideAccess: true,
      })
      return { cookie: cookieFrom(res), viewer: docs[0] }
    }

    const getPublic = (cookie?: string) =>
      call(
        publicRoute,
        publicUrl(),
        { slug: emailPage.slug },
        { headers: cookie ? { Cookie: cookie } : {} },
      )

    beforeAll(() => setTrustProxy(true))

    it('without a session every surface is closed', async () => {
      const json = await getPublic()
      expect(json.status).toBe(401)
      expect(((await json.json()) as { code: string }).code).toBe('login-required')
      const rss = await call(rssRoute, `http://localhost:3000/status/${emailPage.slug}/rss`, {
        slug: emailPage.slug,
      })
      expect(rss.status).toBe(401)
      const manifest = await call(
        manifestRoute,
        `http://localhost:3000/status/${emailPage.slug}/manifest.json`,
        { slug: emailPage.slug },
      )
      expect(manifest.status).toBe(401)
      const badge = await serveBadge(
        payload,
        new Request(`http://localhost:3000/api/badge/${emailMonitor.id}/status`),
        String(emailMonitor.id),
        ['status'],
      )
      expect(badge.status).toBe(404)
    })

    it('an allowed address receives a single-use link; the answer never reveals the domain', async () => {
      sendEmail.mockClear()
      const allowed = await post({ email: visitor('Alice') })
      const refused = await post({ email: visitor('alice', OTHER_DOMAIN) })
      expect(allowed.status).toBe(202)
      expect(refused.status).toBe(202)
      expect(await allowed.json()).toEqual(await refused.json())
      expect(allowed.headers.get('set-cookie')).toBeNull()
      await settleMagicLinkDeliveries()

      expect(sendEmail).toHaveBeenCalledTimes(1)
      const mail = sendEmail.mock.calls[0][0] as {
        to: string
        subject: string
        text: string
        html: string
      }
      expect(mail.to).toBe(visitor('alice'))
      expect(mail.subject).toBe('Your sign-in link for Acme Team')
      expect(mail.text).toContain(`http://localhost:3000/status/${emailPage.slug}/login?token=`)
      expect(mail.text).toContain('expires in 15 minutes')
      expect(mail.html).toContain('<strong>Acme Team</strong>')
    })

    it('stores only a digest of the token, for 15 minutes', async () => {
      const token = await requestLink(visitor('digest'))
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      const key = `marmot:sp-magic:${createHash('sha256').update(token!).digest('base64url')}`
      const stored = await redis.get(key)
      expect(stored).toBeTruthy()
      expect(stored).not.toContain(token!)
      expect(await redis.ttl(key)).toBeGreaterThan(MAGIC_LINK_TTL_SECONDS - 10)
      expect(await redis.ttl(key)).toBeLessThanOrEqual(MAGIC_LINK_TTL_SECONDS)
      expect(MAGIC_LINK_TTL_SECONDS).toBe(15 * 60)
      expect(await redis.keys(`*${token}*`)).toEqual([])
    })

    it('a link signs the visitor in once; reuse and expired links fail', async () => {
      const token = await requestLink(visitor('bob'))
      const first = await post({ token: token! })
      expect(first.status).toBe(200)
      const setCookie = first.headers.get('set-cookie') ?? ''
      expect(setCookie).toContain(`${accessCookieName(emailPage.id)}=`)
      expect(setCookie).toContain('HttpOnly')

      const again = await post({ token: token! })
      expect(again.status).toBe(400)
      expect(((await again.json()) as { code: string }).code).toBe('link-invalid')

      const expiring = await requestLink(visitor('carol'))
      const key = `marmot:sp-magic:${createHash('sha256').update(expiring!).digest('base64url')}`
      await redis.pexpire(key, 1)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect((await post({ token: expiring! })).status).toBe(400)

      expect((await post({ token: 'x'.repeat(43) })).status).toBe(400)
    })

    it('a link for one page does not open another', async () => {
      const other = await payload.create({
        collection: 'status-pages',
        data: {
          organization: org.id,
          title: 'Other team',
          slug: `spr-other-${run}`,
          published: true,
          access: 'email-domain',
          allowedEmailDomains: [{ domain: DOMAIN }],
        },
      })
      const token = await requestLink(visitor('dave'))
      const res = await call(
        accessRoute,
        `http://localhost:3000/api/status-pages/${other.slug}/access`,
        { slug: other.slug },
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        },
      )
      expect(res.status).toBe(400)
      await payload.delete({ collection: 'status-pages', id: other.id })
    })

    it('the session opens every surface, privately, and records the viewer', async () => {
      const { cookie, viewer } = await signIn(visitor('erin'))
      expect(viewer.status).toBe('active')
      expect(viewer.lastSeenAt).toBeTruthy()
      expect(String(viewer.organization)).toBe(String(org.id))

      const json = await getPublic(cookie)
      expect(json.status).toBe(200)
      expect(json.headers.get('cache-control')).toBe('private, no-store')
      expect(JSON.stringify(await json.json())).toContain('Team API')

      const rss = await call(
        rssRoute,
        `http://localhost:3000/status/${emailPage.slug}/rss`,
        { slug: emailPage.slug },
        { headers: { Cookie: cookie } },
      )
      expect(rss.status).toBe(200)
      expect(rss.headers.get('cache-control')).toBe('private, no-store')

      const manifest = await call(
        manifestRoute,
        `http://localhost:3000/status/${emailPage.slug}/manifest.json`,
        { slug: emailPage.slug },
        { headers: { Cookie: cookie } },
      )
      expect(manifest.status).toBe(200)

      const badge = await serveBadge(
        payload,
        new Request(`http://localhost:3000/api/badge/${emailMonitor.id}/status`, {
          headers: { Cookie: cookie },
        }),
        String(emailMonitor.id),
        ['status'],
      )
      expect(badge.status).toBe(200)
      expect(badge.headers.get('cache-control')).toBe('private, no-store')
    })

    it('works with the login forms (no JavaScript)', async () => {
      sendEmail.mockClear()
      const sent = await postForm({ email: visitor('frank') })
      expect(sent.status).toBe(303)
      expect(sent.headers.get('location')).toBe(`/status/${emailPage.slug}/login?sent=1`)
      const unknown = await postForm({ email: visitor('frank', OTHER_DOMAIN) })
      expect(unknown.headers.get('location')).toBe(`/status/${emailPage.slug}/login?sent=1`)
      const invalid = await postForm({ email: 'not-an-address' })
      expect(invalid.headers.get('location')).toBe(
        `/status/${emailPage.slug}/login?error=invalid-email`,
      )

      await settleMagicLinkDeliveries()
      expect(sendEmail).toHaveBeenCalledTimes(1)
      const token = (sendEmail.mock.calls[0][0] as { text: string }).text.match(
        /token=([A-Za-z0-9_-]+)/,
      )?.[1]
      const redeemed = await postForm({ token: token! })
      expect(redeemed.status).toBe(303)
      expect(redeemed.headers.get('location')).toBe(`/status/${emailPage.slug}`)
      expect(redeemed.headers.get('set-cookie')).toContain(accessCookieName(emailPage.id))

      const reused = await postForm({ token: token! })
      expect(reused.headers.get('location')).toBe(
        `/status/${emailPage.slug}/login?error=link-invalid`,
      )
      expect(reused.headers.get('set-cookie')).toBeNull()

      const crossSite = await postForm(
        { email: visitor('frank') },
        { Origin: 'https://evil.example.org' },
      )
      expect(crossSite.status).toBe(403)
    })

    it('on a custom domain the link and the redirects stay on that domain', async () => {
      const token = await requestLink(visitor('grace'), emailHost())
      const mail = sendEmail.mock.calls.at(-1)?.[0] as { text: string }
      expect(mail.text).toContain(`http://${emailHost()}/login?token=`)

      const res = await call(
        accessRoute,
        accessUrl(emailHost()),
        { slug: emailPage.slug },
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Host: emailHost(),
          },
          body: new URLSearchParams({ token: token! }).toString(),
        },
      )
      expect(res.headers.get('location')).toBe('/')
      const cookie = cookieFrom(res)

      const rss = await call(
        rssRoute,
        `http://${emailHost()}/status/${emailPage.slug}/rss`,
        { slug: emailPage.slug },
        { headers: { Host: emailHost(), Cookie: cookie } },
      )
      expect(rss.status).toBe(200)
      const denied = await call(
        rssRoute,
        `http://${emailHost()}/status/${emailPage.slug}/rss`,
        { slug: emailPage.slug },
        { headers: { Host: emailHost() } },
      )
      expect(denied.status).toBe(401)
    })

    it('admins list and revoke viewers; revocation ends the session and blocks new links', async () => {
      const { cookie, viewer } = await signIn(visitor('heidi'))
      const ownerCookie = await sessionCookie('owner')
      const viewerCookie = await sessionCookie('viewer')
      const params = { orgId: String(org.id), id: String(emailPage.id) }
      const listUrl = `http://localhost:3000/api/orgs/${org.id}/status-pages/${emailPage.id}/viewers`

      const listed = await call(viewersRoute, listUrl, params, { headers: browser(viewerCookie) })
      expect(listed.status).toBe(200)
      const { docs } = (await listed.json()) as { docs: StatusPageViewer[] }
      expect(docs.map((d) => d.email)).toContain(visitor('heidi'))

      const viewerParams = { ...params, viewerId: String(viewer.id) }
      const patch = (cookieHeader: string, status: string) =>
        call(viewerRoute, `${listUrl}/${viewer.id}`, viewerParams, {
          method: 'PATCH',
          headers: { ...browser(cookieHeader), 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        })

      // Read-only members cannot revoke.
      expect((await patch(viewerCookie, 'revoked')).status).toBe(403)
      expect((await getPublic(cookie)).status).toBe(200)

      const revoked = await patch(ownerCookie, 'revoked')
      expect(revoked.status).toBe(200)
      expect((await getPublic(cookie)).status).toBe(401)
      expect(await requestLink(visitor('heidi'))).toBeNull()

      // Restoring brings the same session back.
      expect((await patch(ownerCookie, 'active')).status).toBe(200)
      expect((await getPublic(cookie)).status).toBe(200)

      // Removing forgets the visitor: the session ends, but a new link works.
      const removed = await call(viewerDeleteRoute, `${listUrl}/${viewer.id}`, viewerParams, {
        method: 'DELETE',
        headers: browser(ownerCookie),
      })
      expect(removed.status).toBe(200)
      expect((await getPublic(cookie)).status).toBe(401)
      expect(await requestLink(visitor('heidi'))).toBeTruthy()
    })

    it('removing a domain or switching the mode ends existing sessions', async () => {
      const { cookie } = await signIn(visitor('ivan'))
      expect((await getPublic(cookie)).status).toBe(200)

      await payload.update({
        collection: 'status-pages',
        id: emailPage.id,
        data: { allowedEmailDomains: [{ domain: OTHER_DOMAIN }] },
      })
      expect((await getPublic(cookie)).status).toBe(401)

      await payload.update({
        collection: 'status-pages',
        id: emailPage.id,
        data: { allowedEmailDomains: [{ domain: DOMAIN }] },
      })
      expect((await getPublic(cookie)).status).toBe(200)

      await payload.update({
        collection: 'status-pages',
        id: emailPage.id,
        data: { access: 'password', password: 'a page password' } as never,
      })
      expect((await getPublic(cookie)).status).toBe(401)
      await payload.update({
        collection: 'status-pages',
        id: emailPage.id,
        data: { access: 'email-domain' },
      })
      // Back in email-domain mode, the viewer (still active, domain still allowed) is admitted.
      expect((await getPublic(cookie)).status).toBe(200)
    })

    it('rate limits link requests per address and per client IP', async () => {
      const address = visitor('mallory')
      const statuses: number[] = []
      for (let i = 0; i <= MAGIC_LINK_EMAIL_RATE_LIMIT.points; i++) {
        statuses.push((await post({ email: address })).status)
      }
      expect(statuses.slice(0, -1).every((s) => s === 202)).toBe(true)
      const limited = await post({ email: address })
      expect(limited.status).toBe(429)
      expect(limited.headers.get('retry-after')).toMatch(/^\d+$/)
      // The same answer for an address at a domain that is not allowed: nothing is revealed.
      const outsider = visitor('mallory', OTHER_DOMAIN)
      for (let i = 0; i < MAGIC_LINK_EMAIL_RATE_LIMIT.points; i++) {
        expect((await post({ email: outsider })).status).toBe(202)
      }
      expect((await post({ email: outsider })).status).toBe(429)

      const ip = freshIp()
      const perIp: number[] = []
      for (let i = 0; i <= MAGIC_LINK_IP_RATE_LIMIT.points; i++) {
        perIp.push((await post({ email: visitor(`ip${i}`) }, { 'X-Forwarded-For': ip })).status)
      }
      expect(perIp.at(-2)).toBe(202)
      expect(perIp.at(-1)).toBe(429)
      const form = await postForm({ email: visitor('ipx') }, { 'X-Forwarded-For': ip })
      expect(form.headers.get('location')).toBe(
        `/status/${emailPage.slug}/login?error=rate-limited`,
      )
    })

    it('deleting the page removes its viewers', async () => {
      const temp = await payload.create({
        collection: 'status-pages',
        data: {
          organization: org.id,
          title: 'Temp',
          slug: `spr-temp-${run}`,
          published: true,
          access: 'email-domain',
          allowedEmailDomains: [{ domain: DOMAIN }],
        },
      })
      await payload.create({
        collection: 'status-page-viewers',
        data: { organization: org.id, page: temp.id, email: visitor('temp'), status: 'active' },
      })
      await payload.delete({ collection: 'status-pages', id: temp.id })
      const { totalDocs } = await payload.count({
        collection: 'status-page-viewers',
        where: { page: { equals: temp.id } },
      })
      expect(totalDocs).toBe(0)
    })
  })

  describe('IP allow-list', () => {
    const publicUrl = (host = 'localhost:3000') =>
      `http://${host}/api/status-pages/${ipPage.slug}/public`
    const getPublic = (ip?: string, headers: Record<string, string> = {}) =>
      call(
        publicRoute,
        publicUrl(),
        { slug: ipPage.slug },
        { headers: { ...(ip ? { 'X-Forwarded-For': ip } : {}), ...headers } },
      )

    it('admits nobody while client addresses are not trusted (trustProxy off)', async () => {
      await setTrustProxy(false)
      const res = await getPublic('203.0.113.10')
      expect(res.status).toBe(403)
      expect(((await res.json()) as { code: string }).code).toBe('ip-not-allowed')
      await setTrustProxy(true)
    })

    it('admits IPv4 and IPv6 clients in the ranges, privately', async () => {
      for (const ip of ['203.0.113.10', '2001:db8:1:42::7', '::ffff:203.0.113.200']) {
        const res = await getPublic(ip)
        expect(res.status, ip).toBe(200)
        expect(res.headers.get('cache-control')).toBe('private, no-store')
      }
      // The first X-Forwarded-For entry is the client (the proxy appends its own peers).
      expect((await getPublic('203.0.113.10, 10.0.0.1')).status).toBe(200)
      const decision = await checkStatusPageAccess(payload, ipPage, {
        headers: new Headers({ 'X-Forwarded-For': '203.0.113.10' }),
      })
      expect(decision).toEqual({ allowed: true, via: 'ip', restricted: true })
    })

    it('answers 403 everywhere outside the ranges', async () => {
      for (const ip of ['198.51.100.1', '2001:db8:2::1', '10.0.0.1, 203.0.113.10']) {
        const res = await getPublic(ip)
        expect(res.status, ip).toBe(403)
        expect(res.headers.get('cache-control')).toBe('private, no-store')
        expect(JSON.stringify(await res.json())).not.toContain('Office VPN')
      }
      expect((await getPublic()).status).toBe(403)

      const outside = { 'X-Forwarded-For': '198.51.100.1' }
      const rss = await call(
        rssRoute,
        `http://localhost:3000/status/${ipPage.slug}/rss`,
        { slug: ipPage.slug },
        { headers: outside },
      )
      expect(rss.status).toBe(403)
      expect(await rss.text()).not.toContain('Acme Office')
      const manifest = await call(
        manifestRoute,
        `http://localhost:3000/status/${ipPage.slug}/manifest.json`,
        { slug: ipPage.slug },
        { headers: outside },
      )
      expect(manifest.status).toBe(403)
      const badge = await serveBadge(
        payload,
        new Request(`http://localhost:3000/api/badge/${ipMonitor.id}/status`, { headers: outside }),
        String(ipMonitor.id),
        ['status'],
      )
      expect(badge.status).toBe(404)
    })

    it('feeds, manifest and badges work from inside', async () => {
      const inside = { 'X-Forwarded-For': '203.0.113.77' }
      const rss = await call(
        rssRoute,
        `http://localhost:3000/status/${ipPage.slug}/rss`,
        { slug: ipPage.slug },
        { headers: inside },
      )
      expect(rss.status).toBe(200)
      expect(rss.headers.get('cache-control')).toBe('private, no-store')
      const manifest = await call(
        manifestRoute,
        `http://localhost:3000/status/${ipPage.slug}/manifest.json`,
        { slug: ipPage.slug },
        { headers: inside },
      )
      expect(manifest.status).toBe(200)
      const badge = await serveBadge(
        payload,
        new Request(`http://localhost:3000/api/badge/${ipMonitor.id}/status`, { headers: inside }),
        String(ipMonitor.id),
        ['status'],
      )
      expect(badge.status).toBe(200)
      expect(badge.headers.get('cache-control')).toBe('private, no-store')
    })

    it('custom domains apply the same allow-list', async () => {
      const url = `http://${ipHost()}/status/${ipPage.slug}/rss`
      const inside = await call(
        rssRoute,
        url,
        { slug: ipPage.slug },
        { headers: { Host: ipHost(), 'X-Forwarded-For': '2001:db8:1::9' } },
      )
      expect(inside.status).toBe(200)
      expect(await inside.text()).toContain(`<link>http://${ipHost()}</link>`)
      const outside = await call(
        rssRoute,
        url,
        { slug: ipPage.slug },
        { headers: { Host: ipHost(), 'X-Forwarded-For': '192.0.2.1' } },
      )
      expect(outside.status).toBe(403)
    })

    it('there is nothing to sign in to: no cookie is ever issued', async () => {
      const res = await call(
        accessRoute,
        `http://localhost:3000/api/status-pages/${ipPage.slug}/access`,
        { slug: ipPage.slug },
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.1' },
          body: JSON.stringify({ email: visitor('x'), password: 'whatever' }),
        },
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('set-cookie')).toBeNull()
      expect((await getPublic('198.51.100.1')).status).toBe(403)
    })

    it('editing the ranges applies immediately', async () => {
      await payload.update({
        collection: 'status-pages',
        id: ipPage.id,
        data: { allowedIpRanges: [{ cidr: '198.51.100.0/24' }] },
      })
      expect((await getPublic('198.51.100.1')).status).toBe(200)
      expect((await getPublic('203.0.113.10')).status).toBe(403)
    })
  })
})
