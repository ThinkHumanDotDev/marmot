/**
 * Nextcloud Talk bot provider (HMAC-signed bot message).
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/nextcloudtalk.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { createHmac, randomBytes } from 'node:crypto'
import { z } from 'zod'

import { httpRequest, OK_MESSAGE, trimSlash } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const nextcloudTalkConfigSchema = z.object({
  host: z.string().url(),
  conversationToken: z.string().min(1),
  botSecret: z.string().min(1),
  sendSilentUp: z.boolean().default(false),
  sendSilentDown: z.boolean().default(false),
})

export type NextcloudTalkConfig = z.infer<typeof nextcloudTalkConfigSchema>

export const nextcloudTalkFieldMeta: Record<keyof NextcloudTalkConfig, NotificationFieldMeta> = {
  host: { label: 'Nextcloud URL', placeholder: 'https://cloud.example.com' },
  conversationToken: {
    label: 'Conversation token',
    description: 'The token in the conversation URL: /call/<token>.',
  },
  botSecret: {
    label: 'Bot secret',
    secret: true,
    description: 'Shared secret given to `occ talk:bot:install`.',
  },
  sendSilentUp: { label: 'Send UP messages silently' },
  sendSilentDown: { label: 'Send DOWN messages silently' },
}

/** Sign `random + message` with the bot secret, as the Talk bot API requires. */
export function signNextcloudTalk(secret: string, random: string, message: string): string {
  return createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(Buffer.from(`${random}${message}`, 'utf8'))
    .digest('hex')
}

registerNotificationProvider({
  name: 'nextcloud-talk',
  label: 'Nextcloud Talk',
  group: 'chat',
  docsUrl: 'https://nextcloud-talk.readthedocs.io/en/latest/bots/#sending-a-chat-message',
  configSchema: nextcloudTalkConfigSchema,
  fieldMeta: nextcloudTalkFieldMeta,
  async send({ config: raw, message, heartbeat }) {
    const config = nextcloudTalkConfigSchema.parse(raw)
    const random = randomBytes(32).toString('hex')
    const signature = signNextcloudTalk(config.botSecret, random, message)
    const silent =
      (heartbeat?.status === 'up' && config.sendSilentUp) ||
      (heartbeat?.status === 'down' && config.sendSilentDown)

    await httpRequest(
      `${trimSlash(config.host)}/ocs/v2.php/apps/spreed/api/v1/bot/${encodeURIComponent(config.conversationToken)}/message`,
      {
        method: 'POST',
        headers: {
          'X-Nextcloud-Talk-Bot-Random': random,
          'X-Nextcloud-Talk-Bot-Signature': signature,
          'OCS-APIRequest': 'true',
        },
        json: { message, silent },
      },
    )
    return OK_MESSAGE
  },
})
