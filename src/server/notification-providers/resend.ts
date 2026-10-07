/**
 * Resend mail provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/resend.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { buildNotificationEmail, emailTemplateConfig } from '@/server/notifications/email'
import { providerText } from '@/server/notifications/message'
import { OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationEmail, NotificationFieldMeta, NotificationSendContext } from './types'

export const RESEND_API_URL = 'https://api.resend.com/emails'

export const resendConfigSchema = z.object({
  apiKey: z.string().min(1),
  fromEmail: z.string().min(1),
  fromName: z.string().optional(),
  toEmail: z.string().min(1),
  subject: z.string().optional(),
  htmlTemplate: z.string().optional(),
})

export type ResendConfig = z.infer<typeof resendConfigSchema>

export const resendFieldMeta: Record<keyof ResendConfig, NotificationFieldMeta> = {
  apiKey: { label: 'API key', secret: true, placeholder: 're_…' },
  fromEmail: { label: 'From email', placeholder: 'alerts@example.com' },
  fromName: { label: 'From name', placeholder: 'Marmot' },
  toEmail: { label: 'To email', placeholder: 'ops@example.com' },
  subject: { label: 'Subject', placeholder: 'Notification from Marmot', template: 'text' },
  htmlTemplate: {
    label: 'HTML template',
    multiline: true,
    description:
      'Liquid template for the HTML part; values are HTML-escaped and the text part is generated. Defaults to a branded email.',
    template: 'html',
  },
}

/** Subject and HTML templates when set; the branded email with Kuma's default subject otherwise. */
export function renderResendEmail(
  config: Pick<ResendConfig, 'subject' | 'htmlTemplate'>,
  ctx: NotificationSendContext,
): NotificationEmail {
  return buildNotificationEmail(
    ctx,
    { subject: config.subject, html: config.htmlTemplate },
    providerText(ctx.locale)('fromMarmot'),
  )
}

registerNotificationProvider({
  name: 'resend',
  label: 'Resend',
  group: 'email',
  docsUrl: 'https://resend.com/docs/api-reference/emails/send-email',
  configSchema: resendConfigSchema,
  fieldMeta: resendFieldMeta,
  // Lenient: the form previews templates before the rest of the settings are filled in.
  renderEmail: (ctx) => renderResendEmail(emailTemplateConfig(ctx.config), ctx),
  async send(ctx) {
    const config = resendConfigSchema.parse(ctx.config)
    const email = renderResendEmail(config, ctx)
    const fromName = config.fromName?.trim() || 'Marmot'
    await postJson(
      RESEND_API_URL,
      {
        from: `${fromName} <${config.fromEmail.trim()}>`,
        to: config.toEmail,
        subject: email.subject,
        text: email.text,
        ...(email.html !== null ? { html: email.html } : {}),
      },
      { Authorization: `Bearer ${config.apiKey}` },
    )
    return OK_MESSAGE
  },
})
