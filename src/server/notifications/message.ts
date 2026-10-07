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

/** `[name] [🔴 Down] msg` — what every provider sends unless it formats richer content. */
export function buildDefaultMessage(
  monitor: Monitor | null,
  heartbeat: Heartbeat | null,
  locale: Locale = defaultLocale,
): string {
  const t = serverTranslator(locale)
  const name = monitor?.name ?? 'Marmot'
  const label = statusLabel(heartbeat?.status, locale)
  const msg =
    heartbeat?.msg?.trim() ||
    (heartbeat
      ? t('notifications.messages.noMessage')
      : t('notifications.messages.testNotification'))
  return `[${name}] [${label}] ${msg}`
}

/** Message used by the "Test" button. */
export function buildTestMessage(channelName?: string, locale: Locale = defaultLocale): string {
  const t = serverTranslator(locale)
  const text = channelName
    ? t('notifications.messages.testConfigured', { channel: channelName })
    : t('notifications.messages.testing')
  return `[Marmot] [${statusLabel(null, locale)}] ${text}`
}

/** Variables available to `{{ }}` templates. Keep this list in `docs/Notifications.md`. */
export interface TemplateContext {
  msg: string
  status: string
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
): TemplateContext {
  return {
    msg: message,
    status: statusLabel(heartbeat?.status, locale),
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

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}/g

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
 * Replace `{{ monitor.name }}`-style placeholders. Anything that is not a plain dotted path is left
 * untouched, so templates can never execute code or reach outside the context object.
 */
export function renderTemplate(template: string, context: TemplateContext): string {
  return template.replace(PLACEHOLDER, (_match, path: string) => lookup(context, path))
}

/** Convenience: render against monitor/heartbeat/message in one call. */
export function renderMessageTemplate(
  template: string,
  message: string,
  monitor: Monitor | null,
  heartbeat: Heartbeat | null,
  locale: Locale = defaultLocale,
): string {
  return renderTemplate(template, buildTemplateContext(message, monitor, heartbeat, locale))
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
