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
import { formatHeartbeatTime, renderMessageTemplate } from '@/server/notifications/message'
import {
  SERVER_SMTP_MAX_RECIPIENTS,
  SERVER_SMTP_OFF_MESSAGE,
  serverSmtpPolicy,
} from '@/server/notifications/server-smtp'
import { OK_MESSAGE } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

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
  },
  body: {
    label: 'Body template',
    multiline: true,
    description: 'Defaults to the message and time.',
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

registerNotificationProvider({
  name: 'smtp',
  label: 'Email (SMTP)',
  group: 'email',
  configSchema: smtpConfigSchema,
  fieldMeta: smtpFieldMeta,
  async send({ config: raw, message, monitor, heartbeat }) {
    const config = smtpConfigSchema.parse(raw)
    const transport = createTransport(buildSmtpTransportOptions(config))

    let subject = message
    let body = heartbeat ? `${message}\nTime: ${formatHeartbeatTime(heartbeat)}` : message
    let useHtml = false

    const customSubject = config.subject?.trim() ?? ''
    const customBody = config.body?.trim() ?? ''
    if (customSubject) subject = renderMessageTemplate(customSubject, message, monitor, heartbeat)
    if (customBody) {
      useHtml = config.htmlBody
      body = renderMessageTemplate(customBody, message, monitor, heartbeat)
    }

    const from = config.from?.trim() || (config.useServerSmtp ? env.EMAIL_FROM : undefined)
    if (!from) throw new Error('A From address is required')

    await transport.sendMail({
      from,
      to: config.to,
      cc: config.cc || undefined,
      bcc: config.bcc || undefined,
      subject,
      [useHtml ? 'html' : 'text']: body,
    })
    return OK_MESSAGE
  },
})
