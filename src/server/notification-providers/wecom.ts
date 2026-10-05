/**
 * WeCom (WeChat Work) group-bot provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/wecom.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const wecomConfigSchema = z.object({
  botKey: z.string().min(1),
  mentionedMobileList: z.string().optional(),
})

export type WecomConfig = z.infer<typeof wecomConfigSchema>

export const wecomFieldMeta: Record<keyof WecomConfig, NotificationFieldMeta> = {
  botKey: {
    label: 'Bot key',
    secret: true,
    description: 'The `key=` parameter of the group bot webhook URL.',
  },
  mentionedMobileList: {
    label: 'Mention mobile numbers',
    placeholder: '13800001111,13900002222,@all',
    description: 'Comma-separated; `@all` mentions everyone.',
  },
}

registerNotificationProvider({
  name: 'wecom',
  label: 'WeCom',
  group: 'chat',
  docsUrl: 'https://developer.work.weixin.qq.com/document/path/91770',
  configSchema: wecomConfigSchema,
  fieldMeta: wecomFieldMeta,
  async send({ config: raw, message, heartbeat }) {
    const config = wecomConfigSchema.parse(raw)
    let title = 'Marmot Message'
    if (heartbeat?.status === 'up') title = 'Marmot Monitor Up'
    else if (heartbeat?.status === 'down') title = 'Marmot Monitor Down'

    const text: Record<string, unknown> = { content: `${title}\n${message}` }
    const mobiles = (config.mentionedMobileList ?? '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean)
    if (mobiles.length > 0) text.mentioned_mobile_list = mobiles

    await postJson(
      `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(config.botKey)}`,
      { msgtype: 'text', text },
    )
    return OK_MESSAGE
  },
})
