/**
 * What subscribers receive: an `Announcement` (built from a `subscriber-notifications` snapshot and
 * its page) rendered per channel. Emails are in `src/server/email/subscriber-emails.ts`; SMS, the
 * versioned webhook JSON and the Slack / Discord formats are here. Everything is in the subscriber's
 * locale and the organization's time zone.
 */
import type { Payload } from 'payload'

import type { Locale } from '@/i18n/locales'
import { isIncidentStatus } from '@/lib/incident-timeline'
import { OCCURRENCE_STATES, type OccurrenceState } from '@/lib/maintenance-announcements'
import { markdownToText } from '@/lib/markdown'
import { componentDisplayName } from '@/lib/status-page-components'
import {
  DEFAULT_SMS_MAX_SEGMENTS,
  isIncidentEvent,
  renderSmsTemplate,
  smsTemplateKeyFor,
  truncateSms,
  type NotificationEvent,
} from '@/lib/status-page-subscribers'
import type { Monitor, StatusPage, SubscriberNotification } from '@/payload-types'
import { organizationFormatter, serverTranslator, type OrganizationI18n } from '@/server/i18n'

import { statusPageEventUrl } from '@/server/status-pages/urls'

import type { SubscriptionLinks } from './links'
import { publicPageUrl } from './links'

export interface AnnouncementComponent {
  id: string
  name: string
}

/** A notification ready to render. */
export interface Announcement {
  /** Notification id (`null` for previews of unsaved content and welcome messages). */
  id: string | null
  event: NotificationEvent
  siteName: string
  title: string
  /** Raw status (incident status or maintenance occurrence state). */
  status: string | null
  /** Markdown. */
  message: string
  /** Where messages send readers: the event's permalink (#107), else the page. */
  url: string
  /** Public page URL. */
  pageUrl: string
  components: AnnouncementComponent[]
  window: { start: string | null; end: string | null }
  reminderMinutes: number | null
  occurredAt: string
  incidentId: string | null
  incidentUpdateId: string | null
  maintenanceId: string | null
  occurrenceId: string | null
}

const relId = (value: unknown): string | null => {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (value && typeof value === 'object' && 'id' in value)
    return String((value as { id: unknown }).id)
  return null
}

/** Public names of the page's components, by component id. */
export async function componentNames(
  payload: Payload,
  page: Pick<StatusPage, 'groups'>,
): Promise<Map<string, string>> {
  const monitorIds = new Set<string>()
  for (const group of page.groups ?? []) {
    for (const row of group.monitors ?? []) {
      const id = row.type === 'static' ? null : relId(row.monitor)
      if (id) monitorIds.add(id)
    }
  }
  const monitors = new Map<string, Pick<Monitor, 'name' | 'publicName'>>()
  if (monitorIds.size > 0) {
    const { docs } = await payload.find({
      collection: 'monitors',
      where: { id: { in: [...monitorIds] } },
      depth: 0,
      limit: monitorIds.size,
      pagination: false,
      overrideAccess: true,
      select: { name: true, publicName: true },
    })
    for (const doc of docs) monitors.set(String(doc.id), doc)
  }
  const names = new Map<string, string>()
  for (const group of page.groups ?? []) {
    for (const row of group.monitors ?? []) {
      if (!row.id) continue
      const monitorId = row.type === 'static' ? null : relId(row.monitor)
      const monitor = monitorId ? monitors.get(monitorId) : null
      names.set(String(row.id), componentDisplayName(row.name, monitor) || group.name)
    }
  }
  return names
}

export function toAnnouncement(
  notification: SubscriberNotification,
  page: Pick<StatusPage, 'title' | 'slug' | 'domains'>,
  names: ReadonlyMap<string, string>,
): Announcement {
  return {
    id: String(notification.id),
    event: notification.event,
    siteName: page.title,
    title: notification.title,
    status: notification.status ?? null,
    message: notification.message ?? '',
    url: notification.eventPublicId
      ? statusPageEventUrl(
          page.slug,
          isIncidentEvent(notification.event) ? 'incident' : 'maintenance',
          notification.eventPublicId,
        )
      : publicPageUrl(page),
    pageUrl: publicPageUrl(page),
    components: (notification.components ?? []).flatMap((id) => {
      const name = names.get(String(id))
      return name ? [{ id: String(id), name }] : []
    }),
    window: { start: notification.window?.start ?? null, end: notification.window?.end ?? null },
    reminderMinutes: notification.window?.reminderMinutes ?? null,
    occurredAt: notification.occurredAt,
    incidentId: relId(notification.incident),
    incidentUpdateId: notification.incidentUpdateId ?? null,
    maintenanceId: relId(notification.maintenance),
    occurrenceId: relId(notification.occurrence),
  }
}

