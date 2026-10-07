/**
 * Notification emails (#150) for the email providers (SMTP, SendGrid, Resend): a subject, an HTML
 * part and a plain-text part.
 *
 * Without a custom HTML template the email is Marmot's branded, responsive layout: the
 * organization logo (or name), the status in its colour, the monitor, the message and a
 * "View monitor" button. A custom HTML template is rendered with Liquid in HTML mode (every value
 * escaped); the text part is derived from the HTML. A template that fails at send time is logged
 * and the default email goes out instead.
 */
import { defaultLocale } from '@/i18n/locales'
import { childLogger } from '@/lib/logger'
import { escapeHtml } from '@/lib/markdown'
import type {
  NotificationEmail,
  NotificationSendContext,
} from '@/server/notification-providers/types'
import { serverTranslator } from '@/server/i18n'
import { TemplateError } from './liquid'
import {
  buildTemplateContext,
  channelEventLabel,
  formatDowntime,
  formatHeartbeatTime,
  renderMessageTemplate,
  renderTemplate,
  statusLabel,
} from './message'

const log = childLogger('notifications:email')

export interface EmailTemplates {
  /** Liquid subject template; `defaultSubject` when blank. */
  subject?: string | null
  /** Liquid HTML template; the branded email when blank. */
  html?: string | null
  /** Liquid plain-text body: when set (and no `html`), the email is plain text only. */
  text?: string | null
}

type Tone = 'down' | 'up' | 'degraded' | 'maintenance' | 'warning' | 'neutral'

const TONE_COLOURS: Record<Tone, string> = {
  down: '#dc2626',
  up: '#16a34a',
  degraded: '#d97706',
  maintenance: '#2563eb',
  warning: '#d97706',
  neutral: '#6b7280',
}

function toneOf(ctx: NotificationSendContext): Tone {
  switch (ctx.event) {
    case 'down':
    case 'reminder':
      return 'down'
    case 'up':
      return 'up'
    case 'degraded':
      return ctx.heartbeat?.status === 'up' ? 'up' : 'degraded'
    case 'maintenance':
      return 'maintenance'
    case 'certificate':
      return 'warning'
    default:
      break
  }
  switch (ctx.heartbeat?.status) {
    case 'down':
      return 'down'
    case 'up':
      return 'up'
    case 'degraded':
    case 'pending':
      return 'degraded'
    case 'maintenance':
      return 'maintenance'
    default:
      return 'neutral'
  }
}

/** The pill text: the heartbeat status, else the event, else `⚠️ Test`. */
function badgeLabel(ctx: NotificationSendContext): string {
  const locale = ctx.locale ?? defaultLocale
  if (ctx.heartbeat) return statusLabel(ctx.heartbeat.status, locale)
  if (ctx.event === 'maintenance') return statusLabel('maintenance', locale)
  if (ctx.event) return channelEventLabel(ctx.event, locale)
  return statusLabel(null, locale)
}

const nl2br = (text: string) => escapeHtml(text).replace(/\r?\n/g, '<br/>')

/** Rows under the message: time, downtime of a recovery, address. */
function detailRows(ctx: NotificationSendContext): [string, string][] {
  const locale = ctx.locale ?? defaultLocale
  const t = serverTranslator(locale)
  const context = buildTemplateContext(ctx.message, ctx.monitor, ctx.heartbeat, locale, ctx)
  const rows: [string, string][] = []
  const time = formatHeartbeatTime(ctx.heartbeat)
  if (time) rows.push([t('notifications.email.time'), time])
  if (ctx.event === 'up' && ctx.downtimeSeconds != null && ctx.downtimeSeconds > 0) {
    rows.push([t('notifications.email.downtime'), formatDowntime(ctx.downtimeSeconds, locale)])
  }
  if (ctx.monitor && context.hostnameOrURL) {
    rows.push([t('notifications.email.address'), context.hostnameOrURL])
  }
  return rows
}

