/**
 * Default notification text and a tiny, safe template renderer.
 *
 * The default text mirrors Uptime Kuma 2.5.5 `Monitor.sendNotification`
 * (`server/model/monitor.js`, MIT, Louis Lam): `[monitor.name] [✅ Up] msg`. Templates support
 * `{{ path }}` placeholders resolved against an allow-listed context — no expressions, no eval.
 * The words in it (status labels, fallbacks) come from `notifications.messages.*` in the
 * organization's language; the English catalogue reproduces Kuma's text byte for byte.
 */
import { defaultLocale, type Locale } from '@/i18n/locales'
import type { Messages } from '@/i18n/messages'
import type { ChannelEvent } from '@/lib/notification-events'
import { humanDuration } from '@/lib/validation/monitor'
import { renderPlaceholders } from '@/lib/placeholders'
import type { Heartbeat, Monitor } from '@/payload-types'
import { serverTranslator } from '@/server/i18n'
import { extractAddress } from '@/server/notification-providers/http'

export type NotificationStatus = Heartbeat['status']

/**
 * Status label in a message (`✅ Up`), in `locale` (`notifications.messages.status.*`). Without a
 * status (test notifications) the label is `⚠️ Test`. The surrounding `[name] [label] msg` shape
 * is Kuma's wire format and stays as is in every language.
 */
export function statusLabel(
  status: NotificationStatus | null | undefined,
  locale: Locale = defaultLocale,
): string {
  return serverTranslator(locale)(`notifications.messages.status.${status ?? 'test'}`)
}

type ProviderTextKey = keyof Messages['notifications']['messages']['providers']

/**
 * Wording of provider-specific payloads (embed titles, field names, card headings) in `locale`:
 * `notifications.messages.providers.*`. Product names, identifiers (`source`, `alias`, dedup keys)
 * and payload keys are not messages. The English catalogue reproduces the ported text byte for
 * byte, so English payloads are unchanged.
 */
export function providerText(locale: Locale = defaultLocale) {
  const t = serverTranslator(locale) as unknown as (
    key: string,
    values?: Record<string, string | number>,
  ) => string
  return (key: ProviderTextKey, values?: Record<string, string | number>) =>
    t(`notifications.messages.providers.${key}`, values)
}

/** `Time: <heartbeat time>` in `locale` (`notifications.messages.timeLine`). */
export function timeLine(heartbeat: Heartbeat | null, locale: Locale = defaultLocale): string {
  return serverTranslator(locale)('notifications.messages.timeLine', {
    time: formatHeartbeatTime(heartbeat),
  })
}

/** What a message is about, beyond the monitor and heartbeat (#126). */
export interface MessageExtras {
  /** Why the channel is told (`down`, `up`, …); null for test messages without an event. */
  event?: ChannelEvent | null
  /** How long the monitor was DOWN, on `up` (recovery) messages; null when unknown. */
  downtimeSeconds?: number | null
}

/** `1 hour 5 minutes` in `locale` (`common.duration.*`). */
export function formatDowntime(seconds: number, locale: Locale = defaultLocale): string {
  const t = serverTranslator(locale)
  return humanDuration(seconds, (unit, count) => t(`common.duration.${unit}`, { count }))
}

/**
 * `[name] [🔴 Down] msg` — what every provider sends unless it formats richer content. Recovery
 * messages with a known downtime end with ` (down for 5 minutes 3 seconds)`.
 */
export function buildDefaultMessage(
  monitor: Monitor | null,
  heartbeat: Heartbeat | null,
  locale: Locale = defaultLocale,
  extras: MessageExtras = {},
): string {
  const t = serverTranslator(locale)
  const name = monitor?.name ?? 'Marmot'
  const label = statusLabel(heartbeat?.status, locale)
  const msg =
    heartbeat?.msg?.trim() ||
    (heartbeat
      ? t('notifications.messages.noMessage')
      : t('notifications.messages.testNotification'))
  const downtime =
    extras.event === 'up' && extras.downtimeSeconds != null && extras.downtimeSeconds > 0
      ? t('notifications.messages.downtimeSuffix', {
          duration: formatDowntime(extras.downtimeSeconds, locale),
        })
      : ''
  return `[${name}] [${label}] ${msg}${downtime}`
}

/** Display name of a channel event in `locale` (`notifications.events.*`). */
export function channelEventLabel(event: ChannelEvent, locale: Locale = defaultLocale): string {
  return serverTranslator(locale)(`notifications.events.${event}.label`)
}

/**
 * Message used by the "Test" button. With `event` it is the sample of that event
 * (`[Marmot] [⚠️ Test] Down: "Ops" is configured correctly.`).
 */
