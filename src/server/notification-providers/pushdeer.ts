/**
 * PushDeer provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/pushdeer.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { providerText } from '@/server/notifications/message'
import { httpRequest, OK_MESSAGE, trimSlash } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const pushdeerConfigSchema = z.object({
  serverUrl: z.string().url().default('https://api2.pushdeer.com'),
  pushKey: z.string().min(1),
})

export type PushdeerConfig = z.infer<typeof pushdeerConfigSchema>

export const pushdeerFieldMeta: Record<keyof PushdeerConfig, NotificationFieldMeta> = {
  serverUrl: { label: 'Server URL', placeholder: 'https://api2.pushdeer.com' },
  pushKey: { label: 'Push key', placeholder: 'PDU…', secret: true },
}

type PushdeerResponse = {
  error?: string
  content?: { result?: string[] }
}

registerNotificationProvider({
  name: 'pushdeer',
  label: 'PushDeer',
  group: 'push',
  docsUrl: 'https://github.com/easychen/pushdeer',
  configSchema: pushdeerConfigSchema,
  fieldMeta: pushdeerFieldMeta,
  async send({ config: raw, message, monitor, heartbeat, locale }) {
    const config = pushdeerConfigSchema.parse(raw)
    const p = providerText(locale)
    const url = `${trimSlash(config.serverUrl.trim())}/message/push`

    let title = `## ${p('message')}`
    if (monitor && heartbeat?.status === 'up') title = `## ${p('namedUp', { name: monitor.name })}`
    else if (monitor && heartbeat?.status === 'down') {
      title = `## ${p('namedDown', { name: monitor.name })}`
    }

    const response = await httpRequest(url, {
      method: 'POST',
      json: {
        pushkey: config.pushKey,
        text: title,
        desp: message.replace(/\n/g, '\n\n'),
        type: 'markdown',
      },
    })

    let data: PushdeerResponse = {}
    try {
      data = (await response.json()) as PushdeerResponse
    } catch {
      throw new Error('PushDeer returned an unreadable response')
    }
    if (data.error) throw new Error(String(data.error))
    const result = data.content?.result ?? []
    if (result.length === 0) throw new Error('Invalid PushDeer key')
    try {
      if (JSON.parse(result[0]).success !== 'ok') throw new Error('Unknown PushDeer error')
    } catch (error) {
      throw error instanceof Error ? error : new Error('Unknown PushDeer error')
    }
    return OK_MESSAGE
  },
})