/** Marmot's branded notification email (HTML). */
export function renderDefaultEmailHtml(ctx: NotificationSendContext): string {
  const locale = ctx.locale ?? defaultLocale
  const t = serverTranslator(locale)
  const context = buildTemplateContext(ctx.message, ctx.monitor, ctx.heartbeat, locale, ctx)
  const colour = TONE_COLOURS[toneOf(ctx)]
  const org = ctx.organization
  const brand = org?.logoUrl
    ? `<img src="${escapeHtml(org.logoUrl)}" alt="${escapeHtml(org.name)}" height="32" style="display:block;height:32px;max-width:200px;border:0"/>`
    : `<span style="font-size:16px;font-weight:700;color:#1c1a18">${escapeHtml(org?.name || 'Marmot')}</span>`
  const title = ctx.monitor
    ? `<h1 style="margin:12px 0 8px;font-size:20px;line-height:1.3;color:#1c1a18">${escapeHtml(ctx.monitor.name)}</h1>`
    : ''
  const rows = detailRows(ctx)
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#6b6760;white-space:nowrap;vertical-align:top">${escapeHtml(label)}</td><td style="padding:4px 0;word-break:break-word">${escapeHtml(value)}</td></tr>`,
    )
    .join('')
  const details = rows
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0 0;font-size:14px;border-collapse:collapse">${rows}</table>`
    : ''
  const link = context.monitor?.dashboardUrl
  const button = link
    ? `<p style="margin:24px 0 0"><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#1c1a18;color:#ffffff;text-decoration:none;font-weight:600">${escapeHtml(t('notifications.email.viewMonitor'))}</a></p>`
    : ''
  const footer = org?.name
    ? t('notifications.email.footer', { organization: org.name })
    : t('notifications.email.footerNoOrg')
  return [
    `<!doctype html><html lang="${escapeHtml(locale)}"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="color-scheme" content="light"/><title>${escapeHtml(ctx.monitor?.name ?? ctx.message)}</title></head>`,
    `<body style="margin:0;padding:0;background:#f7f5f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c1a18">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f5f1"><tr><td align="center" style="padding:24px 12px">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">`,
    `<tr><td style="padding:0 4px 12px">${brand}</td></tr>`,
    `<tr><td style="background:#ffffff;border-radius:12px;border-top:4px solid ${colour};padding:24px 28px;font-size:15px;line-height:1.5">`,
    `<span style="display:inline-block;padding:2px 10px;border-radius:999px;background:${colour};color:#ffffff;font-size:13px;font-weight:600">${escapeHtml(badgeLabel(ctx))}</span>`,
    title,
    `<p style="margin:8px 0 0">${nl2br(ctx.message)}</p>`,
    details,
    button,
    `</td></tr>`,
    `<tr><td style="padding:12px 4px 0;font-size:12px;line-height:1.5;color:#6b6760">${escapeHtml(footer)}</td></tr>`,
    `</table></td></tr></table></body></html>`,
  ].join('')
}

/** Plain-text part of the branded email: the message, then the detail rows and the link. */
export function renderDefaultEmailText(ctx: NotificationSendContext): string {
  const locale = ctx.locale ?? defaultLocale
  const t = serverTranslator(locale)
  const context = buildTemplateContext(ctx.message, ctx.monitor, ctx.heartbeat, locale, ctx)
  const lines = [ctx.message, ...detailRows(ctx).map(([label, value]) => `${label}: ${value}`)]
  const link = context.monitor?.dashboardUrl
  if (link) lines.push('', t('notifications.email.viewMonitorLink', { url: link }))
  return lines.join('\n')
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match
    }
    return ENTITIES[entity.toLowerCase()] ?? match
  })
}

/**
 * Plain-text alternative of an HTML email: block elements become line breaks, links keep their
 * address (`View monitor (https://…)`), everything else is stripped and entities decoded.
 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(
      /<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_m, _q, dq: string | undefined, sq: string | undefined, label: string) => {
        const href = decodeEntities(dq ?? sq ?? '').trim()
        const inner = label.replace(/<[^>]*>/g, '').trim()
        if (!href || href.startsWith('#') || decodeEntities(inner) === href) return inner
        return inner ? `${inner} (${href})` : href
      },
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(
      /<\/?(p|div|h[1-6]|ul|ol|table|tr|blockquote|pre|section|header|footer)\b[^>]*>/gi,
      '\n',
    )
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
  text = decodeEntities(text)
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * The template settings of an email channel's raw config (`subject`, `body`, `htmlBody`,
 * `htmlTemplate`), without validating the rest, for previews of half-filled forms.
 */
export function emailTemplateConfig(config: Record<string, unknown>): {
  subject?: string
  body?: string
  htmlBody: boolean
  htmlTemplate?: string
} {
  const text = (key: string) =>
    typeof config[key] === 'string' ? (config[key] as string) : undefined
  return {
    subject: text('subject'),
    body: text('body'),
    htmlBody: config.htmlBody === true,
    htmlTemplate: text('htmlTemplate'),
  }
}

/** Subjects are a single line. */
const oneLine = (text: string) => text.replace(/[\r\n]+/g, ' ').trim()

/**
 * The email an email provider sends for `ctx`: the custom templates of the channel where set,
 * otherwise Marmot's defaults. Never throws for a bad template (see `renderMessageTemplate`).
 */
export function buildNotificationEmail(
  ctx: NotificationSendContext,
  templates: EmailTemplates,
  defaultSubject: string,
): NotificationEmail {
  const locale = ctx.locale ?? defaultLocale
  const { message, monitor, heartbeat } = ctx
  const subjectTemplate = templates.subject?.trim()
  const subject = oneLine(
    subjectTemplate
      ? renderMessageTemplate(subjectTemplate, message, monitor, heartbeat, locale, ctx)
      : defaultSubject,
  )

  const htmlTemplate = templates.html?.trim()
  if (htmlTemplate) {
    try {
      const html = renderTemplate(
        htmlTemplate,
        buildTemplateContext(message, monitor, heartbeat, locale, ctx),
        { mode: 'html', locale, timeZone: ctx.timeZone },
      )
      return { subject, html, text: htmlToText(html) }
    } catch (error) {
      if (!(error instanceof TemplateError)) throw error
      log.warn(
        { err: error, code: error.code, monitorId: monitor?.id, event: ctx.event },
        'email template failed; sending the default email',
      )
    }
  } else {
    const textTemplate = templates.text?.trim()
    if (textTemplate) {
      return {
        subject,
        html: null,
        text: renderMessageTemplate(textTemplate, message, monitor, heartbeat, locale, ctx),
      }
    }
  }
  return { subject, html: renderDefaultEmailHtml(ctx), text: renderDefaultEmailText(ctx) }
}