export function buildTestMessage(
  channelName?: string,
  locale: Locale = defaultLocale,
  event?: ChannelEvent | null,
): string {
  const t = serverTranslator(locale)
  const text = channelName
    ? t('notifications.messages.testConfigured', { channel: channelName })
    : t('notifications.messages.testing')
  const prefix = event ? `${channelEventLabel(event, locale)}: ` : ''
  return `[Marmot] [${statusLabel(null, locale)}] ${prefix}${text}`
}

/** Variables available to `{{ }}` templates. Keep this list in `docs/Notifications.md`. */
export interface TemplateContext {
  msg: string
  status: string
  /** Channel event (`down`, `up`, `degraded`, `reminder`, `certificate`, `maintenance`) or ''. */
  event: string
  /** Downtime of a recovery (`5 minutes 3 seconds`) or ''. */
  downtime: string
  /** Downtime of a recovery in seconds, or ''. */
  downtimeSeconds: string
  name: string
  hostnameOrURL: string
  monitor: {
    id: string
    name: string
    type: string
    url: string
    hostname: string
    port: string
    description: string
  } | null
  heartbeat: {
    status: string
    msg: string
    ping: string
    time: string
    duration: string
    retries: string
    downCount: string
  } | null
}

const str = (value: unknown): string =>
  value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value)

export function buildTemplateContext(
  message: string,
  monitor: Monitor | null,
  heartbeat: Heartbeat | null,
  locale: Locale = defaultLocale,
  extras: MessageExtras = {},
): TemplateContext {
  const downtimeSeconds =
    extras.downtimeSeconds != null && extras.downtimeSeconds > 0
      ? Math.round(extras.downtimeSeconds)
      : null
  return {
    msg: message,
    status: statusLabel(heartbeat?.status, locale),
    event: extras.event ?? '',
    downtime: downtimeSeconds !== null ? formatDowntime(downtimeSeconds, locale) : '',
    downtimeSeconds: downtimeSeconds !== null ? String(downtimeSeconds) : '',
    name:
      monitor?.name ?? serverTranslator(locale)('notifications.messages.monitorNameUnavailable'),
    hostnameOrURL: monitor ? extractAddress(monitor) : 'testing.hostname',
    monitor: monitor
      ? {
          id: str(monitor.id),
          name: str(monitor.name),
          type: str(monitor.type),
          url: str(monitor.url),
          hostname: str(monitor.hostname),
          port: str(monitor.port),
          description: str(monitor.description),
        }
      : null,
    heartbeat: heartbeat
      ? {
          status: str(heartbeat.status),
          msg: str(heartbeat.msg),
          ping: str(heartbeat.ping),
          time: str(heartbeat.time),
          duration: str(heartbeat.duration),
          retries: str(heartbeat.retries),
          downCount: str(heartbeat.downCount),
        }
      : null,
  }
}

/** Resolve `a.b.c` against a plain-data context; unknown paths resolve to ''. */
function lookup(context: TemplateContext, path: string): string {
  let current: unknown = context
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return ''
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return ''
    current = (current as Record<string, unknown>)[segment]
  }
  if (current === null || current === undefined) return ''
  return typeof current === 'object' ? JSON.stringify(current) : String(current)
}

/**
 * Replace `{{ monitor.name }}`-style placeholders (the shared renderer in `src/lib/placeholders.ts`).
 * Anything that is not a plain dotted path is left untouched, so templates can never execute code
 * or reach outside the context object; unknown paths render as ''.
 */
export function renderTemplate(template: string, context: TemplateContext): string {
  return renderPlaceholders(template, (path) => lookup(context, path))
}

/**
 * Convenience: render against monitor/heartbeat/message in one call. Providers pass the send
 * context's `event` and `downtimeSeconds` as `extras` so `{{ event }}` and `{{ downtime }}` work.
 */
export function renderMessageTemplate(
  template: string,
  message: string,
  monitor: Monitor | null,
  heartbeat: Heartbeat | null,
  locale: Locale = defaultLocale,
  extras: MessageExtras = {},
): string {
  return renderTemplate(template, buildTemplateContext(message, monitor, heartbeat, locale, extras))
}

/**
 * `2026-03-10 10:30:00 (UTC)` style timestamp for messages. Deliberately ISO-like and locale-neutral
 * (Kuma's format, parsed by some receivers), so it is not routed through the locale formatter.
 */
export function formatHeartbeatTime(heartbeat: Heartbeat | null): string {
  if (!heartbeat?.time) return ''
  const date = new Date(heartbeat.time)
  if (Number.isNaN(date.getTime())) return heartbeat.time
  return `${date.toISOString().replace('T', ' ').slice(0, 19)} (UTC)`
}
