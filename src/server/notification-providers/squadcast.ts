/**
 * Squadcast incoming-webhook provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/squadcast.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { providerText } from '@/server/notifications/message'
import { extractAddress, OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const squadcastConfigSchema = z.object({
  webhookUrl: z.string().url(),
})

export type SquadcastConfig = z.infer<typeof squadcastConfigSchema>

export const squadcastFieldMeta: Record<keyof SquadcastConfig, NotificationFieldMeta> = {
  webhookUrl: {
    label: 'Webhook URL',
    secret: true,
    placeholder: 'https://api.squadcast.com/v2/incidents/api/…',
  },
}

registerNotificationProvider({
  name: 'squadcast',
  label: 'Squadcast',
  group: 'generic',
  docsUrl: 'https://support.squadcast.com/integrations/incident-webhook-incident-webhook-api',
  configSchema: squadcastConfigSchema,
  fieldMeta: squadcastFieldMeta,
  async send({ config: raw, message, monitor, heartbeat, locale }) {
    const config = squadcastConfigSchema.parse(raw)
    const p = providerText(locale)
    const data: Record<string, unknown> = {
      message,
      description: '',
      tags: {},
      heartbeat,
      source: 'marmot',
    }

    if (heartbeat && monitor) {
      data.description = heartbeat.msg ?? ''
      data.event_id = String(monitor.id)
      if (heartbeat.status === 'down') {
        data.message = p('isDownLoud', { name: monitor.name })
        data.status = 'trigger'
      } else {
        data.message = p('isUpLoud', { name: monitor.name })
        data.status = 'resolve'
      }
      data.tags = { AlertAddress: extractAddress(monitor) }
    }

    await postJson(config.webhookUrl, data)
    return OK_MESSAGE
  },
})
