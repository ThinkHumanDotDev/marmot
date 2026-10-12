/**
 * The parts of the catalogue a visitor of a public status page can see (#114): the page, its
 * history and permalinks, the access and subscription pages, the feeds and machine-readable
 * outputs, and the emails, SMS and chat messages sent to subscribers.
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
  'statusPages.access.ipAllowlist',
  'email.subscriptions',
  'email.statusPageMagicLink',
  'subscriberMessages',
] as const

/** Whether the dotted `key` belongs to one of the public scopes. */
export const isPublicMessageKey = (key: string): boolean =>
  PUBLIC_MESSAGE_SCOPES.some((scope) => key === scope || key.startsWith(`${scope}.`))
