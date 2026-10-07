/**
 * Feishu / Lark custom-bot provider (interactive card).
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/feishu.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { formatHeartbeatTime, providerText } from '@/server/notifications/message'
import { OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'
import type { Heartbeat } from '@/payload-types'

export const feishuConfigSchema = z.object({
  webhookUrl: z.string().url(),
})

export type FeishuConfig = z.infer<typeof feishuConfigSchema>

export const feishuFieldMeta: Record<keyof FeishuConfig, NotificationFieldMeta> = {
  webhookUrl: {
    label: 'Webhook URL',
    secret: true,
    placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/…',
  },
}

const cardContent = (heartbeat: Heartbeat, p: ReturnType<typeof providerText>) =>
  [
    `**${p('messageField')}**: ${heartbeat.msg ?? ''}`,
    `**${p('ping')}**: ${heartbeat.ping == null ? 'N/A' : `${heartbeat.ping} ms`}`,
    `**${p('time')}**: ${formatHeartbeatTime(heartbeat)}`,
  ].join('\n')

registerNotificationProvider({
  name: 'feishu',
  label: 'Feishu / Lark',
  group: 'chat',
  docsUrl: 'https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot',
  configSchema: feishuConfigSchema,
  fieldMeta: feishuFieldMeta,
  async send({ config: raw, message, monitor, heartbeat, locale }) {
    const config = feishuConfigSchema.parse(raw)
    const p = providerText(locale)

    if (!heartbeat || !monitor) {
      await postJson(config.webhookUrl, { msg_type: 'text', content: { text: message } })
      return OK_MESSAGE
    }

    const down = heartbeat.status === 'down'
    await postJson(config.webhookUrl, {
      msg_type: 'interactive',
      card: {
        config: { update_multi: false, wide_screen_mode: true },
        header: {
          title: {
            tag: 'plain_text',
            content: p('statusTitle', { status: heartbeat.status, name: monitor.name }),
          },
          template: down ? 'red' : 'green',
        },
        elements: [{ tag: 'div', text: { tag: 'lark_md', content: cardContent(heartbeat, p) } }],
      },
    })
    return OK_MESSAGE
  },
})
