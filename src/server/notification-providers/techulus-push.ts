/**
 * Push by Techulus provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/techulus-push.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const TECHULUS_SOUNDS = [
  'default',
  'arcade',
  'correct',
  'fail',
  'harp',
  'reveal',
  'bubble',
  'doorbell',
  'flute',
  'money',
  'scifi',
  'clear',
  'elevator',
  'guitar',
  'pop',
] as const

export const techulusPushConfigSchema = z.object({
  apiKey: z.string().min(1),
  title: z.string().optional(),
  channel: z.string().optional(),
  sound: z.enum(TECHULUS_SOUNDS).optional(),
  timeSensitive: z.boolean().default(true),
})

export type TechulusPushConfig = z.infer<typeof techulusPushConfigSchema>

export const techulusPushFieldMeta: Record<keyof TechulusPushConfig, NotificationFieldMeta> = {
  apiKey: { label: 'API key', secret: true },
  title: { label: 'Title', placeholder: 'Marmot' },
  channel: { label: 'Channel', description: 'Optional channel name.' },
  sound: { label: 'Sound' },
  timeSensitive: { label: 'Time-sensitive notification' },
}

registerNotificationProvider({
  name: 'techulus-push',
  label: 'Push by Techulus',
  group: 'push',
  docsUrl: 'https://docs.push.techulus.com/api-documentation',
  configSchema: techulusPushConfigSchema,
  fieldMeta: techulusPushFieldMeta,
  async send({ config: raw, message }) {
    const config = techulusPushConfigSchema.parse(raw)
    const data: Record<string, unknown> = {
      title: config.title?.length ? config.title : 'Marmot',
      body: message,
      timeSensitive: config.timeSensitive,
    }
    if (config.channel) data.channel = config.channel
    if (config.sound) data.sound = config.sound

    await postJson(
      `https://push.techulus.com/api/v1/notify/${encodeURIComponent(config.apiKey)}`,
      data,
    )
    return OK_MESSAGE
  },
})
