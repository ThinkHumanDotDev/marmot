/**
 * Pumble incoming-webhook provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/pumble.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { providerText } from '@/server/notifications/message'
import { OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const pumbleConfigSchema = z.object({
  webhookUrl: z.string().url(),
})

export type PumbleConfig = z.infer<typeof pumbleConfigSchema>

export const pumbleFieldMeta: Record<keyof PumbleConfig, NotificationFieldMeta> = {
  webhookUrl: {
    label: 'Webhook URL',
    secret: true,
    placeholder: 'https://api.pumble.com/workspaces/…/incomingWebhooks/postMessage/…',
  },
}

registerNotificationProvider({
  name: 'pumble',
  label: 'Pumble',
  group: 'chat',
  docsUrl: 'https://pumble.com/help/integrations/add-pumble-apps/incoming-webhooks-for-pumble/',
  configSchema: pumbleConfigSchema,
  fieldMeta: pumbleFieldMeta,
  async send({ config: raw, message, monitor, heartbeat, locale }) {
    const config = pumbleConfigSchema.parse(raw)
    const p = providerText(locale)

    if (!heartbeat || !monitor) {
      await postJson(config.webhookUrl, {
        attachments: [{ title: p('alert'), text: message, color: '#5BDD8B' }],
      })
      return OK_MESSAGE
    }

    const up = heartbeat.status === 'up'
    await postJson(config.webhookUrl, {
      attachments: [
        {
          title: up ? p('isUp', { name: monitor.name }) : p('isDown', { name: monitor.name }),
          text: heartbeat.msg ?? '',
          color: up ? '#5BDD8B' : '#DC3645',
        },
      ],
    })
    return OK_MESSAGE
  },
})