// ---------------------------------------------------------------------------------------------
// Shared text

export interface RenderContext {
  locale: Locale
  i18n: OrganizationI18n
}

const isOccurrenceState = (value: unknown): value is OccurrenceState =>
  typeof value === 'string' && (OCCURRENCE_STATES as readonly string[]).includes(value)

/** Localised status label: incident status or maintenance occurrence state. */
export function statusLabel(announcement: Announcement, locale: Locale): string {
  const t = serverTranslator(locale)
  const { status } = announcement
  if (isIncidentEvent(announcement.event)) {
    return isIncidentStatus(status) ? t(`statusPages.public.incidents.status.${status}`) : ''
  }
  return isOccurrenceState(status) ? t(`statusPages.public.maintenance.state.${status}`) : ''
}

export const headline = (announcement: Announcement, locale: Locale): string =>
  serverTranslator(locale)(`email.subscriptions.headline.${announcement.event}`)

/** `Oct 6, 2026, 10:00 AM GMT+2 – 12:00 PM GMT+2`, or just the start. */
export function windowText(announcement: Announcement, ctx: RenderContext): string | null {
  const { start, end } = announcement.window
  if (!start) return null
  const format = organizationFormatter({ ...ctx.i18n, locale: ctx.locale })
  return end
    ? format.dateTimeRange(new Date(start), new Date(end), 'zoned')
    : format.dateTime(new Date(start), 'zoned')
}

/** Plain-text body lines shared by email (text part), Slack and Discord. */
export function bodyLines(announcement: Announcement, ctx: RenderContext): string[] {
  const t = serverTranslator(ctx.locale)
  const lines: string[] = []
  const status = statusLabel(announcement, ctx.locale)
  if (status) lines.push(t('email.subscriptions.status', { status }))
  if (announcement.components.length > 0) {
    lines.push(
      t('email.subscriptions.affected', {
        components: announcement.components.map((c) => c.name).join(', '),
      }),
    )
  }
  const period = windowText(announcement, ctx)
  if (period) {
    lines.push(
      announcement.window.end
        ? t('email.subscriptions.window', { period })
        : t('email.subscriptions.starts', { start: period }),
    )
  }
  return lines
}

// ---------------------------------------------------------------------------------------------
// SMS

export interface SmsSettings {
  templates?: Partial<Record<string, string | null>> | null
  maxSegments?: number | null
}

export function renderSms(
  announcement: Announcement,
  ctx: RenderContext,
  settings: SmsSettings = {},
): string {
  const key = smsTemplateKeyFor(announcement.event)
  const values = {
    siteName: announcement.siteName,
    title: announcement.title,
    status: statusLabel(announcement, ctx.locale) || headline(announcement, ctx.locale),
    message: markdownToText(announcement.message, 1_000),
    url: announcement.url,
    start: windowText(announcement, ctx) ?? '',
  }
  const custom = settings.templates?.[key]?.trim()
  const raw = custom
    ? renderSmsTemplate(custom, values)
    : serverTranslator(ctx.locale)(`subscriberMessages.sms.${key}`, values)
  const text = raw
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,])/g, '$1')
    .trim()
  return truncateSms(text, settings.maxSegments ?? DEFAULT_SMS_MAX_SEGMENTS, announcement.url)
}

// ---------------------------------------------------------------------------------------------
// Webhooks

export const WEBHOOK_PAYLOAD_VERSION = '1'

export interface WebhookBody {
  version: typeof WEBHOOK_PAYLOAD_VERSION
  type: 'incident' | 'maintenance' | 'test'
  event: NotificationEvent | 'subscription_created'
  id: string | null
  created_at: string
  page: { name: string; url: string }
  /** Permalink of the incident or maintenance window (the page for `test`). */
  url: string
  data: Record<string, unknown>
  subscription: { manage_url: string; unsubscribe_url: string }
}

/** The versioned JSON every webhook subscriber receives (documented in docs/Status-Pages.md). */
export function webhookBody(announcement: Announcement, links: SubscriptionLinks): WebhookBody {
  const components = announcement.components.map((c) => ({ id: c.id, name: c.name }))
  const incident = isIncidentEvent(announcement.event)
  const data: Record<string, unknown> = incident
    ? {
        incident: {
          id: announcement.incidentId,
          title: announcement.title,
          status: announcement.status,
          components,
          update: {
            id: announcement.incidentUpdateId,
            status: announcement.status,
            message: announcement.message,
            posted_at: announcement.occurredAt,
          },
        },
      }
    : {
        maintenance: {
          id: announcement.maintenanceId,
          occurrence_id: announcement.occurrenceId,
          title: announcement.title,
          state: announcement.status,
          message: announcement.message,
          starts_at: announcement.window.start,
          ends_at: announcement.window.end,
          reminder_minutes: announcement.reminderMinutes,
          components,
        },
      }
  return {
    version: WEBHOOK_PAYLOAD_VERSION,
    type: incident ? 'incident' : 'maintenance',
    event: announcement.event,
    id: announcement.id,
    created_at: announcement.occurredAt,
    page: { name: announcement.siteName, url: announcement.pageUrl },
    url: announcement.url,
    data,
    subscription: { manage_url: links.manageUrl, unsubscribe_url: links.unsubscribeUrl },
  }
}

