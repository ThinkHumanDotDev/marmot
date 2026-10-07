/**
 * Template previews for the channel form (#150): render a channel's (unsaved) templates and, for
 * email providers, the whole email against sample data of one event. Nothing is sent.
 */
import { defaultLocale, type Locale } from '@/i18n/locales'
import type { ChannelEvent } from '@/lib/notification-events'
import type { Heartbeat, Monitor } from '@/payload-types'
import { serverTranslator } from '@/server/i18n'
import { certExpiryMessage } from '@/server/jobs/cert-expiry'
import { getNotificationProvider } from '@/server/notification-providers'
import type {
  NotificationEmail,
  NotificationSendContext,
} from '@/server/notification-providers/types'
import { TemplateError, validateTemplate, type TemplateMode } from './liquid'
import { buildMaintenanceMessage } from './maintenance'
import { buildDefaultMessage, buildTemplateContext, renderTemplate } from './message'
import { templateErrorText, type ChannelOrganization } from './send'

export interface TemplatePreviewField {
  /** Config key of the template. */
  name: string
  mode: TemplateMode
  /** Rendered text, or null when the template has an error. */
  output: string | null
  /** Why the template cannot be used (sends then fall back to the default message). */
  error: string | null
}

export interface NotificationPreview {
  event: ChannelEvent
  /** The default message of the sample (what is sent without templates). */
  message: string
  fields: TemplatePreviewField[]
  /** The email an email provider would send, or null for other providers. */
  email: NotificationEmail | null
}

/** Sample downtime of a recovery: 7 minutes 3 seconds. */
const SAMPLE_DOWNTIME_SECONDS = 423

/**
 * Send context of a realistic sample of `event` in `locale`: a monitor named "Example API" that
 * went down, recovered, got slow, kept failing, has an expiring certificate or entered maintenance.
 */
export function sampleSendContext(
  event: ChannelEvent,
  org: ChannelOrganization,
  config: Record<string, unknown> = {},
  now: Date = new Date(),
): NotificationSendContext {
  const locale: Locale = org.locale ?? defaultLocale
  const t = serverTranslator(locale)
  const monitor = {
    id: 'example',
    name: t('notifications.preview.sample.monitorName'),
    type: 'http',
    url: 'https://api.example.com/health',
    hostname: null,
    port: null,
    description: null,
  } as unknown as Monitor
  const beat = (status: Heartbeat['status'], msg: string, ping: number | null) =>
    ({
      id: 'example',
      monitor: monitor.id,
      status,
      msg,
      ping,
      duration: 60,
      retries: 0,
      downCount: event === 'reminder' ? 3 : status === 'down' ? 1 : 0,
      important: true,
      time: now.toISOString(),
    }) as unknown as Heartbeat

  const base = {
    config,
    locale,
    event,
    organization: org.organization,
    timeZone: org.timeZone,
  }
  switch (event) {
    case 'certificate':
      return {
        ...base,
        monitor,
        heartbeat: null,
        message: certExpiryMessage(
          monitor,
          { certType: 'server', subjectCN: 'api.example.com', daysRemaining: 7 },
          locale,
        ),
      }
    case 'maintenance':
      return {
        ...base,
        monitor: null,
        heartbeat: null,
        message: buildMaintenanceMessage(
          'started',
          t('notifications.preview.sample.maintenanceTitle'),
          [monitor.name],
          locale,
        ),
      }
    default: {
      const heartbeat =
        event === 'up'
          ? beat('up', t('notifications.preview.sample.upMessage'), 123)
          : event === 'degraded'
            ? beat('degraded', t('notifications.preview.sample.degradedMessage'), 2400)
            : beat('down', t('notifications.preview.sample.downMessage'), null)
      const downtimeSeconds = event === 'up' ? SAMPLE_DOWNTIME_SECONDS : null
      return {
        ...base,
        monitor,
        heartbeat,
        downtimeSeconds,
        message: buildDefaultMessage(monitor, heartbeat, locale, { event, downtimeSeconds }),
      }
    }
  }
}

/**
 * Preview a channel of `type` with the (possibly unsaved, possibly incomplete) `config` for a
 * sample of `event`. Every non-empty template field is checked like on save and rendered; email
 * providers also render the full email (subject, HTML and text parts).
 */
export function previewNotification(
  type: string,
  config: Record<string, unknown>,
  event: ChannelEvent,
  org: ChannelOrganization,
): NotificationPreview {
  const provider = getNotificationProvider(type)
  const ctx = sampleSendContext(event, org, config)
  const locale = ctx.locale ?? defaultLocale
  const context = buildTemplateContext(ctx.message, ctx.monitor, ctx.heartbeat, locale, ctx)
  const fields: TemplatePreviewField[] = []
  for (const [name, meta] of Object.entries(provider?.fieldMeta ?? {})) {
    if (!meta.template) continue
    const value = config[name]
    if (typeof value !== 'string' || !value.trim()) continue
    const mode: TemplateMode =
      meta.template === 'html' || (meta.templateHtmlWhen && config[meta.templateHtmlWhen] === true)
        ? 'html'
        : 'text'
    try {
      validateTemplate(value.trim())
      const output = renderTemplate(value.trim(), context, { mode, locale, timeZone: ctx.timeZone })
      fields.push({ name, mode, output, error: null })
    } catch (error) {
      if (!(error instanceof TemplateError)) throw error
      fields.push({ name, mode, output: null, error: templateErrorText(error, locale) })
    }
  }
  return {
    event,
    message: ctx.message,
    fields,
    email: provider?.renderEmail ? provider.renderEmail(ctx) : null,
  }
}
