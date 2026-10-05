/**
 * Signal provider (via a signal-cli REST API instance).
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/signal.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { renderMessageTemplate } from '@/server/notifications/message'
import { OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const signalConfigSchema = z.object({
  apiUrl: z.string().url(),
  number: z.string().min(1),
  recipients: z.string().min(1),
  useTemplate: z.boolean().default(false),
  template: z.string().optional(),
})

export type SignalConfig = z.infer<typeof signalConfigSchema>

export const signalFieldMeta: Record<keyof SignalConfig, NotificationFieldMeta> = {
  apiUrl: {
    label: 'signal-cli REST API URL',
    placeholder: 'http://signal-cli:8080/v2/send',
    description: 'Full send endpoint of a signal-cli-rest-api instance.',
  },
  number: { label: 'Sender number', placeholder: '+4912345678' },
  recipients: {
    label: 'Recipients',
    placeholder: '+4912345679, group.abc…',
    description: 'Comma-separated numbers or group ids.',
  },
  useTemplate: { label: 'Use a custom message template' },
  template: { label: 'Message template', multiline: true },
}

registerNotificationProvider({
  name: 'signal',
  label: 'Signal',
  group: 'chat',
  docsUrl: 'https://github.com/bbernhard/signal-cli-rest-api',
  configSchema: signalConfigSchema,
  fieldMeta: signalFieldMeta,
  async send({ config: raw, message, monitor, heartbeat }) {
    const config = signalConfigSchema.parse(raw)
    const text =
      config.useTemplate && config.template?.trim()
        ? renderMessageTemplate(config.template.trim(), message, monitor, heartbeat)
        : message

    await postJson(config.apiUrl, {
      message: text,
      number: config.number,
      recipients: config.recipients.replace(/\s/g, '').split(',').filter(Boolean),
    })
    return OK_MESSAGE
  },
})
