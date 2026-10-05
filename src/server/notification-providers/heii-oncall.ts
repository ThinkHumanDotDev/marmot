/**
 * Heii On-Call manual-trigger provider (alert on DOWN, resolve on UP).
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/heii-oncall.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const heiiOncallConfigSchema = z.object({
  apiKey: z.string().min(1),
  triggerId: z.string().min(1),
})

export type HeiiOncallConfig = z.infer<typeof heiiOncallConfigSchema>

export const heiiOncallFieldMeta: Record<keyof HeiiOncallConfig, NotificationFieldMeta> = {
  apiKey: { label: 'API key', secret: true },
  triggerId: {
    label: 'Trigger ID',
    description: 'From the manual trigger URL `https://heiioncall.com/triggers/<id>/`.',
  },
}

registerNotificationProvider({
  name: 'heii-oncall',
  label: 'Heii On-Call',
  group: 'generic',
  docsUrl: 'https://heiioncall.com/docs#manual-triggers',
  configSchema: heiiOncallConfigSchema,
  fieldMeta: heiiOncallFieldMeta,
  async send({ config: raw, message, monitor, heartbeat }) {
    const config = heiiOncallConfigSchema.parse(raw)
    const headers = { Accept: 'application/json', Authorization: `Bearer ${config.apiKey}` }
    const base = `https://heiioncall.com/triggers/${encodeURIComponent(config.triggerId)}/`

    if (!heartbeat || !monitor) {
      await postJson(`${base}alert`, { msg: message }, headers)
      return OK_MESSAGE
    }

    const payload = { ...heartbeat, msg: heartbeat.msg || message, monitorName: monitor.name }
    if (heartbeat.status === 'down') {
      await postJson(`${base}alert`, payload, headers)
    } else if (heartbeat.status === 'up') {
      await postJson(`${base}resolve`, payload, headers)
    }
    return OK_MESSAGE
  },
})
