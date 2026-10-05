/**
 * Opsgenie Alert API provider (create on DOWN, close by alias on UP).
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/opsgenie.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const OPSGENIE_ALERTS_URL = {
  us: 'https://api.opsgenie.com/v2/alerts',
  eu: 'https://api.eu.opsgenie.com/v2/alerts',
} as const

export const opsgenieConfigSchema = z.object({
  region: z.enum(['us', 'eu']).default('us'),
  apiKey: z.string().min(1),
  priority: z.number().int().min(1).max(5).default(3),
})

export type OpsgenieConfig = z.infer<typeof opsgenieConfigSchema>

export const opsgenieFieldMeta: Record<keyof OpsgenieConfig, NotificationFieldMeta> = {
  region: { label: 'Region', options: { us: 'US (default)', eu: 'EU' } },
  apiKey: { label: 'API key', secret: true, description: 'Teams → Integrations → API.' },
  priority: { label: 'Priority (1–5)', description: 'P1 is critical, P5 informational.' },
}

registerNotificationProvider({
  name: 'opsgenie',
  label: 'Opsgenie',
  group: 'generic',
  docsUrl: 'https://docs.opsgenie.com/docs/alert-api',
  configSchema: opsgenieConfigSchema,
  fieldMeta: opsgenieFieldMeta,
  async send({ config: raw, message, monitor, heartbeat }) {
    const config = opsgenieConfigSchema.parse(raw)
    const alertsUrl = OPSGENIE_ALERTS_URL[config.region]
    const headers = { Authorization: `GenieKey ${config.apiKey}` }

    if (!heartbeat || !monitor) {
      await postJson(
        alertsUrl,
        { message, alias: 'marmot-notification-test', source: 'Marmot', priority: 'P5' },
        headers,
      )
      return OK_MESSAGE
    }

    if (heartbeat.status === 'down') {
      await postJson(
        alertsUrl,
        {
          message: `Marmot Alert: ${monitor.name}`,
          alias: monitor.name,
          description: message,
          source: 'Marmot',
          priority: `P${config.priority}`,
        },
        headers,
      )
      return OK_MESSAGE
    }

    if (heartbeat.status === 'up') {
      const closeUrl = `${alertsUrl}/${encodeURIComponent(monitor.name)}/close?identifierType=alias`
      await postJson(closeUrl, { source: 'Marmot' }, headers)
      return OK_MESSAGE
    }

    return 'no action required'
  },
})
