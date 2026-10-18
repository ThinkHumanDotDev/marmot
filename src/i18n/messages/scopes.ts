import type { Messages } from './index'

/**
 * `errors.*` messages a visitor of a public page can get from its API endpoints (#271): signing in
 * (`/api/status-pages/:slug/access`) and subscribing (`/subscribe`, `/subscribe/verify`). These
 * routes answer in the page's language (`visitorLocale`), so their messages are translated too.
 */
export const VISITOR_ERROR_KEYS = [
  'invalidJsonBody',
  'tooManyAttempts',
  'statusPageNotFound',
  'crossSiteRefused',
  'statusPageProtected',
  'statusPagePasswordIncorrect',
  'statusPageIpNotAllowed',
  'statusPageLinkInvalid',
  'invalidEmailAddress',
  'subscriberTargetInvalid',
  'subscriberComponentsInvalid',
  'subscriptionsUnavailable',
  'subscriptionChannelUnavailable',
  'subscriptionCodeInvalid',
] as const satisfies readonly (keyof Messages['errors'])[]

/**
 * The parts of the catalogue a visitor of a public status page can see (#114): the page, its
 * history and permalinks, the access and subscription pages, the feeds and machine-readable
 * outputs, the emails, SMS and chat messages sent to subscribers, and the API errors visitors see.
 *
 * Languages outside `appLocales` ship a catalogue with exactly these keys
 * (`tests/int/i18n.int.spec.ts` checks it); everything else falls back to English, which only the
 * signed-in app would show. A string added to one of these scopes in `en.json` therefore has to be
 * translated in every catalogue before CI passes. Each entry is a dotted key prefix.
 */
export const PUBLIC_MESSAGE_SCOPES = [
  'common.duration',
  'common.relativeTime',
  'statusPages.overall',
  'statusPages.notFound',
  'statusPages.sections',
  'statusPages.maintenance',
  'statusPages.monitors',
  'statusPages.uptime',
  'statusPages.charts',
  'statusPages.metrics',
  'statusPages.public',
  'statusPages.beats',
  'statusPages.footer',
  'statusPages.localeSwitcher',
  'statusPages.timeZone',
  'statusPages.rss',
  'statusPages.machine',
  'statusPages.events',
  'statusPages.seo',
  'statusPages.subscribe',
  'statusPages.subscription',
  'statusPages.theme.toggle',
  'statusPages.access.pageTitle',
  'statusPages.access.metaTitle',
  'statusPages.access.description',
  'statusPages.access.password',
  'statusPages.access.submit',
  'statusPages.access.invalid',
  'statusPages.access.rateLimited',
  'statusPages.access.emailDomain',
  'statusPages.access.audience',
  'statusPages.access.ipAllowlist',
  'email.subscriptions',
  'email.statusPageMagicLink',
  ...VISITOR_ERROR_KEYS.map((key) => `errors.${key}` as const),
  'subscriberMessages',
] as const

/** Whether the dotted `key` belongs to one of the public scopes. */
export const isPublicMessageKey = (key: string): boolean =>
  PUBLIC_MESSAGE_SCOPES.some((scope) => key === scope || key.startsWith(`${scope}.`))
