/**
 * ntfy provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/ntfy.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { OK_MESSAGE, postJson, trimSlash } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const ntfyConfigSchema = z.object({
  serverUrl: z.string().url().default('https://ntfy.sh'),
  topic: z.string().min(1),
  priority: z.number().int().min(1).max(5).default(4),
  priorityDown: z.number().int().min(1).max(5).optional(),
  authMethod: z.enum(['none', 'usernamePassword', 'accessToken']).default('none'),
  username: z.string().optional(),
  password: z.string().optional(),
  accessToken: z.string().optional(),
  icon: z.string().optional(),
})

export type NtfyConfig = z.infer<typeof ntfyConfigSchema>

export const ntfyFieldMeta: Record<keyof NtfyConfig, NotificationFieldMeta> = {
  serverUrl: { label: 'Server URL', placeholder: 'https://ntfy.sh' },
  topic: { label: 'Topic', placeholder: 'marmot-alerts' },
  priority: {
    label: 'Priority (1–5)',
    description: '5 is urgent; DOWN alerts default to priority + 1.',
  },
  priorityDown: { label: 'Priority for DOWN alerts (1–5)' },
  authMethod: {
    label: 'Authentication',
    options: { none: 'None', usernamePassword: 'Username & password', accessToken: 'Access token' },
  },
  username: { label: 'Username' },
  password: { label: 'Password', secret: true },
  accessToken: { label: 'Access token', secret: true },
  icon: { label: 'Icon URL', placeholder: 'https://example.com/icon.png' },
}

registerNotificationProvider({
  name: 'ntfy',
  label: 'ntfy',
  group: 'push',
  docsUrl: 'https://docs.ntfy.sh/publish/',
  configSchema: ntfyConfigSchema,
  fieldMeta: ntfyFieldMeta,
  async send({ config: raw, message, monitor, heartbeat }) {
    const config = ntfyConfigSchema.parse(raw)
    const headers: Record<string, string> = {}
    if (config.authMethod === 'usernamePassword') {
      headers.Authorization = `Basic ${Buffer.from(`${config.username ?? ''}:${config.password ?? ''}`).toString('base64')}`
    } else if (config.authMethod === 'accessToken' && config.accessToken) {
      headers.Authorization = `Bearer ${config.accessToken}`
    }
    const url = trimSlash(config.serverUrl)

    if (!heartbeat || !monitor) {
      await postJson(
        url,
        {
          topic: config.topic,
          title: `${monitor?.name || config.topic} [Marmot]`,
          message,
          priority: config.priority,
          tags: ['test_tube'],
        },
        headers,
      )
      return OK_MESSAGE
    }

    let tags: string[] = []
    let status = 'unknown'
    let priority = config.priority
    if (heartbeat.status === 'down') {
      tags = ['red_circle']
      status = 'Down'
      priority = config.priorityDown ?? (priority === 5 ? priority : priority + 1)
    } else if (heartbeat.status === 'up') {
      tags = ['green_circle']
      status = 'Up'
    }

    const data: Record<string, unknown> = {
      topic: config.topic,
      message: heartbeat.msg || message,
      priority,
      title: `${monitor.name} ${status} [Marmot]`,
      tags,
    }
    if (monitor.url && monitor.url !== 'https://') {
      data.actions = [{ action: 'view', label: `Open ${monitor.name}`, url: monitor.url }]
    }
    if (config.icon) data.icon = config.icon

    await postJson(url, data, headers)
    return OK_MESSAGE
  },
})
