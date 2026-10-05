/**
 * Bark provider (APNs bridge for Apple devices).
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/bark.js` (MIT, Louis Lam; original by
 * Lakr Aream). See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { httpRequest, OK_MESSAGE, postJson, trimSlash } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const BARK_SOUNDS = [
  'alarm',
  'anticipate',
  'bell',
  'birdsong',
  'bloom',
  'calypso',
  'chime',
  'choo',
  'descent',
  'electronic',
  'fanfare',
  'glass',
  'gotosleep',
  'healthnotification',
  'horn',
  'ladder',
  'mailsent',
  'minuet',
  'multiwayinvitation',
  'newmail',
  'newsflash',
  'noir',
  'paymentsuccess',
  'shake',
  'sherwoodforest',
  'silence',
  'spell',
  'suspense',
  'telegraph',
  'tiptoes',
  'typewriters',
  'update',
] as const

export const barkConfigSchema = z.object({
  endpoint: z.string().url(),
  apiVersion: z.enum(['v1', 'v2']).default('v1'),
  group: z.string().default('Marmot'),
  sound: z.enum(BARK_SOUNDS).default('telegraph'),
})

export type BarkConfig = z.infer<typeof barkConfigSchema>

export const barkFieldMeta: Record<keyof BarkConfig, NotificationFieldMeta> = {
  endpoint: {
    label: 'Bark endpoint',
    placeholder: 'https://api.day.app/<device key>',
    secret: true,
    description: 'Server URL including your device key.',
  },
  apiVersion: { label: 'API version', options: { v1: 'v1 (GET)', v2: 'v2 (POST)' } },
  group: { label: 'Group' },
  sound: { label: 'Sound' },
}

registerNotificationProvider({
  name: 'bark',
  label: 'Bark',
  group: 'push',
  docsUrl: 'https://github.com/Finb/Bark',
  configSchema: barkConfigSchema,
  fieldMeta: barkFieldMeta,
  async send({ config: raw, message, heartbeat }) {
    const config = barkConfigSchema.parse(raw)
    const endpoint = trimSlash(config.endpoint)

    let title = 'Marmot Message'
    if (heartbeat?.status === 'up') title = 'Marmot Monitor Up'
    else if (heartbeat?.status === 'down') title = 'Marmot Monitor Down'

    if (config.apiVersion === 'v1') {
      const params = new URLSearchParams({ group: config.group, sound: config.sound })
      await httpRequest(
        `${endpoint}/${encodeURIComponent(title)}/${encodeURIComponent(message)}?${params}`,
        { method: 'GET' },
      )
      return OK_MESSAGE
    }

    await postJson(endpoint, {
      title,
      body: message,
      sound: config.sound,
      group: config.group,
    })
    return OK_MESSAGE
  },
})
