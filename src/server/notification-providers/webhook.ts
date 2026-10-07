/**
 * Generic webhook provider (JSON, form-data or a custom templated body).
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/webhook.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { renderMessageTemplate } from '@/server/notifications/message'
import { httpRequest, OK_MESSAGE, parseHeadersJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const webhookConfigSchema = z.object({
  url: z.string().url(),
  method: z.enum(['POST', 'GET', 'PUT', 'PATCH']).default('POST'),
  contentType: z.enum(['json', 'form-data', 'custom']).default('json'),
  customBody: z.string().optional(),
  additionalHeaders: z.string().optional(),
})

export type WebhookConfig = z.infer<typeof webhookConfigSchema>

export const webhookFieldMeta: Record<keyof WebhookConfig, NotificationFieldMeta> = {
  url: { label: 'Post URL', placeholder: 'https://example.com/hooks/marmot' },
  method: { label: 'HTTP method' },
  contentType: {
    label: 'Request body',
    options: {
      json: 'application/json',
      'form-data': 'multipart/form-data',
      custom: 'Custom body (template)',
    },
  },
  customBody: {
    label: 'Custom body',
    multiline: true,
    description:
      'Sent verbatim after {{ }} substitution, e.g. {"text": "{{ msg }}"}. Set Content-Type in the headers below.',
  },
  additionalHeaders: {
    label: 'Additional headers (JSON)',
    multiline: true,
    placeholder: '{ "Authorization": "Bearer …" }',
  },
}

registerNotificationProvider({
  name: 'webhook',
  label: 'Webhook',
  group: 'generic',
  configSchema: webhookConfigSchema,
  fieldMeta: webhookFieldMeta,
  async send({ config: raw, message, monitor, heartbeat, locale }) {
    const config = webhookConfigSchema.parse(raw)
    const headers = parseHeadersJson(config.additionalHeaders)
    const data = { heartbeat, monitor, msg: message }

    if (config.method === 'GET') {
      const url = new URL(config.url)
      url.searchParams.set('msg', message)
      if (heartbeat) url.searchParams.set('heartbeat', JSON.stringify(heartbeat))
      if (monitor) url.searchParams.set('monitor', JSON.stringify(monitor))
      await httpRequest(url.toString(), { method: 'GET', headers })
      return OK_MESSAGE
    }

    if (config.contentType === 'form-data') {
      const form = new FormData()
      form.append('data', JSON.stringify(data))
      await httpRequest(config.url, { method: config.method, headers, rawBody: form })
      return OK_MESSAGE
    }

    if (config.contentType === 'custom') {
      const body = renderMessageTemplate(
        config.customBody ?? '',
        message,
        monitor,
        heartbeat,
        locale,
      )
      await httpRequest(config.url, {
        method: config.method,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers },
        rawBody: body,
      })
      return OK_MESSAGE
    }

    await httpRequest(config.url, { method: config.method, headers, json: data })
    return OK_MESSAGE
  },
})
