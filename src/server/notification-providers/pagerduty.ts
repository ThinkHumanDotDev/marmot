/**
 * PagerDuty Events API v2 provider (trigger on DOWN, acknowledge/resolve on UP).
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/pagerduty.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { extractAddress, OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const PAGERDUTY_EVENTS_URL = 'https://events.pagerduty.com/v2/enqueue'

export const pagerdutyConfigSchema = z.object({
  integrationKey: z.string().min(1),
  integrationUrl: z.string().url().default(PAGERDUTY_EVENTS_URL),
  priority: z.enum(['info', 'warning', 'error', 'critical']).default('warning'),
  autoResolve: z.enum(['none', 'acknowledge', 'resolve']).default('none'),
})

export type PagerdutyConfig = z.infer<typeof pagerdutyConfigSchema>

export const pagerdutyFieldMeta: Record<keyof PagerdutyConfig, NotificationFieldMeta> = {
  integrationKey: {
    label: 'Integration key',
    secret: true,
    description: 'Service → Integrations → Events API v2 routing key.',
  },
  integrationUrl: { label: 'Integration URL' },
  priority: {
    label: 'Severity',
    options: { info: 'Info', warning: 'Warning', error: 'Error', critical: 'Critical' },
  },
  autoResolve: {
    label: 'When the monitor comes back up',
    options: {
      none: 'Do nothing',
      acknowledge: 'Acknowledge the incident',
      resolve: 'Resolve the incident',
    },
  },
}

registerNotificationProvider({
  name: 'pagerduty',
  label: 'PagerDuty',
  group: 'generic',
  docsUrl: 'https://developer.pagerduty.com/docs/events-api-v2-overview',
  configSchema: pagerdutyConfigSchema,
  fieldMeta: pagerdutyFieldMeta,
  async send({ config: raw, message, monitor, heartbeat }) {
    const config = pagerdutyConfigSchema.parse(raw)

    let title = 'Marmot Alert'
    let body = message
    let eventAction: 'trigger' | 'acknowledge' | 'resolve' = 'trigger'
    if (heartbeat && monitor) {
      body = heartbeat.msg || message
      if (heartbeat.status === 'up') {
        if (config.autoResolve === 'none') return 'no action required'
        title = 'Marmot Monitor ✅ Up'
        eventAction = config.autoResolve
      } else if (heartbeat.status === 'down') {
        title = 'Marmot Monitor 🔴 Down'
      } else {
        return 'no action required'
      }
    }

    const source = monitor ? extractAddress(monitor) || monitor.name : 'Marmot Test Button'
    await postJson(config.integrationUrl, {
      payload: {
        summary: monitor ? `[${title}] [${monitor.name}] ${body}` : `[${title}] ${body}`,
        severity: config.priority,
        source,
      },
      routing_key: config.integrationKey,
      event_action: eventAction,
      dedup_key: monitor ? `Marmot/${monitor.id}` : 'Marmot/test',
    })
    return OK_MESSAGE
  },
})
