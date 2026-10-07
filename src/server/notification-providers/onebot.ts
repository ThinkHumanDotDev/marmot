/**
 * OneBot (QQ bot protocol) provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/onebot.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { providerText } from '@/server/notifications/message'
import { OK_MESSAGE, postJson, trimSlash } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const onebotConfigSchema = z.object({
  httpAddr: z.string().min(1),
  accessToken: z.string().min(1),
  msgType: z.enum(['group', 'private']).default('group'),
  receiverId: z.string().min(1),
})

export type OnebotConfig = z.infer<typeof onebotConfigSchema>

export const onebotFieldMeta: Record<keyof OnebotConfig, NotificationFieldMeta> = {
  httpAddr: {
    label: 'HTTP API address',
    placeholder: 'http://127.0.0.1:5700',
    description: 'OneBot HTTP endpoint; `http://` is assumed when no scheme is given.',
  },
  accessToken: { label: 'Access token', secret: true },
  msgType: { label: 'Message type', options: { group: 'Group', private: 'Private' } },
  receiverId: { label: 'Group ID / QQ number' },
}

/** Normalise `host:port` or `http://host/` into `http://host/send_msg`. */
export function onebotSendUrl(httpAddr: string): string {
  const base = /^https?:\/\//i.test(httpAddr) ? httpAddr : `http://${httpAddr}`
  return `${trimSlash(base)}/send_msg`
}

registerNotificationProvider({
  name: 'onebot',
  label: 'OneBot',
  group: 'chat',
  docsUrl: 'https://github.com/botuniverse/onebot-11',
  configSchema: onebotConfigSchema,
  fieldMeta: onebotFieldMeta,
  async send({ config: raw, message, locale }) {
    const config = onebotConfigSchema.parse(raw)
    const p = providerText(locale)
    const data: Record<string, unknown> = {
      auto_escape: true,
      message: p('alertFor', { text: message }),
      message_type: config.msgType,
    }
    if (config.msgType === 'group') data.group_id = config.receiverId
    else data.user_id = config.receiverId

    await postJson(onebotSendUrl(config.httpAddr), data, {
      Authorization: `Bearer ${config.accessToken}`,
    })
    return OK_MESSAGE
  },
})
