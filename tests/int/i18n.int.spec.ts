import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { appLocales, defaultLocale, locales } from '@/i18n/locales'
import { getMessages, publicCatalogues } from '@/i18n/messages'
import { isPublicMessageKey, PUBLIC_MESSAGE_SCOPES } from '@/i18n/messages/scopes'
import { resolveRequestLocale, resolveStatusPageLocale, statusPageTimeZone } from '@/i18n/resolve'
import {
  localizedPath,
  offeredLocales,
  preferredLocaleRedirect,
  STATUS_LOCALE_HEADER,
} from '@/lib/status-page-locales'
import { localeAlternates, statusPageBasePath } from '@/server/status-pages/urls'
import { getStaticFormatter, getTranslator } from '@/i18n/translator'
import { adminTranslations } from '@/i18n/admin'

let payload: Payload

const run = Date.now().toString(36)
const created: { collection: 'users' | 'organizations' | 'status-pages'; id: string | number }[] =
  []

/** Dotted leaf paths of a nested catalogue, sorted. */
function flattenKeys(value: unknown, prefix = ''): string[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key))
      .sort()
  }
  return [prefix]
}

describe('i18n', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
  })

  afterAll(async () => {
    for (const { collection, id } of created.reverse()) {
      await payload.delete({ collection, id, overrideAccess: true }).catch(() => undefined)
    }
  })

  describe('catalogues', () => {
    it('ships a catalogue with the same keys as English for every app locale', () => {
      const reference = flattenKeys(getMessages('en'))
      expect(reference.length).toBeGreaterThan(50)
      for (const locale of appLocales) {
        expect(flattenKeys(getMessages(locale)), `keys of ${locale}.json`).toEqual(reference)
      }
    })

    it('translates exactly the public status page keys in every other locale (#114)', () => {
      const reference = flattenKeys(getMessages('en')).filter(isPublicMessageKey)
      for (const scope of PUBLIC_MESSAGE_SCOPES) {
        expect(
          reference.some((key) => key === scope || key.startsWith(`${scope}.`)),
          `scope ${scope} exists in en.json`,
        ).toBe(true)
      }
      const extra = locales.filter((locale) => !(appLocales as readonly string[]).includes(locale))
      expect(extra.sort()).toEqual(Object.keys(publicCatalogues).sort())
      for (const [locale, catalogue] of Object.entries(publicCatalogues)) {
        expect(flattenKeys(catalogue), `keys of ${locale}.json`).toEqual(reference)
        // The ICU placeholders of every message are the same as in English.
        const placeholders = (text: string) =>
          [...text.matchAll(/\{\s*(\w+)\s*[,}]/g)].map((match) => match[1]).sort()
        for (const key of reference) {
          const read = (tree: unknown) =>
            key
              .split('.')
              .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree)
          expect(placeholders(read(catalogue) as string), `${locale}: ${key}`).toEqual(
            placeholders(read(getMessages('en')) as string),
          )
        }
      }
    })

    it('renders public strings in the visitor language and the rest in English', () => {
      expect(getTranslator('fr')('statusPages.overall.up')).toBe(
        'Tous les systèmes sont opérationnels',
      )
      expect(getTranslator('de')('statusPages.events.eventCount', { count: 2 })).toBe(
        '2 Ereignisse',
      )
      expect(getTranslator('es')('statusPages.overall.down')).toBe('Interrupción grave')
      // Outside the public scopes the catalogue falls back to English rather than raw keys.
      expect(getTranslator('fr')('statusPages.settings.save')).toBe('Save settings')
      expect(getStaticFormatter('fr', 'UTC').number(0.9998, 'percent')).toMatch(/^99,98\s%$/)
    })

    it('has no empty messages', () => {
      for (const locale of locales) {
        const empty = flattenKeys(getMessages(locale)).filter((key) => {
          const value = key
            .split('.')
            .reduce<unknown>(
              (node, part) => (node as Record<string, unknown> | undefined)?.[part],
              getMessages(locale),
            )
          return typeof value !== 'string' || value.trim() === ''
        })
        expect(empty, `empty messages in ${locale}.json`).toEqual([])
      }
    })

    it('renders ICU plurals and named formats outside React', () => {
      const t = getTranslator('en')
      expect(t('statusPages.beats.summary', { count: 1, parts: '1 up', latest: 'Up' })).toBe(
        'Last 1 check: 1 up. Latest: Up.',
      )
      expect(
        t('statusPages.beats.summary', { count: 50, parts: '48 up, 2 down', latest: 'Up' }),
      ).toBe('Last 50 checks: 48 up, 2 down. Latest: Up.')
      expect(t('statusPages.overall.up')).toBe('All systems operational')

      const utc = getStaticFormatter('en', 'UTC')
      const berlin = getStaticFormatter('en', 'Europe/Berlin')
      const instant = new Date('2026-07-01T10:00:00Z')
      expect(utc.dateTime(instant, 'short')).toBe('Jul 1, 2026, 10:00 AM')
      expect(berlin.dateTime(instant, 'short')).toBe('Jul 1, 2026, 12:00 PM')
      expect(utc.number(0.9998, 'percent')).toBe('99.98%')
      expect(utc.number(1, 'wholePercent')).toBe('100%')
    })
  })

  describe('Payload admin', () => {
    it('declares the supported admin languages and the marmot: namespace', () => {
      expect(Object.keys(payload.config.i18n.supportedLanguages)).toEqual(['en'])
      expect(payload.config.i18n.fallbackLanguage).toBe('en')
      expect(payload.config.i18n.translations?.en).toMatchObject(adminTranslations.en)
    })
  })

  describe('language fields', () => {
    it('defaults users.language to the default locale and rejects unknown values', async () => {
      const user = await payload.create({
        collection: 'users',
        data: { email: `i18n+${run}@marmot.test`, password: 'correct-horse-battery' },
        overrideAccess: true,
      })
      created.push({ collection: 'users', id: user.id })
      expect(user.language).toBe(defaultLocale)

      await expect(
        payload.update({
          collection: 'users',
          id: user.id,
          data: { language: 'xx' as never },
          overrideAccess: true,
        }),
      ).rejects.toThrow()
    })

    it('offers only complete catalogues as user and organization languages', async () => {
      await expect(
        payload.create({
          collection: 'organizations',
          data: { name: `i18n fr ${run}`, slug: `i18n-fr-${run}`, settings: { language: 'fr' } },
          overrideAccess: true,
          context: { skipOwnerMembership: true },
        } as never),
      ).rejects.toThrow()
    })

    it('defaults organizations and status pages to the default locale', async () => {
      const org = await payload.create({
        collection: 'organizations',
        data: { name: `i18n ${run}`, slug: `i18n-${run}` },
        overrideAccess: true,
        context: { skipOwnerMembership: true },
      })
      created.push({ collection: 'organizations', id: org.id })
      expect(org.settings?.language).toBe(defaultLocale)

      const page = await payload.create({
        collection: 'status-pages',
        data: { title: 'i18n', slug: `i18n-${run}`, organization: org.id },
        overrideAccess: true,
      })
      created.push({ collection: 'status-pages', id: page.id })
      expect(page.defaultLocale).toBe(defaultLocale)
      expect(page.timeZoneMode).toBe('visitor')

      const translated = await payload.update({
        collection: 'status-pages',
        id: page.id,
        data: {
          defaultLocale: 'de',
          additionalLocales: ['fr', 'en', 'fr'],
          timeZoneMode: 'page',
          timeZone: ' Europe/Berlin ',
        },
        overrideAccess: true,
      })
      expect(translated.defaultLocale).toBe('de')
      expect(translated.additionalLocales).toEqual(['fr', 'en'])
      expect(translated.timeZone).toBe('Europe/Berlin')
      expect(offeredLocales(translated)).toEqual(['de', 'fr', 'en'])

      const reread = await payload.findByID({
        collection: 'status-pages',
        id: page.id,
        overrideAccess: true,
      })
      expect(reread.additionalLocales).toEqual(['fr', 'en'])

      await expect(
        payload.update({
          collection: 'status-pages',
          id: page.id,
          data: { timeZone: 'Mars/Olympus' },
          overrideAccess: true,
        }),
      ).rejects.toThrow()
      await expect(
        payload.update({
          collection: 'status-pages',
          id: page.id,
          data: { additionalLocales: ['xx' as never] },
          overrideAccess: true,
        }),
      ).rejects.toThrow()
    })
  })

  describe('request locale', () => {
    // With one shipped language every path resolves to `en`; a wider list makes the order visible.
    const supported = ['en', 'fr', 'de']

    it('prefers the user record over the cookie over Accept-Language over the default', async () => {
      const user = await payload.create({
        collection: 'users',
        data: {
          email: `i18n-order+${run}@marmot.test`,
          password: 'correct-horse-battery',
          language: 'en',
        },
        overrideAccess: true,
      })
      created.push({ collection: 'users', id: user.id })

      const headers = new Headers({
        cookie: 'payload-token=x; marmot-locale=fr',
        'accept-language': 'de-DE, de;q=0.9',
      })
      expect(resolveRequestLocale({ headers, user }, supported)).toBe('en')
      expect(resolveRequestLocale({ headers, user: null }, supported)).toBe('fr')
      expect(
        resolveRequestLocale(
          { headers: new Headers({ 'accept-language': 'de-DE, de;q=0.9' }), user: null },
          supported,
        ),
      ).toBe('de')
      expect(resolveRequestLocale({ headers: new Headers(), user: null }, supported)).toBe(
        defaultLocale,
      )
    })

    it('ignores a stale cookie from a language that is no longer shipped', () => {
      const headers = new Headers({ cookie: 'marmot-locale=fr', 'accept-language': 'de' })
      expect(resolveRequestLocale({ headers, user: null })).toBe(defaultLocale)
    })
  })

  describe('status page locale (#114)', () => {
    const page = { slug: 'acme', defaultLocale: 'en', additionalLocales: ['fr', 'de'], domains: [] }
    const headers = (init: Record<string, string>) => new Headers(init)

    it('renders the plain URL in the default language and prefixed URLs in theirs', () => {
      expect(resolveStatusPageLocale(page, headers({ 'accept-language': 'fr' }))).toBe('en')
      expect(resolveStatusPageLocale(page, headers({ [STATUS_LOCALE_HEADER]: 'fr' }))).toBe('fr')
      // A language the page does not offer falls back to its default.
      expect(resolveStatusPageLocale(page, headers({ [STATUS_LOCALE_HEADER]: 'es' }))).toBe('en')
      expect(resolveStatusPageLocale(page, headers({ [STATUS_LOCALE_HEADER]: 'xx' }))).toBe('en')
      // Pages that do not exist follow the visitor among every shipped language.
      expect(resolveStatusPageLocale(null, headers({ 'accept-language': 'es-MX, en;q=0.5' }))).toBe(
        'es',
      )
      expect(resolveStatusPageLocale(null, headers({ 'accept-language': 'ja' }))).toBe('en')
    })

    it('sends first visits to the best offered match for Accept-Language', () => {
      expect(preferredLocaleRedirect(page, headers({ 'accept-language': 'fr-CA, en;q=0.8' }))).toBe(
        'fr',
      )
      expect(preferredLocaleRedirect(page, headers({ 'accept-language': 'en-GB, fr;q=0.8' }))).toBe(
        null,
      )
      // Spanish is shipped but not offered by this page.
      expect(preferredLocaleRedirect(page, headers({ 'accept-language': 'es, de;q=0.5' }))).toBe(
        'de',
      )
      expect(preferredLocaleRedirect(page, headers({ 'accept-language': 'es' }))).toBe(null)
      expect(preferredLocaleRedirect(page, headers({}))).toBe(null)
      // Already on a prefixed URL: never redirect.
      expect(
        preferredLocaleRedirect(
          page,
          headers({ 'accept-language': 'de', [STATUS_LOCALE_HEADER]: 'fr' }),
        ),
      ).toBe(null)
      // A page with one language never redirects.
      expect(
        preferredLocaleRedirect({ defaultLocale: 'en' }, headers({ 'accept-language': 'fr' })),
      ).toBe(null)
    })

    it("lets the switcher's choice win over Accept-Language, ignoring unoffered choices", () => {
      // Switched back to the default language: stay on the plain URL.
      expect(
        preferredLocaleRedirect(
          page,
          headers({ cookie: 'marmot-status-locale=en', 'accept-language': 'fr' }),
        ),
      ).toBe(null)
      expect(
        preferredLocaleRedirect(
          page,
          headers({ cookie: 'marmot-status-locale=de', 'accept-language': 'fr' }),
        ),
      ).toBe('de')
      expect(
        preferredLocaleRedirect(
          page,
          headers({ cookie: 'marmot-status-locale=es', 'accept-language': 'fr' }),
        ),
      ).toBe('fr')
    })

    it('builds localized paths, links and hreflang alternates', () => {
      expect(localizedPath(page, '/status/acme', '/status/acme', 'fr')).toBe('/status/acme/fr')
      expect(
        localizedPath(page, '/status/acme', '/status/acme/fr/events?month=2026-10', 'en'),
      ).toBe('/status/acme/events?month=2026-10')
      expect(localizedPath(page, '/status/acme', '/status/acme/fr/events', 'de')).toBe(
        '/status/acme/de/events',
      )
      // Custom domains: the page is the root.
      expect(localizedPath(page, '', '/', 'fr')).toBe('/fr')
      expect(localizedPath(page, '', '/fr', 'en')).toBe('/')
      expect(localizedPath(page, '', '/fr/events', 'en')).toBe('/events')

      expect(statusPageBasePath(page, headers({ [STATUS_LOCALE_HEADER]: 'fr' }))).toBe(
        '/status/acme/fr',
      )
      expect(statusPageBasePath(page, headers({}))).toBe('/status/acme')
      const alternates = localeAlternates(page, headers({}), '/events')
      expect(Object.keys(alternates)).toEqual(['en', 'fr', 'de', 'x-default'])
      expect(alternates.fr).toMatch(/\/status\/acme\/fr\/events$/)
      expect(alternates['x-default']).toMatch(/\/status\/acme\/events$/)
    })

    it("uses the page's time zone, then the organization's, then UTC", () => {
      const organization = { settings: { timezone: 'Asia/Tokyo' } } as never
      expect(statusPageTimeZone({ timeZone: 'Europe/Berlin', organization })).toBe('Europe/Berlin')
      expect(statusPageTimeZone({ timeZone: null, organization })).toBe('Asia/Tokyo')
      expect(statusPageTimeZone({ timeZone: 'nope', organization: null as never })).toBe('UTC')
    })
  })
})
