import type { Payload, PayloadRequest } from 'payload'

import { timeZoneOrDefault } from '@/i18n/formats'
import { defaultLocale, type Locale } from '@/i18n/locales'
import { getStaticFormatter, getTranslator, toLocale } from '@/i18n/translator'
import { childLogger } from '@/lib/logger'
import type { Organization } from '@/payload-types'

/**
 * Server-side translation for text Marmot sends on behalf of an organization: emails, notification
 * bodies, expiry warnings. The recipient is often not a Marmot user (a Slack channel, an invited
 * address), so the organization's `settings.language` decides, falling back to `defaultLocale`.
 */

const log = childLogger('i18n')

export type ServerTranslator = ReturnType<typeof getTranslator>

const translators = new Map<Locale, ServerTranslator>()

/** `getTranslator(locale)`, memoised per locale: the worker renders a message per delivery. */
export function serverTranslator(locale: Locale = defaultLocale): ServerTranslator {
  let t = translators.get(locale)
  if (!t) {
    t = getTranslator(locale)
    translators.set(locale, t)
  }
  return t
}

export interface OrganizationI18n {
  locale: Locale
  /** `settings.timezone` when it is a valid IANA zone, otherwise UTC. */
  timeZone: string
}

const DEFAULT_ORG_I18N: OrganizationI18n = { locale: defaultLocale, timeZone: 'UTC' }

type OrgLike = Pick<Organization, 'settings'>

const fromDoc = (org: Partial<OrgLike>): OrganizationI18n => ({
  locale: toLocale(org.settings?.language),
  timeZone: timeZoneOrDefault(org.settings?.timezone),
})

/**
 * Locale and time zone of an organization, given its id or a populated document. Never throws:
 * a missing organization (or a lookup failure) yields English/UTC so a delivery is never lost to it.
 */
export async function getOrganizationI18n(
  payload: Payload,
  organization: string | number | Partial<OrgLike> | null | undefined,
  req?: Partial<PayloadRequest>,
): Promise<OrganizationI18n> {
  if (organization === null || organization === undefined || organization === '') {
    return DEFAULT_ORG_I18N
  }
  if (typeof organization === 'object') {
    if ('settings' in organization) return fromDoc(organization)
    const id = (organization as { id?: string | number }).id
    if (id === undefined) return DEFAULT_ORG_I18N
    organization = id
  }
  try {
    const doc = await payload.findByID({
      collection: 'organizations',
      id: organization,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
      select: { settings: true },
      ...(req ? { req } : {}),
    })
    return doc ? fromDoc(doc) : DEFAULT_ORG_I18N
  } catch (err) {
    log.warn({ err, organization }, 'cannot load organization language; using the default')
    return DEFAULT_ORG_I18N
  }
}

/** Formatter for server-rendered text in an organization's locale and time zone. */
export const organizationFormatter = ({ locale, timeZone }: OrganizationI18n) =>
  getStaticFormatter(locale, timeZone)
