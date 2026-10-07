/**
 * Email (SMTP) provider via nodemailer.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/smtp.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 *
 * `useServerSmtp` reuses the instance-wide SMTP settings (`SMTP_HOST` & co. in `src/env.ts`) so an
 * admin only has to enter recipients; otherwise the channel carries its own transport settings.
 * Who may use it, how often and for how many recipients is decided in
 * `src/server/notifications/server-smtp.ts` (`NOTIFICATIONS_SERVER_SMTP*`).
 */
import nodemailer, { type Transporter } from 'nodemailer'
import { z } from 'zod'

import { env } from '@/env'
import { buildNotificationEmail, emailTemplateConfig } from '@/server/notifications/email'
import {
  SERVER_SMTP_MAX_RECIPIENTS,
  SERVER_SMTP_OFF_MESSAGE,
  serverSmtpPolicy,
} from '@/server/notifications/server-smtp'
import { resolveGuardedTarget } from '@/server/security/outbound-guard'
import { OK_MESSAGE } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationEmail, NotificationFieldMeta, NotificationSendContext } from './types'

export const smtpConfigSchema = z.object({
  useServerSmtp: z.boolean().default(false),
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  ignoreTlsErrors: z.boolean().default(false),
  user: z.string().optional(),
  pass: z.string().optional(),
  from: z.string().optional(),
  to: z.string().min(1),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  htmlBody: z.boolean().default(false),
})

export type SmtpConfig = z.infer<typeof smtpConfigSchema>

export const smtpFieldMeta: Record<keyof SmtpConfig, NotificationFieldMeta> = {
  useServerSmtp: {
    label: 'Use the server SMTP settings',
    description: `Send through the SMTP_* configuration of this Marmot instance (at most ${SERVER_SMTP_MAX_RECIPIENTS} recipients per message).`,
  },
  host: { label: 'SMTP host', placeholder: 'smtp.example.com' },
  port: { label: 'Port' },
  secure: { label: 'Implicit TLS (SMTPS, port 465)' },
  ignoreTlsErrors: { label: 'Ignore TLS certificate errors' },
  user: { label: 'Username' },
  pass: { label: 'Password', secret: true },
  from: { label: 'From', placeholder: 'Marmot <alerts@example.com>' },
  to: { label: 'To', description: 'Comma-separated recipients.' },
  cc: { label: 'CC' },
  bcc: { label: 'BCC' },
  subject: {
    label: 'Subject template',
    placeholder: '{{ name }} is {{ status }}',
    description: 'Defaults to the notification message.',
    template: 'text',
  },
  body: {
    label: 'Body template',
    multiline: true,
    description:
      'Defaults to a branded HTML email with a plain-text part. With "Send the body as HTML", values are HTML-escaped and the text part is generated.',
    template: 'text',
    templateHtmlWhen: 'htmlBody',
  },
  htmlBody: { label: 'Send the body as HTML' },
}

/** Build the nodemailer transport for a channel (exported for tests). */
export function buildSmtpTransportOptions(config: SmtpConfig): Record<string, unknown> {
  if (config.useServerSmtp) {
    // `sendNotification` already refuses this; never fall back to the server transport regardless.
    if (serverSmtpPolicy() === 'off') throw new Error(SERVER_SMTP_OFF_MESSAGE)
    if (!env.SMTP_HOST) {
      throw new Error(
        'This Marmot instance has no SMTP_HOST configured; enter SMTP settings instead.',
      )
    }
    return {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    }
  }
  if (!config.host) throw new Error('SMTP host is required')
  const options: Record<string, unknown> = {
    host: config.host,
    port: config.port,
    secure: config.secure,
    tls: { rejectUnauthorized: !config.ignoreTlsErrors },
  }
  if (config.user || config.pass) options.auth = { user: config.user, pass: config.pass }
  return options
}

/** Overridable transport factory so tests can capture mails without a server. */
let createTransport: (options: Record<string, unknown>) => Transporter = (options) =>
  nodemailer.createTransport(options as Parameters<typeof nodemailer.createTransport>[0])

export function setSmtpTransportFactory(
  factory: ((options: Record<string, unknown>) => Transporter) | null,
): void {
  createTransport =
    factory ??
    ((options) =>
      nodemailer.createTransport(options as Parameters<typeof nodemailer.createTransport>[0]))
}

/**
 * The email for `ctx`: subject and body templates when set (the body as HTML with `htmlBody`, the
 * text part then generated), otherwise the branded HTML email with the message as subject.
 */
export function renderSmtpEmail(
  config: Pick<SmtpConfig, 'subject' | 'body' | 'htmlBody'>,
  ctx: NotificationSendContext,
): NotificationEmail {
  const body = config.body?.trim()
  return buildNotificationEmail(
    ctx,
    {
      subject: config.subject,
      ...(body ? (config.htmlBody ? { html: body } : { text: body }) : {}),
    },
    ctx.message,
  )
}

registerNotificationProvider({
  name: 'smtp',
  label: 'Email (SMTP)',
  group: 'email',
  configSchema: smtpConfigSchema,
  fieldMeta: smtpFieldMeta,
  // Lenient: the form previews templates before the rest of the settings are filled in.
  renderEmail: (ctx) => renderSmtpEmail(emailTemplateConfig(ctx.config), ctx),
  async send(ctx) {
    const config = smtpConfigSchema.parse(ctx.config)
    const options = buildSmtpTransportOptions(config)
    if (!config.useServerSmtp && typeof options.host === 'string') {
      // A channel's own SMTP host is user input: with the outbound address guard on, connect to the
      // vetted address and keep the name for TLS (the instance's SMTP_HOST is trusted config).
      const vetted = await resolveGuardedTarget(options.host)
      if (vetted && vetted.address !== options.host) {
        options.tls = { ...(options.tls as object), servername: options.host }
        options.servername = options.host
        options.host = vetted.address
      }
    }
    const transport = createTransport(options)

    const email = renderSmtpEmail(config, ctx)

    const from = config.from?.trim() || (config.useServerSmtp ? env.EMAIL_FROM : undefined)
    if (!from) throw new Error('A From address is required')

    await transport.sendMail({
      from,
      to: config.to,
      cc: config.cc || undefined,
      bcc: config.bcc || undefined,
      subject: email.subject,
      text: email.text,
      ...(email.html !== null ? { html: email.html } : {}),
    })
    return OK_MESSAGE
  },
})
