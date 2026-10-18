import { NextRequest } from 'next/server'
import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { POST as accessRoute } from '@/app/api/status-pages/[slug]/access/route'
import { POST as subscribeRoute } from '@/app/api/status-pages/[slug]/subscribe/route'
import { POST as verifyRoute } from '@/app/api/status-pages/[slug]/subscribe/verify/route'
import { GET as badgeRoute } from '@/app/status/[slug]/badge.svg/route'
import { GET as widgetRoute } from '@/app/status/[slug]/widget.js/route'
import { getTranslator } from '@/i18n/translator'
import { STATUS_LOCALE_HEADER } from '@/lib/status-page-locales'
import { proxy } from '@/proxy'
import { closeRateLimitStore } from '@/server/security/rate-limit'
import { resetInstanceSettingsCache } from '@/server/settings'
import { clearVerifiedPasswords } from '@/server/status-pages/access'
import type { Organization, StatusPage } from '@/payload-types'

/**
 * Translated status pages, extras (#271): visitor-facing API errors in the page's language, and
 * the language prefix on the badge and the embeddable widget.
 */

let payload: Payload

const run = Date.now().toString(36)
const BASE = 'http://localhost:3000'
const PASSWORD = 'correct horse battery'

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>

const call = (
  handler: unknown,
  url: string,
  params: Record<string, string>,
  init: RequestInit = {},
): Promise<Response> =>
  (handler as Handler)(new Request(url, init), { params: Promise.resolve(params) })

const postJson = (handler: unknown, url: string, slug: string, body: unknown) =>
  call(
    handler,
    url,
    { slug },
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    },
  )

const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error

/** `errors.<key>` in `locale`, as the routes render it. */
const message = (locale: 'en' | 'fr' | 'de' | 'es', key: string) =>
  (getTranslator(locale) as unknown as (key: string) => string)(`errors.${key}`)

let org: Organization
/** English by default, also in French and German; email subscriptions. */
let multilingual: StatusPage
/** German by default, also in French; password protected. */
let locked: StatusPage

async function createPage(slug: string, data: Partial<StatusPage>): Promise<StatusPage> {
  return payload.create({
    collection: 'status-pages',
    data: {
      organization: org.id,
      title: `Lang ${slug}`,
      slug: `lang-${slug}-${run}`,
      published: true,
      ...data,
    },
    overrideAccess: true,
  })
}

