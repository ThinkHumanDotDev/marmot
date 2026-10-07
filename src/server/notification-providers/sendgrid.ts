/**
 * SendGrid (Twilio) mail provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/send-grid.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { buildNotificationEmail, emailTemplateConfig } from '@/server/notifications/email'
import { providerText } from '@/server/notifications/message'
import { OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationEmail, NotificationFieldMeta, NotificationSendContext } from './types'

export const SENDGRID_API_URL = 'https://api.sendgrid.com/v3/mail/send'

export const sendgridConfigSchema = z.object({
  apiKey: z.string().min(1),
  fromEmail: z.string().min(1),
  toEmail: z.string().min(1),
  ccEmail: z.string().optional(),
  bccEmail: z.string().optional(),
  subject: z.string().optional(),
  htmlTemplate: z.string().optional(),
})

export type SendgridConfig = z.infer<typeof sendgridConfigSchema>

export const sendgridFieldMeta: Record<keyof SendgridConfig, NotificationFieldMeta> = {
  apiKey: { label: 'API key', secret: true },
  fromEmail: { label: 'From email', placeholder: 'alerts@example.com' },
  toEmail: { label: 'To email', placeholder: 'ops@example.com' },
  ccEmail: { label: 'CC', description: 'Comma-separated.' },
  bccEmail: { label: 'BCC', description: 'Comma-separated.' },
  subject: { label: 'Subject', placeholder: 'Notification from Marmot', template: 'text' },
  htmlTemplate: {
    label: 'HTML template',
    multiline: true,
    description:
      'Liquid template for the HTML part; values are HTML-escaped and the text part is generated. Defaults to a branded email.',
    template: 'html',
  },
}

const emailList = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean)
    .map((email) => ({ email }))

/** Subject and HTML templates when set; the branded email with Kuma's default subject otherwise. */
export function renderSendgridEmail(
  config: Pick<SendgridConfig, 'subject' | 'htmlTemplate'>,
  ctx: NotificationSendContext,
): NotificationEmail {
  return buildNotificationEmail(
    ctx,
    { subject: config.subject, html: config.htmlTemplate },
    providerText(ctx.locale)('fromMarmot'),
  )
}

registerNotificationProvider({
  name: 'sendgrid',
  label: 'SendGrid',
  group: 'email',
  docsUrl: 'https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send',
  configSchema: sendgridConfigSchema,
  fieldMeta: sendgridFieldMeta,
  // Lenient: the form previews templates before the rest of the settings are filled in.
  renderEmail: (ctx) => renderSendgridEmail(emailTemplateConfig(ctx.config), ctx),
  async send(ctx) {
    const config = sendgridConfigSchema.parse(ctx.config)
    const email = renderSendgridEmail(config, ctx)
    const personalization: Record<string, unknown> = { to: [{ email: config.toEmail.trim() }] }
    const cc = emailList(config.ccEmail)
    const bcc = emailList(config.bccEmail)
    if (cc.length) personalization.cc = cc
    if (bcc.length) personalization.bcc = bcc

    await postJson(
      SENDGRID_API_URL,
      {
        personalizations: [personalization],
        from: { email: config.fromEmail.trim() },
        subject: email.subject,
        // SendGrid requires text/plain first when both parts are sent.
        content: [
          { type: 'text/plain', value: email.text },
          ...(email.html !== null ? [{ type: 'text/html', value: email.html }] : []),
        ],
      },
      { Authorization: `Bearer ${config.apiKey}` },
    )
    return OK_MESSAGE
  },
})