/** First message of a webhook or Slack subscription: proves the URL works and carries the links. */
export function welcomeWebhookBody(
  page: Pick<StatusPage, 'title' | 'slug' | 'domains'>,
  links: SubscriptionLinks,
  locale: Locale,
  signingSecret?: string | null,
): WebhookBody {
  const t = serverTranslator(locale)
  return {
    version: WEBHOOK_PAYLOAD_VERSION,
    type: 'test',
    event: 'subscription_created',
    id: null,
    created_at: new Date().toISOString(),
    page: { name: page.title, url: publicPageUrl(page) },
    url: publicPageUrl(page),
    data: {
      message: t('subscriberMessages.chat.welcome', { siteName: page.title }),
      ...(signingSecret ? { signing_secret: signingSecret } : {}),
    },
    subscription: { manage_url: links.manageUrl, unsubscribe_url: links.unsubscribeUrl },
  }
}

// ---------------------------------------------------------------------------------------------
// Slack and Discord

const slackEscape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const slackLink = (url: string, label: string) => `<${url}|${slackEscape(label)}>`

/** Slack incoming-webhook message (Block Kit with a plain-text fallback). */
export function slackMessage(
  announcement: Announcement | null,
  links: SubscriptionLinks,
  ctx: RenderContext,
  page: { title: string; url: string },
): Record<string, unknown> {
  const t = serverTranslator(ctx.locale)
  const heading = announcement
    ? `[${announcement.siteName}] ${headline(announcement, ctx.locale)}: ${announcement.title}`
    : t('subscriberMessages.chat.welcomeTitle', { siteName: page.title })
  const body = announcement
    ? [...bodyLines(announcement, ctx), markdownToText(announcement.message, 2_500)]
        .filter(Boolean)
        .join('\n')
    : t('subscriberMessages.chat.welcome', { siteName: page.title })
  const footer = [
    slackLink(announcement?.url ?? page.url, t('subscriberMessages.chat.viewPage')),
    slackLink(links.manageUrl, t('subscriberMessages.chat.manage')),
    slackLink(links.unsubscribeUrl, t('subscriberMessages.chat.unsubscribe')),
  ].join(' · ')
  return {
    text: heading,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: heading.slice(0, 150), emoji: true } },
      ...(body ? [{ type: 'section', text: { type: 'mrkdwn', text: slackEscape(body) } }] : []),
      { type: 'context', elements: [{ type: 'mrkdwn', text: footer }] },
    ],
  }
}

const DISCORD_COLORS: Record<string, number> = {
  incident: 0xc2290a,
  resolved: 0x66c20a,
  maintenance: 0x1747f5,
}

/** Discord webhook message with one embed. */
export function discordMessage(
  announcement: Announcement | null,
  links: SubscriptionLinks,
  ctx: RenderContext,
  page: { title: string; url: string },
): Record<string, unknown> {
  const t = serverTranslator(ctx.locale)
  const title = announcement
    ? `${headline(announcement, ctx.locale)}: ${announcement.title}`
    : t('subscriberMessages.chat.welcomeTitle', { siteName: page.title })
  const description = announcement
    ? [...bodyLines(announcement, ctx), markdownToText(announcement.message, 3_000)]
        .filter(Boolean)
        .join('\n')
    : t('subscriberMessages.chat.welcome', { siteName: page.title })
  const links_ = `[${t('subscriberMessages.chat.manage')}](${links.manageUrl}) · [${t('subscriberMessages.chat.unsubscribe')}](${links.unsubscribeUrl})`
  const color = !announcement
    ? DISCORD_COLORS.maintenance
    : announcement.event === 'incident_resolved'
      ? DISCORD_COLORS.resolved
      : isIncidentEvent(announcement.event)
        ? DISCORD_COLORS.incident
        : DISCORD_COLORS.maintenance
  return {
    username: page.title.slice(0, 80),
    embeds: [
      {
        title: title.slice(0, 256),
        url: announcement?.url ?? page.url,
        description: `${description}\n\n${links_}`.slice(0, 4_000),
        color,
        timestamp: announcement?.occurredAt ?? new Date().toISOString(),
      },
    ],
  }
}
