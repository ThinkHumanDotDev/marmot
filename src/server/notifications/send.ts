import type { Payload } from 'payload'

import { env } from '@/env'
import { timeZoneOrDefault } from '@/i18n/formats'
import { defaultLocale, type Locale } from '@/i18n/locales'
import { toLocale } from '@/i18n/translator'
import { childLogger } from '@/lib/logger'
import { normalizeChannelEvents, type ChannelEvent } from '@/lib/notification-events'
import type { Heartbeat, Media, Monitor, Notification, Organization } from '@/payload-types'
import { getOrganizationI18n, serverTranslator } from '@/server/i18n'
import { getNotificationProvider } from '@/server/notification-providers'
import { TemplateError, validateTemplate, TEMPLATE_MAX_LENGTH, TEMPLATE_MAX_OUTPUT } from './liquid'
import { buildDefaultMessage, buildTestMessage, type TemplateOrganization } from './message'
import { assertServerSmtpSendAllowed, usesServerSmtp } from './server-smtp'

const log = childLogger('notifications:send')

/** The subset of a channel document `sendNotification` needs; unsaved test channels satisfy it. */
export type NotificationChannelLike = Pick<Notification, 'type' | 'config'> & {
  id?: Notification['id']
  name?: string | null
  /** Event selection (`normalizeChannelEvents`); test samples are sent for each. */
  events?: Notification['events']
  /** Owning organization (id or populated doc); unsaved test channels pass the URL's organization. */
  organization?: Notification['organization'] | null
}

export interface SendNotificationOptions {
  /** Override the rendered message (defaults to `[name] [status] msg`). */
  message?: string
  monitor: Monitor | null
  heartbeat: Heartbeat | null
  /** Why the channel is told; handed to the provider (`{{ event }}` in templates). */
  event?: ChannelEvent | null
  /** Downtime of a recovery (`up`) in seconds, when known. */
  downtimeSeconds?: number | null
  /**
   * Language of the message; defaults to the channel organization's `settings.language`. Callers
   * that already know it (the queue worker, expiry fan-out) pass it to skip the lookup.
   */
  locale?: Locale
  /**
   * The channel organization's language, time zone and branding (`getChannelOrganization`).
   * Callers that already loaded it (the queue worker) pass it to skip the lookup; it then also
   * decides the language unless `locale` is given.
   */
  channelOrganization?: ChannelOrganization
}

/** Language a channel's messages are written in: its organization's, or the default. */
export async function getChannelLocale(
  payload: Payload,
  notification: Pick<NotificationChannelLike, 'organization'>,
): Promise<Locale> {
  return (await getOrganizationI18n(payload, notification.organization)).locale
}

export interface ChannelOrganization {
  locale: Locale
  /** IANA time zone (`settings.timezone`, else UTC). */
  timeZone: string
  /** Name, slug and logo for templates and the default email; null when unknown. */
  organization: TemplateOrganization | null
}

const absoluteUrl = (url: string) =>
  /^https?:\/\//i.test(url) ? url : `${env.NEXT_PUBLIC_SERVER_URL.replace(/\/+$/, '')}${url}`

/**
 * Language, time zone and branding of a channel's organization in one lookup. Never throws: a
 * missing organization yields English/UTC without branding so a delivery is never lost to it.
 */
export async function getChannelOrganization(
  payload: Payload,
  notification: Pick<NotificationChannelLike, 'organization'>,
): Promise<ChannelOrganization> {
  const ref = notification.organization
  const id = ref && typeof ref === 'object' ? ref.id : ref
  if (id === null || id === undefined || String(id) === '') {
    return { locale: defaultLocale, timeZone: 'UTC', organization: null }
  }
  try {
    const doc = (await payload.findByID({
      collection: 'organizations',
      id,
      depth: 1,
      overrideAccess: true,
      disableErrors: true,
      select: { name: true, slug: true, logo: true, settings: true },
    })) as Pick<Organization, 'name' | 'slug' | 'logo' | 'settings'> | null
    if (!doc) return { locale: defaultLocale, timeZone: 'UTC', organization: null }
    const logo = doc.logo && typeof doc.logo === 'object' ? (doc.logo as Media) : null
    return {
      locale: toLocale(doc.settings?.language),
      timeZone: timeZoneOrDefault(doc.settings?.timezone),
      organization: {
        name: doc.name,
        slug: doc.slug,
        logoUrl: logo?.url ? absoluteUrl(logo.url) : null,
      },
    }
  } catch (err) {
    log.warn({ err, organization: id }, 'cannot load the channel organization; using defaults')
    return { locale: defaultLocale, timeZone: 'UTC', organization: null }
  }
}

/** Template fields of a provider (`fieldMeta[key].template`). */
export function templateFields(type: string): string[] {
  const provider = getNotificationProvider(type)
  return Object.entries(provider?.fieldMeta ?? {})
    .filter(([, meta]) => meta.template)
    .map(([key]) => key)
}

/** A `TemplateError` as a sentence in `locale` (`notifications.templates.errors.*`). */
export function templateErrorText(error: TemplateError, locale: Locale = defaultLocale): string {
  const t = serverTranslator(locale)
  switch (error.code) {
    case 'tooLong':
      return t('notifications.templates.errors.tooLong', { max: TEMPLATE_MAX_LENGTH })
    case 'outputTooLong':
      return t('notifications.templates.errors.outputTooLong', { max: TEMPLATE_MAX_OUTPUT })
    case 'unknownVariable':
      return t('notifications.templates.errors.unknownVariable', { name: error.detail })
    case 'render':
      return t('notifications.templates.errors.render', { detail: error.detail })
    default:
      return t('notifications.templates.errors.syntax', { detail: error.detail })
  }
}

