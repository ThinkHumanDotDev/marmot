/**
 * Mattermost incoming-webhook provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/mattermost.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { formatHeartbeatTime } from '@/server/notifications/message'
import { OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const mattermostConfigSchema = z.object({
  webhookUrl: z.string().url(),
  username: z.string().optional(),
  channel: z.string().optional(),
  iconUrl: z.string().optional(),
  iconEmoji: z.string().optional(),
})

export type MattermostConfig = z.infer<typeof mattermostConfigSchema>

export const mattermostFieldMeta: Record<keyof MattermostConfig, NotificationFieldMeta> = {
  webhookUrl: {
    label: 'Webhook URL',
    placeholder: 'https://mattermost.example.com/hooks/…',
    secret: true,
  },
  username: { label: 'Username', placeholder: 'Marmot' },
  channel: { label: 'Channel name', description: 'Overrides the webhook default channel.' },
  iconUrl: { label: 'Icon URL' },
  iconEmoji: {
    label: 'Icon emoji',
    placeholder: ':white_check_mark: :red_circle:',
    description: 'One emoji, or two separated by a space: the first for UP, the second for DOWN.',
  },
}

registerNotificationProvider({
  name: 'mattermost',
  label: 'Mattermost',
  group: 'chat',
  docsUrl: 'https://developers.mattermost.com/integrate/webhooks/incoming/',
  configSchema: mattermostConfigSchema,
  fieldMeta: mattermostFieldMeta,
  async send({ config: raw, message, monitor, heartbeat }) {
    const config = mattermostConfigSchema.parse(raw)
    const username = config.username || 'Marmot'

    if (!heartbeat || !monitor) {
      await postJson(config.webhookUrl, { username, text: message })
      return OK_MESSAGE
    }

    const emojis = (config.iconEmoji ?? '').split(' ').filter(Boolean)
    const [emojiUp, emojiDown] = emojis.length >= 2 ? emojis : [undefined, undefined]

    let iconEmoji = config.iconEmoji || undefined
    let statusField = { short: false, title: 'Error', value: heartbeat.msg ?? '' }
    let statusText = 'unknown'
    let color = '#000000'
    if (heartbeat.status === 'down') {
      iconEmoji = emojiDown || iconEmoji
      statusText = 'down.'
      color = '#FF0000'
    } else if (heartbeat.status === 'up') {
      iconEmoji = emojiUp || iconEmoji
      statusField = { short: false, title: 'Ping', value: `${heartbeat.ping ?? 'N/A'}ms` }
      statusText = 'up!'
      color = '#32CD32'
    }

    await postJson(config.webhookUrl, {
      username: `${monitor.name} ${username}`,
      channel: config.channel?.toLowerCase() || undefined,
      icon_emoji: iconEmoji,
      icon_url: config.iconUrl || undefined,
      attachments: [
        {
          fallback: `Your ${monitor.name} service went ${statusText}`,
          color,
          title: `${monitor.name} service went ${statusText}`,
          title_link: monitor.url || undefined,
          fields: [
            statusField,
            { short: true, title: 'Time', value: formatHeartbeatTime(heartbeat) },
          ],
        },
      ],
    })
    return OK_MESSAGE
  },
})
