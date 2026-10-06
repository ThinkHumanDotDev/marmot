import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { defaultLocale, locales } from '@/i18n/locales'
import { getMessages } from '@/i18n/messages'
import { resolveRequestLocale } from '@/i18n/resolve'
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
    it('ships a catalogue with the same keys as English for every locale', () => {
      const reference = flattenKeys(getMessages('en'))
      expect(reference.length).toBeGreaterThan(50)
      for (const locale of locales) {
        expect(flattenKeys(getMessages(locale)), `keys of ${locale}.json`).toEqual(reference)
      }
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
      expect(page.language).toBe(defaultLocale)

      const auto = await payload.update({
        collection: 'status-pages',
        id: page.id,
        data: { language: 'auto' },
        overrideAccess: true,
      })
      expect(auto.language).toBe('auto')
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
})
