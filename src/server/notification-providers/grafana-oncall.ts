/**
 * Grafana OnCall (formatted webhook) provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/grafana-oncall.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { providerText } from '@/server/notifications/message'
import { OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const grafanaOncallConfigSchema = z.object({
  webhookUrl: z.string().url(),
})

export type GrafanaOncallConfig = z.infer<typeof grafanaOncallConfigSchema>

export const grafanaOncallFieldMeta: Record<keyof GrafanaOncallConfig, NotificationFieldMeta> = {
  webhookUrl: {
    label: 'Formatted webhook URL',
    secret: true,
    placeholder:
      'https://oncall-prod-us-central-0.grafana.net/oncall/integrations/v1/formatted_webhook/…',
  },
}

registerNotificationProvider({
  name: 'grafana-oncall',
  label: 'Grafana OnCall',
  group: 'generic',
  docsUrl: 'https://grafana.com/docs/oncall/latest/integrations/webhook/',
  configSchema: grafanaOncallConfigSchema,
  fieldMeta: grafanaOncallFieldMeta,
  async send({ config: raw, message, monitor, heartbeat, locale }) {
    const config = grafanaOncallConfigSchema.parse(raw)
    const p = providerText(locale)

    if (!heartbeat || !monitor) {
      await postJson(config.webhookUrl, {
        title: p('generalNotification'),
        message,
        state: 'alerting',
      })
      return OK_MESSAGE
    }

    if (heartbeat.status === 'down') {
      await postJson(config.webhookUrl, {
        title: p('isDown', { name: monitor.name }),
        message: heartbeat.msg ?? '',
        state: 'alerting',
      })
    } else if (heartbeat.status === 'up') {
      await postJson(config.webhookUrl, {
        title: p('isUp', { name: monitor.name }),
        message: heartbeat.msg ?? '',
        state: 'ok',
      })
    }
    return OK_MESSAGE
  },
})
