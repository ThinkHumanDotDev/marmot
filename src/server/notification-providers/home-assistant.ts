/**
 * Home Assistant provider (calls a `notify.*` service through the REST API).
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/home-assistant.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { OK_MESSAGE, postJson, trimSlash } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const homeAssistantConfigSchema = z.object({
  url: z.string().url(),
  longLivedAccessToken: z.string().min(1),
  notificationService: z.string().default('notify'),
})

export type HomeAssistantConfig = z.infer<typeof homeAssistantConfigSchema>

export const homeAssistantFieldMeta: Record<keyof HomeAssistantConfig, NotificationFieldMeta> = {
  url: { label: 'Home Assistant URL', placeholder: 'http://homeassistant.local:8123' },
  longLivedAccessToken: {
    label: 'Long-lived access token',
    secret: true,
    description: 'Profile → Security → Long-lived access tokens.',
  },
  notificationService: {
    label: 'Notification service',
    placeholder: 'notify',
    description: 'The part after `notify.`, e.g. `mobile_app_phone`; `notify` reaches all devices.',
  },
}

registerNotificationProvider({
  name: 'home-assistant',
  label: 'Home Assistant',
  group: 'push',
  docsUrl: 'https://www.home-assistant.io/integrations/notify/',
  configSchema: homeAssistantConfigSchema,
  fieldMeta: homeAssistantFieldMeta,
  async send({ config: raw, message, monitor, heartbeat }) {
    const config = homeAssistantConfigSchema.parse(raw)
    const service = config.notificationService.trim() || 'notify'
    const url = `${trimSlash(config.url.trim())}/api/services/notify/${encodeURIComponent(service)}`

    await postJson(
      url,
      {
        title: 'Marmot',
        message,
        ...(service !== 'persistent_notification'
          ? {
              data: {
                name: monitor?.name,
                status: heartbeat?.status,
                channel: 'Marmot',
              },
            }
          : {}),
      },
      { Authorization: `Bearer ${config.longLivedAccessToken}` },
    )
    return OK_MESSAGE
  },
})
