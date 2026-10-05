/**
 * Pushy provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/pushy.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const pushyConfigSchema = z.object({
  apiKey: z.string().min(1),
  deviceToken: z.string().min(1),
})

export type PushyConfig = z.infer<typeof pushyConfigSchema>

export const pushyFieldMeta: Record<keyof PushyConfig, NotificationFieldMeta> = {
  apiKey: { label: 'Secret API key', secret: true },
  deviceToken: { label: 'Device token', description: 'Target device token (or topic).' },
}

registerNotificationProvider({
  name: 'pushy',
  label: 'Pushy',
  group: 'push',
  docsUrl: 'https://pushy.me/docs/api/send-notifications',
  configSchema: pushyConfigSchema,
  fieldMeta: pushyFieldMeta,
  async send({ config: raw, message }) {
    const config = pushyConfigSchema.parse(raw)
    await postJson(`https://api.pushy.me/push?api_key=${encodeURIComponent(config.apiKey)}`, {
      to: config.deviceToken,
      data: { message: 'Marmot' },
      notification: { body: message, badge: 1, sound: 'ping.aiff' },
    })
    return OK_MESSAGE
  },
})
