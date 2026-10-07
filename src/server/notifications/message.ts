/**
 * Default notification text and the context of message templates.
 *
 * The default text mirrors Uptime Kuma 2.5.5 `Monitor.sendNotification`
 * (`server/model/monitor.js`, MIT, Louis Lam): `[monitor.name] [✅ Up] msg`. Templates are
 * sandboxed Liquid (`./liquid.ts`, #150) rendered against an allow-listed, plain-data context.
 * The words in it (status labels, fallbacks) come from `notifications.messages.*` in the
 * organization's language; the English catalogue reproduces Kuma's text byte for byte.
 */
import { env } from '@/env'
import { defaultLocale, type Locale } from '@/i18n/locales'
import type { Messages } from '@/i18n/messages'
import type { ChannelEvent } from '@/lib/notification-events'
import { escapeHtml } from '@/lib/markdown'
import type { TEMPLATE_VARIABLES } from '@/lib/notification-template-variables'
import { childLogger } from '@/lib/logger'
import { humanDuration } from '@/lib/validation/monitor'
import type { Heartbeat, Monitor } from '@/payload-types'
import { serverTranslator } from '@/server/i18n'
import { extractAddress } from '@/server/notification-providers/http'
import { renderLiquid, TemplateError, type RenderLiquidOptions, type TemplateMode } from './liquid'

const log = childLogger('notifications:template')

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
  /** The channel's organization (`{{ organization.name }}`, monitor links); null when unknown. */
  organization?: TemplateOrganization | null
  /** The organization's time zone for the `date` filter; UTC by default. */
  timeZone?: string
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

/** The organization a message is sent for, as templates and the default email see it. */
export interface TemplateOrganization {
  name: string
  slug: string
  /** Absolute URL of the organization logo, or null without one. */
  logoUrl: string | null
}

type TemplateMonitor = {
  id: string
  name: string
  type: string
  url: string
  hostname: string
  port: string
  description: string
  /** Link to the monitor in Marmot (`''` without an organization, e.g. test messages). */
  dashboardUrl: string
}

type TemplateHeartbeat = {
  status: string
  msg: string
  ping: string
  time: string
  duration: string
  retries: string
  downCount: string
  /** `time` in the organization's time zone, `YYYY-MM-DD HH:mm:ss` (Uptime Kuma's field). */
  localDateTime: string
  /** The organization's time zone (`Europe/Berlin`). */
  timezone: string
}

/**
 * Variables available to templates. Keep `TEMPLATE_VARIABLES` (checked below) and
 * `docs/Notifications.md` in step with it.
 */
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
  monitor: TemplateMonitor | null
  heartbeat: TemplateHeartbeat | null
  organization: { name: string; slug: string; logoUrl: string }
  /** Uptime Kuma's name for `monitor`. */
  monitorJSON: TemplateMonitor | null
  /** Uptime Kuma's name for `heartbeat`. */
  heartbeatJSON: TemplateHeartbeat | null
}

// The context and the variable list used to check templates must name the same variables.
type VariableShape<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends string ? true : VariableShape<NonNullable<T[K]>>
}
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T
/** Compile-time check only: fails to type-check when the two lists drift apart. */
export type TemplateVariablesMatchContext = Assert<
  Same<VariableShape<TemplateContext>, typeof TEMPLATE_VARIABLES>
>

const str = (value: unknown): string =>
  value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value)

/**
 * `2026-03-10 10:30:00` in `timeZone`: the shape of Uptime Kuma's `heartbeatJSON.localDateTime`.
 * A fixed, locale-neutral format like `formatHeartbeatTime`, so not routed through the formatter.
 */
function localDateTime(time: string | null | undefined, timeZone: string): string {
  if (!time) return ''
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return time
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(date)
        .map((part) => [part.type, part.value]),
    )
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
  } catch {
    return date.toISOString().replace('T', ' ').slice(0, 19)
  }
}

/** Link to a monitor's page in Marmot, or '' without an organization. */
export function monitorDashboardUrl(
  monitor: Pick<Monitor, 'id'> | null,
  organization: Pick<TemplateOrganization, 'slug'> | null | undefined,
): string {
  if (!monitor || !organization?.slug) return ''
  const base = env.NEXT_PUBLIC_SERVER_URL.replace(/\/+$/, '')
  return `${base}/${encodeURIComponent(organization.slug)}/monitors/${encodeURIComponent(String(monitor.id))}`
}

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
  const org = extras.organization ?? null
  const monitorVars: TemplateMonitor | null = monitor
    ? {
        id: str(monitor.id),
        name: str(monitor.name),
        type: str(monitor.type),
        url: str(monitor.url),
        hostname: str(monitor.hostname),
        port: str(monitor.port),
        description: str(monitor.description),
        dashboardUrl: monitorDashboardUrl(monitor, org),
      }
    : null
  const heartbeatVars: TemplateHeartbeat | null = heartbeat
    ? {
        status: str(heartbeat.status),
        msg: str(heartbeat.msg),
        ping: str(heartbeat.ping),
        time: str(heartbeat.time),
        duration: str(heartbeat.duration),
        retries: str(heartbeat.retries),
        downCount: str(heartbeat.downCount),
        localDateTime: localDateTime(heartbeat.time, extras.timeZone ?? 'UTC'),
        timezone: extras.timeZone ?? 'UTC',
      }
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
    monitor: monitorVars,
    heartbeat: heartbeatVars,
    organization: { name: org?.name ?? '', slug: org?.slug ?? '', logoUrl: org?.logoUrl ?? '' },
    monitorJSON: monitorVars,
    heartbeatJSON: heartbeatVars,
  }
}

/**
 * Render a Liquid template (`src/server/notifications/liquid.ts`) against `context`. Plain
 * `{{ monitor.name }}` templates render as they always did; unknown variables are empty. Throws
 * `TemplateError` when the template is invalid or exceeds a limit.
 */
export function renderTemplate(
  template: string,
  context: TemplateContext,
  options: RenderLiquidOptions = {},
): string {
  return renderLiquid(template, context, options)
}

/**
 * Convenience: render against monitor/heartbeat/message in one call. Providers pass the send
 * context's `event`, `downtimeSeconds` and `organization` as `extras` so `{{ event }}`,
 * `{{ downtime }}` and `{{ monitor.dashboardUrl }}` work.
 *
 * Never throws for a bad template: a template that does not parse or render (a limit, an error in
 * a filter) is logged and the default message `message` is sent instead, so an alert is never
 * lost to a template. Saving a channel rejects invalid templates up front (`validateTemplate`).
 */
export function renderMessageTemplate(
  template: string,
  message: string,
  monitor: Monitor | null,
  heartbeat: Heartbeat | null,
  locale: Locale = defaultLocale,
  extras: MessageExtras = {},
  mode: TemplateMode = 'text',
): string {
  try {
    return renderTemplate(
      template,
      buildTemplateContext(message, monitor, heartbeat, locale, extras),
      { mode, locale, timeZone: extras.timeZone },
    )
  } catch (error) {
    if (!(error instanceof TemplateError)) throw error
    log.warn(
      { err: error, code: error.code, monitorId: monitor?.id, event: extras.event },
      'notification template failed; sending the default message',
    )
    return mode === 'html' ? escapeHtml(message) : message
  }
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
