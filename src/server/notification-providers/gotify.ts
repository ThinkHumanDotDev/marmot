/**
 * Gotify provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/gotify.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { OK_MESSAGE, postJson, trimSlash } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const gotifyConfigSchema = z.object({
  serverUrl: z.string().url(),
  appToken: z.string().min(1),
  priority: z.number().int().min(0).max(10).default(8),
})

export type GotifyConfig = z.infer<typeof gotifyConfigSchema>

export const gotifyFieldMeta: Record<keyof GotifyConfig, NotificationFieldMeta> = {
  serverUrl: { label: 'Server URL', placeholder: 'https://gotify.example.com' },
  appToken: { label: 'Application token', secret: true },
  priority: { label: 'Priority (0–10)' },
}

registerNotificationProvider({
  name: 'gotify',
  label: 'Gotify',
  group: 'push',
  docsUrl: 'https://gotify.net/docs/pushmsg',
  configSchema: gotifyConfigSchema,
  fieldMeta: gotifyFieldMeta,
  async send({ config: raw, message, monitor }) {
    const config = gotifyConfigSchema.parse(raw)
    const url = `${trimSlash(config.serverUrl)}/message?token=${encodeURIComponent(config.appToken)}`
    await postJson(url, {
      message,
      priority: config.priority,
      title: monitor?.name ? `Marmot: ${monitor.name}` : 'Marmot',
    })
    return OK_MESSAGE
  },
})
