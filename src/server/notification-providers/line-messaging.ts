/**
 * LINE Messaging API provider (push message to a user, group or room).
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/line.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { formatHeartbeatTime, statusLabel } from '@/server/notifications/message'
import { OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push'

export const lineMessagingConfigSchema = z.object({
  channelAccessToken: z.string().min(1),
  userId: z.string().min(1),
})

export type LineMessagingConfig = z.infer<typeof lineMessagingConfigSchema>

export const lineMessagingFieldMeta: Record<keyof LineMessagingConfig, NotificationFieldMeta> = {
  channelAccessToken: {
    label: 'Channel access token',
    secret: true,
    description: 'LINE Developers console → Messaging API → Channel access token (long-lived).',
  },
  userId: {
    label: 'User / group ID',
    placeholder: 'U…',
    description: 'Recipient user, group or room id (not the display name).',
  },
}

registerNotificationProvider({
  name: 'line-messaging',
  label: 'LINE Messaging API',
  group: 'chat',
  docsUrl: 'https://developers.line.biz/en/reference/messaging-api/#send-push-message',
  configSchema: lineMessagingConfigSchema,
  fieldMeta: lineMessagingFieldMeta,
  async send({ config: raw, message, monitor, heartbeat }) {
    const config = lineMessagingConfigSchema.parse(raw)
    const headers = { Authorization: `Bearer ${config.channelAccessToken}` }

    let text = message
    if (heartbeat && monitor) {
      text = `Marmot Alert: [${statusLabel(heartbeat.status)}]\nName: ${monitor.name} \n${heartbeat.msg ?? ''}\nTime: ${formatHeartbeatTime(heartbeat)}`
    }

    await postJson(
      LINE_PUSH_URL,
      { to: config.userId, messages: [{ type: 'text', text }] },
      headers,
    )
    return OK_MESSAGE
  },
})
