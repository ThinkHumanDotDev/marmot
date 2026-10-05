/**
 * Bitrix24 provider (`im.notify.system.add` through an inbound webhook).
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/bitrix24.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md. Kuma colours UP red and DOWN green; Marmot swaps them.
 */
import { z } from 'zod'

import { httpRequest, OK_MESSAGE, trimSlash } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const bitrix24ConfigSchema = z.object({
  webhookUrl: z.string().url(),
  userId: z.string().min(1),
})

export type Bitrix24Config = z.infer<typeof bitrix24ConfigSchema>

export const bitrix24FieldMeta: Record<keyof Bitrix24Config, NotificationFieldMeta> = {
  webhookUrl: {
    label: 'Inbound webhook URL',
    secret: true,
    placeholder: 'https://example.bitrix24.com/rest/1/abc123xyz',
    description: 'Developer resources → Other → Inbound webhook, with the `im` scope.',
  },
  userId: { label: 'User ID', description: 'Numeric id of the user to notify.' },
}

registerNotificationProvider({
  name: 'bitrix24',
  label: 'Bitrix24',
  group: 'chat',
  docsUrl:
    'https://apidocs.bitrix24.com/api-reference/chats/notifications/im-notify-system-add.html',
  configSchema: bitrix24ConfigSchema,
  fieldMeta: bitrix24FieldMeta,
  async send({ config: raw, message, heartbeat }) {
    const config = bitrix24ConfigSchema.parse(raw)
    const url = new URL(`${trimSlash(config.webhookUrl)}/im.notify.system.add.json`)
    url.searchParams.set('user_id', config.userId)
    url.searchParams.set('message', '[B]Marmot[/B]')
    url.searchParams.set('ATTACH[COLOR]', heartbeat?.status === 'down' ? '#b73419' : '#67b518')
    url.searchParams.set('ATTACH[BLOCKS][0][MESSAGE]', message)

    await httpRequest(url.toString(), { method: 'GET' })
    return OK_MESSAGE
  },
})
