import { isLocale } from '@/i18n/locales'
import { localePrefix, offeredLocales, type LocalizedPage } from '@/lib/status-page-locales'
import type { StatusPage, StatusPageSubscriber } from '@/payload-types'
import { serverUrl, statusPageUrl } from '@/server/status-pages/urls'

import { subscriberLinkToken } from './tokens'

export interface SubscriptionLinks {
  /** Page to choose components or unsubscribe (`/status/:slug/manage/:token`). */
  manageUrl: string
  /** Page with a one-click unsubscribe button (`/status/:slug/unsubscribe/:token`). */
  unsubscribeUrl: string
  /** Double opt-in confirmation page (`/status/:slug/confirm/:token`). */
  confirmUrl: string
  /** RFC 8058 one-click endpoint for `List-Unsubscribe` (POST). */
  oneClickUrl: string
}

type PageLike = Pick<StatusPage, 'slug'> & LocalizedPage
type SubscriberLike = Pick<StatusPageSubscriber, 'id'> & {
  token?: string | null
  locale?: string | null
}

/** The language prefix of a subscriber's pages: theirs when the page offers it (#114). */
export const subscriberPrefix = (page: PageLike, subscriber: SubscriberLike): string =>
  isLocale(subscriber.locale, offeredLocales(page)) ? localePrefix(page, subscriber.locale) : ''

/**
 * Links carried by every message. They always point at Marmot's own host (custom domains only
 * serve the page itself) and work without the page's access cookie: the token is the credential.
 * The manage, unsubscribe and confirmation pages open in the subscriber's language.
 */
export function subscriptionLinks(page: PageLike, subscriber: SubscriberLike): SubscriptionLinks {
  const token = encodeURIComponent(subscriberLinkToken(subscriber))
  const base = `${statusPageUrl(page.slug)}${subscriberPrefix(page, subscriber)}`
  return {
    manageUrl: `${base}/manage/${token}`,
    unsubscribeUrl: `${base}/unsubscribe/${token}`,
    confirmUrl: `${base}/confirm/${token}`,
    oneClickUrl: `${serverUrl()}/api/status-pages/${encodeURIComponent(page.slug)}/subscriptions/${token}/unsubscribe`,
  }
}

/** Where messages send visitors: the first custom domain, else `/status/:slug`. */
export function publicPageUrl(page: Pick<StatusPage, 'slug' | 'domains'>): string {
  const domain = page.domains?.find((row) => row?.hostname)?.hostname
  return domain ? `https://${domain}` : statusPageUrl(page.slug)
}
