/**
 * Rocket.Chat incoming-webhook provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/rocket-chat.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { formatHeartbeatTime } from '@/server/notifications/message'
import { OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const rocketChatConfigSchema = z.object({
  webhookUrl: z.string().url(),
  channel: z.string().optional(),
  username: z.string().optional(),
  iconEmoji: z.string().optional(),
})

export type RocketChatConfig = z.infer<typeof rocketChatConfigSchema>

export const rocketChatFieldMeta: Record<keyof RocketChatConfig, NotificationFieldMeta> = {
  webhookUrl: {
    label: 'Webhook URL',
    placeholder: 'https://chat.example.com/hooks/…',
    secret: true,
  },
  channel: { label: 'Channel name', placeholder: '#alerts' },
  username: { label: 'Username', placeholder: 'Marmot' },
  iconEmoji: { label: 'Icon emoji', placeholder: ':bell:' },
}

registerNotificationProvider({
  name: 'rocket-chat',
  label: 'Rocket.Chat',
  group: 'chat',
  docsUrl: 'https://docs.rocket.chat/docs/integrations',
  configSchema: rocketChatConfigSchema,
  fieldMeta: rocketChatFieldMeta,
  async send({ config: raw, message, monitor, heartbeat }) {
    const config = rocketChatConfigSchema.parse(raw)
    const base = {
      channel: config.channel || undefined,
      username: config.username || undefined,
      icon_emoji: config.iconEmoji || undefined,
    }

    if (!heartbeat || !monitor) {
      await postJson(config.webhookUrl, { ...base, text: message })
      return OK_MESSAGE
    }

    await postJson(config.webhookUrl, {
      ...base,
      text: 'Marmot Alert',
      attachments: [
        {
          title: `Marmot Alert *Time*\n${formatHeartbeatTime(heartbeat)}`,
          text: `*Message*\n${message}`,
          color: heartbeat.status === 'down' ? '#ff0000' : '#32cd32',
          ...(monitor.url ? { title_link: monitor.url } : {}),
        },
      ],
    })
    return OK_MESSAGE
  },
})