describe('status page visitor language (#271)', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    resetInstanceSettingsCache()
    org = await payload.create({
      collection: 'organizations',
      data: { name: `Lang ${run}`, slug: `lang-${run}` },
      overrideAccess: true,
      context: { skipOwnerMembership: true },
    })
    multilingual = await createPage('multi', {
      defaultLocale: 'en',
      additionalLocales: ['fr', 'de'],
      autoRefreshInterval: 60,
      subscriptions: { enabled: true, channels: ['email'] },
    } as Partial<StatusPage>)
    locked = await createPage('locked', {
      defaultLocale: 'de',
      additionalLocales: ['fr'],
      access: 'password',
      password: PASSWORD,
    } as Partial<StatusPage>)
  })

  afterAll(async () => {
    if (org?.id) {
      await payload.delete({
        collection: 'status-pages',
        where: { organization: { equals: org.id } },
        overrideAccess: true,
      })
      await payload.delete({ collection: 'organizations', id: org.id, overrideAccess: true })
    }
    clearVerifiedPasswords()
    await closeRateLimitStore()
  })

  describe('subscribe errors', () => {
    const url = (query = '') => `${BASE}/api/status-pages/${multilingual.slug}/subscribe${query}`

    it("answer in the language of the page the visitor reads (?locale=), else the page's default", async () => {
      const bad = { channel: 'email', target: 'not an address' }
      const fr = await postJson(subscribeRoute, url('?locale=fr'), multilingual.slug, bad)
      expect(fr.status).toBe(400)
      expect(await errorOf(fr)).toBe(message('fr', 'subscriberTargetInvalid'))
      expect(message('fr', 'subscriberTargetInvalid')).not.toBe(
        message('en', 'subscriberTargetInvalid'),
      )

      // The body's `locale` (the dialog sends both) counts when the query has none.
      const de = await postJson(subscribeRoute, url(), multilingual.slug, { ...bad, locale: 'de' })
      expect(await errorOf(de)).toBe(message('de', 'subscriberTargetInvalid'))

      // A language the page does not offer falls back to its default, whatever the browser says.
      const es = await call(
        subscribeRoute,
        url('?locale=es'),
        { slug: multilingual.slug },
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept-Language': 'fr' },
          body: JSON.stringify(bad),
        },
      )
      expect(await errorOf(es)).toBe(message('en', 'subscriberTargetInvalid'))

      const channel = await postJson(subscribeRoute, url('?locale=de'), multilingual.slug, {
        channel: 'sms',
        target: '+15551234567',
      })
      expect(channel.status).toBe(404)
      expect(await errorOf(channel)).toBe(message('de', 'subscriptionChannelUnavailable'))
    })

    it('render unknown pages in the requested language', async () => {
      const res = await postJson(
        subscribeRoute,
        `${BASE}/api/status-pages/lang-missing-${run}/subscribe?locale=es`,
        `lang-missing-${run}`,
        { channel: 'email', target: 'a@b.test' },
      )
      expect(res.status).toBe(404)
      expect(await errorOf(res)).toBe(message('es', 'statusPageNotFound'))
    })

    it('verify answers wrong codes in the page language', async () => {
      const res = await postJson(
        verifyRoute,
        `${BASE}/api/status-pages/${multilingual.slug}/subscribe/verify?locale=fr`,
        multilingual.slug,
        { target: '+15551234567', code: '000000' },
      )
      expect(res.status).toBe(400)
      expect(await errorOf(res)).toBe(message('fr', 'subscriptionCodeInvalid'))
    })

    it('refuse protected pages in their language', async () => {
      const res = await postJson(
        subscribeRoute,
        `${BASE}/api/status-pages/${locked.slug}/subscribe`,
        locked.slug,
        { channel: 'email', target: 'a@b.test' },
      )
      expect(res.status).toBe(401)
      expect(await errorOf(res)).toBe(message('de', 'statusPageProtected'))
    })
  })

  describe('access errors', () => {
    const login = (query: string, body: unknown, headers: Record<string, string> = {}) =>
      call(
        accessRoute,
        `${BASE}/api/status-pages/${locked.slug}/access${query}`,
        { slug: locked.slug },
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Real-IP': '203.0.113.71', ...headers },
          body: JSON.stringify(body),
        },
      )

    it("answer a wrong password in the page's language, not the app's", async () => {
      const plain = await login('', { password: 'wrong' }, { 'Accept-Language': 'en' })
      expect(plain.status).toBe(401)
      expect(await errorOf(plain)).toBe(message('de', 'statusPagePasswordIncorrect'))

      const fr = await login('?locale=fr', { password: 'wrong' })
      expect(await errorOf(fr)).toBe(message('fr', 'statusPagePasswordIncorrect'))

      // Not offered by this page: its default language.
      const es = await login('?locale=es', { password: 'wrong' })
      expect(await errorOf(es)).toBe(message('de', 'statusPagePasswordIncorrect'))
    })

    it('refuses cross-site posts in the requested language', async () => {
      const res = await login('?locale=fr', { password: 'wrong' }, { Origin: 'https://evil.test' })
      expect(res.status).toBe(403)
      expect(await errorOf(res)).toBe(message('fr', 'crossSiteRefused'))
    })
  })

  describe('badge and widget', () => {
    it('accept the language prefix through the proxy', async () => {
      for (const path of ['badge.svg', 'widget.js']) {
        const res = await proxy(new NextRequest(`${BASE}/status/${multilingual.slug}/fr/${path}`))
        expect(res.headers.get('x-middleware-rewrite'), path).toBe(
          `${BASE}/status/${multilingual.slug}/${path}`,
        )
        expect(res.headers.get(`x-middleware-request-${STATUS_LOCALE_HEADER}`), path).toBe('fr')
      }
    })

    it('link the widget to the page and its status in the prefixed language', async () => {
      const headers = { [STATUS_LOCALE_HEADER]: 'fr' }
      const res = await call(
        widgetRoute,
        `${BASE}/status/${multilingual.slug}/widget.js`,
        { slug: multilingual.slug },
        { headers },
      )
      expect(res.status).toBe(200)
      const script = await res.text()
      expect(script).toContain(`"url":"${BASE}/status/${multilingual.slug}/fr"`)
      expect(script).toContain(`${BASE}/status/${multilingual.slug}/fr/api/v2/status.json`)

      // Without a prefix (or with one the page does not offer): the default language.
      const plain = await call(
        widgetRoute,
        `${BASE}/status/${multilingual.slug}/widget.js`,
        { slug: multilingual.slug },
        { headers: { [STATUS_LOCALE_HEADER]: 'es' } },
      )
      expect(await plain.text()).toContain(`"url":"${BASE}/status/${multilingual.slug}"`)
    })

    it('serves the badge below a language prefix, its text in English', async () => {
      const res = await call(
        badgeRoute,
        `${BASE}/status/${multilingual.slug}/badge.svg`,
        { slug: multilingual.slug },
        { headers: { [STATUS_LOCALE_HEADER]: 'fr' } },
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('image/svg+xml')
      const svg = await res.text()
      expect(svg).not.toContain('opérationnel')
    })
  })
})
