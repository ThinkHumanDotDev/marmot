/**
 * Resend mail provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/resend.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { providerText } from '@/server/notifications/message'
import { OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const RESEND_API_URL = 'https://api.resend.com/emails'

export const resendConfigSchema = z.object({
  apiKey: z.string().min(1),
  fromEmail: z.string().min(1),
  fromName: z.string().optional(),
  toEmail: z.string().min(1),
  subject: z.string().optional(),
})

export type ResendConfig = z.infer<typeof resendConfigSchema>

export const resendFieldMeta: Record<keyof ResendConfig, NotificationFieldMeta> = {
  apiKey: { label: 'API key', secret: true, placeholder: 're_…' },
  fromEmail: { label: 'From email', placeholder: 'alerts@example.com' },
  fromName: { label: 'From name', placeholder: 'Marmot' },
  toEmail: { label: 'To email', placeholder: 'ops@example.com' },
  subject: { label: 'Subject', placeholder: 'Notification from Marmot' },
}

registerNotificationProvider({
  name: 'resend',
  label: 'Resend',
  group: 'email',
  docsUrl: 'https://resend.com/docs/api-reference/emails/send-email',
  configSchema: resendConfigSchema,
  fieldMeta: resendFieldMeta,
  async send({ config: raw, message, locale }) {
    const config = resendConfigSchema.parse(raw)
    const p = providerText(locale)
    const fromName = config.fromName?.trim() || 'Marmot'
    await postJson(
      RESEND_API_URL,
      {
        from: `${fromName} <${config.fromEmail.trim()}>`,
        to: config.toEmail,
        subject: config.subject || p('fromMarmot'),
        text: message,
      },
      { Authorization: `Bearer ${config.apiKey}` },
    )
    return OK_MESSAGE
  },
})
