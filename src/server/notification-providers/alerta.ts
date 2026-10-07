/**
 * Alerta provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/alerta.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { providerText } from '@/server/notifications/message'
import { OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const alertaConfigSchema = z.object({
  apiEndpoint: z.string().url(),
  apiKey: z.string().min(1),
  environment: z.string().min(1),
  alertState: z.string().default('critical'),
  recoverState: z.string().default('cleared'),
})

export type AlertaConfig = z.infer<typeof alertaConfigSchema>

export const alertaFieldMeta: Record<keyof AlertaConfig, NotificationFieldMeta> = {
  apiEndpoint: { label: 'API endpoint', placeholder: 'https://alerta.example.com/api/alert' },
  apiKey: { label: 'API key', secret: true },
  environment: { label: 'Environment', placeholder: 'Production' },
  alertState: { label: 'Severity when DOWN', placeholder: 'critical' },
  recoverState: { label: 'Severity when UP', placeholder: 'cleared' },
}

registerNotificationProvider({
  name: 'alerta',
  label: 'Alerta',
  group: 'generic',
  docsUrl: 'https://docs.alerta.io/api/reference.html#create-an-alert',
  configSchema: alertaConfigSchema,
  fieldMeta: alertaFieldMeta,
  async send({ config: raw, message, monitor, heartbeat, locale }) {
    const config = alertaConfigSchema.parse(raw)
    const p = providerText(locale)
    const headers = {
      'Content-Type': 'application/json;charset=UTF-8',
      Authorization: `Key ${config.apiKey}`,
    }
    const base = {
      environment: config.environment,
      severity: 'critical',
      correlate: [] as string[],
      service: ['Marmot'],
      value: 'Timeout',
      tags: ['marmot'],
      attributes: {},
      origin: 'marmot',
      type: 'exceptionAlert',
    }

    if (!heartbeat || !monitor) {
      await postJson(
        config.apiEndpoint,
        { ...base, event: 'msg', text: message, group: 'marmot-msg', resource: 'Message' },
        headers,
      )
      return OK_MESSAGE
    }

    const data = {
      ...base,
      correlate: ['service_up', 'service_down'],
      event: monitor.type,
      group: `marmot-${monitor.type}`,
      resource: monitor.name,
    }
    if (heartbeat.status === 'down') {
      await postJson(
        config.apiEndpoint,
        {
          ...data,
          severity: config.alertState,
          text: p('serviceTypeDown', { type: monitor.type }),
        },
        headers,
      )
    } else if (heartbeat.status === 'up') {
      await postJson(
        config.apiEndpoint,
        {
          ...data,
          severity: config.recoverState,
          text: p('serviceTypeUp', { type: monitor.type }),
        },
        headers,
      )
    }
    return OK_MESSAGE
  },
})
