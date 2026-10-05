/**
 * Splunk On-Call (VictorOps) REST endpoint provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/splunk.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { extractAddress, OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const splunkConfigSchema = z.object({
  restUrl: z.string().url(),
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']).default('CRITICAL'),
  autoResolve: z.enum(['none', 'ACKNOWLEDGEMENT', 'RECOVERY']).default('none'),
})

export type SplunkConfig = z.infer<typeof splunkConfigSchema>

export const splunkFieldMeta: Record<keyof SplunkConfig, NotificationFieldMeta> = {
  restUrl: {
    label: 'REST endpoint URL',
    secret: true,
    placeholder:
      'https://alert.victorops.com/integrations/generic/20131114/alert/<key>/<routing key>',
  },
  severity: {
    label: 'Severity',
    options: { INFO: 'Info', WARNING: 'Warning', CRITICAL: 'Critical' },
  },
  autoResolve: {
    label: 'When the monitor comes back up',
    options: {
      none: 'Do nothing',
      ACKNOWLEDGEMENT: 'Acknowledge the incident',
      RECOVERY: 'Resolve the incident',
    },
  },
}

registerNotificationProvider({
  name: 'splunk',
  label: 'Splunk On-Call',
  group: 'generic',
  docsUrl: 'https://help.victorops.com/knowledge-base/rest-endpoint-integration-guide/',
  configSchema: splunkConfigSchema,
  fieldMeta: splunkFieldMeta,
  async send({ config: raw, message, monitor, heartbeat }) {
    const config = splunkConfigSchema.parse(raw)

    let title = 'Marmot Alert'
    let body = message
    let messageType: string = config.severity
    if (heartbeat && monitor) {
      body = heartbeat.msg || message
      if (heartbeat.status === 'up') {
        if (config.autoResolve === 'none') return 'No action required'
        title = 'Marmot Monitor ✅ Up'
        messageType = config.autoResolve
      } else if (heartbeat.status === 'down') {
        title = 'Marmot Monitor 🔴 Down'
      } else {
        return 'No action required'
      }
    }

    const address = monitor ? extractAddress(monitor) || monitor.name : 'Marmot Test Button'
    await postJson(config.restUrl, {
      message_type: messageType,
      state_message: `[${title}] [${address}] ${body}`,
      entity_display_name: `Marmot Alert: ${monitor?.name ?? 'Test'}`,
      entity_id: monitor ? `Marmot/${monitor.id}` : 'Marmot/test',
    })
    return OK_MESSAGE
  },
})
