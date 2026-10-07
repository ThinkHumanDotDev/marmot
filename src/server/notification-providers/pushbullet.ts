/**
 * Pushbullet provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/pushbullet.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { providerText, statusLabel, timeLine } from '@/server/notifications/message'
import { OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const PUSHBULLET_API_URL = 'https://api.pushbullet.com/v2/pushes'

export const pushbulletConfigSchema = z.object({
  accessToken: z.string().min(1),
})

export type PushbulletConfig = z.infer<typeof pushbulletConfigSchema>

export const pushbulletFieldMeta: Record<keyof PushbulletConfig, NotificationFieldMeta> = {
  accessToken: {
    label: 'Access token',
    secret: true,
    description: 'Settings → Account → Create Access Token.',
  },
}

registerNotificationProvider({
  name: 'pushbullet',
  label: 'Pushbullet',
  group: 'push',
  docsUrl: 'https://docs.pushbullet.com/#create-push',
  configSchema: pushbulletConfigSchema,
  fieldMeta: pushbulletFieldMeta,
  async send({ config: raw, message, monitor, heartbeat, locale }) {
    const config = pushbulletConfigSchema.parse(raw)
    const p = providerText(locale)
    const headers = { 'Access-Token': config.accessToken }

    if (!heartbeat || !monitor) {
      await postJson(
        PUSHBULLET_API_URL,
        { type: 'note', title: p('alert'), body: message },
        headers,
      )
      return OK_MESSAGE
    }

    await postJson(
      PUSHBULLET_API_URL,
      {
        type: 'note',
        title: p('alertFor', { text: monitor.name }),
        body: `[${statusLabel(heartbeat.status, locale)}] ${heartbeat.msg ?? ''}\n${timeLine(heartbeat, locale)}`,
      },
      headers,
    )
    return OK_MESSAGE
  },
})
