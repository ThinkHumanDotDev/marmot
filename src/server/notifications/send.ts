import type { Payload } from 'payload'

import type { Locale } from '@/i18n/locales'
import { childLogger } from '@/lib/logger'
import { normalizeChannelEvents, type ChannelEvent } from '@/lib/notification-events'
import type { Heartbeat, Monitor, Notification } from '@/payload-types'
import { getOrganizationI18n } from '@/server/i18n'
import { getNotificationProvider } from '@/server/notification-providers'
import { buildDefaultMessage, buildTestMessage } from './message'
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
}

/** Language a channel's messages are written in: its organization's, or the default. */
export async function getChannelLocale(
  payload: Payload,
  notification: Pick<NotificationChannelLike, 'organization'>,
): Promise<Locale> {
  return (await getOrganizationI18n(payload, notification.organization)).locale
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
  const locale = knownLocale ?? (await getChannelLocale(payload, notification))
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
