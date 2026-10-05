/**
 * Pushover provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/pushover.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { formatHeartbeatTime } from '@/server/notifications/message'
import { OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const PUSHOVER_API_URL = 'https://api.pushover.net/1/messages.json'

export const PUSHOVER_SOUNDS = [
  'pushover',
  'bike',
  'bugle',
  'cashregister',
  'classical',
  'cosmic',
  'falling',
  'gamelan',
  'incoming',
  'intermission',
  'magic',
  'mechanical',
  'pianobar',
  'siren',
  'spacealarm',
  'tugboat',
  'alien',
  'climb',
  'persistent',
  'echo',
  'updown',
  'vibrate',
  'none',
] as const

export const pushoverConfigSchema = z.object({
  userKey: z.string().min(1),
  appToken: z.string().min(1),
  device: z.string().optional(),
  title: z.string().optional(),
  priority: z.enum(['-2', '-1', '0', '1', '2']).default('0'),
  sound: z.enum(PUSHOVER_SOUNDS).default('pushover'),
  soundUp: z.enum(PUSHOVER_SOUNDS).optional(),
  ttl: z.number().int().min(0).optional(),
})

export type PushoverConfig = z.infer<typeof pushoverConfigSchema>

export const pushoverFieldMeta: Record<keyof PushoverConfig, NotificationFieldMeta> = {
  userKey: { label: 'User key', secret: true },
  appToken: { label: 'Application token', secret: true },
  device: { label: 'Device', description: 'Optional: deliver to one device only.' },
  title: { label: 'Message title', placeholder: 'Marmot' },
  priority: {
    label: 'Priority',
    options: {
      '-2': 'Lowest',
      '-1': 'Low',
      '0': 'Normal',
      '1': 'High',
      '2': 'Emergency (retry every 30s for 1h)',
    },
  },
  sound: { label: 'Notification sound' },
  soundUp: { label: 'Sound for UP alerts', description: 'Defaults to the sound above.' },
  ttl: { label: 'Message TTL (seconds)', description: '0 or empty = never expire.' },
}

registerNotificationProvider({
  name: 'pushover',
  label: 'Pushover',
  group: 'push',
  docsUrl: 'https://pushover.net/api',
  configSchema: pushoverConfigSchema,
  fieldMeta: pushoverFieldMeta,
  async send({ config: raw, message, heartbeat }) {
    const config = pushoverConfigSchema.parse(raw)
    const data: Record<string, unknown> = {
      message,
      user: config.userKey,
      token: config.appToken,
      sound: config.sound,
      priority: Number(config.priority),
      title: config.title || 'Marmot',
      retry: '30',
      expire: '3600',
      html: 1,
    }
    if (config.device) data.device = config.device
    if (config.ttl) data.ttl = config.ttl

    if (heartbeat) {
      if (heartbeat.status === 'up' && config.soundUp) data.sound = config.soundUp
      data.message = `${message}\n<b>Time</b>: ${formatHeartbeatTime(heartbeat)}`
    }

    await postJson(PUSHOVER_API_URL, data)
    return OK_MESSAGE
  },
})