/**
 * Check every non-empty template field of a (schema-valid) config: Liquid syntax, allowed tags and
 * filters, length and known variables. Throws `NotificationConfigError` with one issue per broken
 * field (`path` is the config key). Saving and testing a channel run this (with `previous`, the
 * stored channel, only for templates that changed); sending does not, so a channel saved before a
 * rule existed keeps delivering (with the default message as fallback).
 */
export function validateNotificationTemplates(
  type: string,
  config: Record<string, unknown>,
  locale: Locale = defaultLocale,
  previous?: { type?: string | null; config?: unknown } | null,
): void {
  const issues: { path: string; message: string }[] = []
  const before =
    previous && previous.type === type && previous.config && typeof previous.config === 'object'
      ? (previous.config as Record<string, unknown>)
      : null
  for (const key of templateFields(type)) {
    const value = config[key]
    if (typeof value !== 'string' || !value.trim()) continue
    // Unchanged templates are not re-checked: a channel saved before a rule existed stays editable
    // and keeps delivering (any update, the worker's bookkeeping included, goes through here).
    if (before && before[key] === value) continue
    try {
      validateTemplate(value.trim())
    } catch (error) {
      if (!(error instanceof TemplateError)) throw error
      issues.push({ path: key, message: templateErrorText(error, locale) })
    }
  }
  if (issues.length) {
    throw new NotificationConfigError(
      issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      issues,
    )
  }
}

export class NotificationConfigError extends Error {
  readonly issues: { path: string; message: string }[]
  constructor(message: string, issues: { path: string; message: string }[] = []) {
    super(message)
    this.name = 'NotificationConfigError'
    this.issues = issues
  }
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/**
 * Validate `config` against the provider's `configSchema`. Returns the parsed config (defaults
 * applied) or throws `NotificationConfigError` listing the offending keys.
 */
export function validateNotificationConfig(type: string, config: unknown): Record<string, unknown> {
  const provider = getNotificationProvider(type)
  if (!provider) {
    throw new NotificationConfigError(`Unknown notification type "${type}"`, [
      { path: 'type', message: `Unknown notification type "${type}"` },
    ])
  }
  const result = provider.configSchema.safeParse(asRecord(config))
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    }))
    const summary = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ')
    throw new NotificationConfigError(`Invalid ${provider.label} configuration: ${summary}`, issues)
  }
  return result.data as Record<string, unknown>
}

/** `validateNotificationConfig`, or the config unchanged when it does not validate (for comparisons). */
export function normalizeNotificationConfig(
  type: string | null | undefined,
  config: unknown,
): unknown {
  if (!type) return config
  try {
    return validateNotificationConfig(type, config)
  } catch {
    return config
  }
}

/**
 * Resolve the provider for a channel and deliver one message. Used by the queue worker and the
 * test endpoint. Resolves with the provider's success string; throws on failure.
 */
export async function sendNotification(
  payload: Payload,
  notification: NotificationChannelLike,
  {
    message,
    monitor,
    heartbeat,
    event = null,
    downtimeSeconds = null,
    locale: knownLocale,
    channelOrganization,
  }: SendNotificationOptions,
): Promise<string> {
  const provider = getNotificationProvider(notification.type)
  if (!provider) {
    throw new NotificationConfigError(`Unknown notification type "${notification.type}"`)
  }
  const config = validateNotificationConfig(notification.type, notification.config)
  if (usesServerSmtp(notification.type, config)) {
    const org = notification.organization
    await assertServerSmtpSendAllowed({
      orgId: org && typeof org === 'object' ? org.id : org,
      config,
    })
  }
  const org = channelOrganization ?? (await getChannelOrganization(payload, notification))
  const locale = knownLocale ?? org.locale
  const text =
    message ?? buildDefaultMessage(monitor, heartbeat, locale, { event, downtimeSeconds })

  log.debug(
    { type: notification.type, notificationId: notification.id, monitorId: monitor?.id, event },
    'sending notification',
  )
  return provider.send({
    config,
    message: text,
    monitor,
    heartbeat,
    locale,
    event,
    downtimeSeconds,
    organization: org.organization,
    timeZone: org.timeZone,
  })
}

export interface TestNotificationResult {
  /** The provider's success string of the last sample. */
  result: string
  /** Events a sample was sent for, in order. */
  events: ChannelEvent[]
}

/**
 * Send the "Test" messages for a saved or unsaved channel: one sample per event the channel
 * accepts (`events`, or the defaults), in `CHANNEL_EVENTS` order. Stops at the first failure.
 */
export async function sendTestNotification(
  payload: Payload,
  notification: NotificationChannelLike,
): Promise<TestNotificationResult> {
  const locale = await getChannelLocale(payload, notification)
  const events = normalizeChannelEvents(notification.events)
  let result = ''
  for (const event of events) {
    result = await sendNotification(payload, notification, {
      message: buildTestMessage(notification.name ?? undefined, locale, event),
      monitor: null,
      heartbeat: null,
      event,
      locale,
    })
  }
  return { result, events }
}
