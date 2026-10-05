/**
 * DingTalk (DingDing) custom-robot provider with signed webhooks.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/dingding.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { createHmac } from 'node:crypto'
import { z } from 'zod'

import { formatHeartbeatTime } from '@/server/notifications/message'
import { httpRequest, OK_MESSAGE } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const dingdingConfigSchema = z.object({
  webhookUrl: z.string().url(),
  secretKey: z.string().min(1),
  mentioning: z.enum(['nobody', 'everyone', 'specify-mobiles', 'specify-users']).default('nobody'),
  mobileList: z.string().optional(),
  userList: z.string().optional(),
})

export type DingdingConfig = z.infer<typeof dingdingConfigSchema>

export const dingdingFieldMeta: Record<keyof DingdingConfig, NotificationFieldMeta> = {
  webhookUrl: {
    label: 'Webhook URL',
    secret: true,
    placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=…',
  },
  secretKey: { label: 'Signing secret', secret: true, description: 'Robot security → Sign.' },
  mentioning: {
    label: 'Mention',
    options: {
      nobody: "Don't mention people",
      everyone: 'Mention @everyone',
      'specify-mobiles': 'Mention mobile numbers',
      'specify-users': 'Mention user IDs',
    },
  },
  mobileList: { label: 'Mobile numbers', description: 'Comma-separated.' },
  userList: { label: 'User IDs', description: 'Comma-separated.' },
}

/** `base64(hmac_sha256(secret, "<timestamp>\n<secret>"))` as DingTalk requires. */
export function signDingding(timestamp: number, secretKey: string): string {
  return createHmac('sha256', Buffer.from(secretKey, 'utf8'))
    .update(Buffer.from(`${timestamp}\n${secretKey}`, 'utf8'))
    .digest('base64')
}

const splitList = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)

const statusToString = (status: string) =>
  status === 'down' || status === 'up' ? status.toUpperCase() : status

registerNotificationProvider({
  name: 'dingding',
  label: 'DingTalk',
  group: 'chat',
  docsUrl: 'https://open.dingtalk.com/document/robots/custom-robot-access',
  configSchema: dingdingConfigSchema,
  fieldMeta: dingdingFieldMeta,
  async send({ config: raw, message, monitor, heartbeat }) {
    const config = dingdingConfigSchema.parse(raw)
    const mentionAll = config.mentioning === 'everyone'
    const mobileList = config.mentioning === 'specify-mobiles' ? splitList(config.mobileList) : []
    const userList = config.mentioning === 'specify-users' ? splitList(config.userList) : []
    const finalList = [...mobileList, ...userList]
    const mentionStr =
      finalList.length > 0 ? `\n${finalList.map((item) => `@${item}`).join(' ')}` : ''
    const at = { isAtAll: mentionAll, atUserIds: userList, atMobiles: mobileList }

    let params: Record<string, unknown>
    if (heartbeat && monitor) {
      const status = statusToString(heartbeat.status)
      params = {
        msgtype: 'markdown',
        markdown: {
          title: `[${status}] ${monitor.name}`,
          text: `## [${status}] ${monitor.name} \n> ${heartbeat.msg ?? ''}\n> Time: ${formatHeartbeatTime(heartbeat)}${mentionStr}`,
        },
        at,
      }
    } else {
      params = { msgtype: 'text', text: { content: `${message}${mentionStr}` }, at }
    }

    const timestamp = Date.now()
    const sign = encodeURIComponent(signDingding(timestamp, config.secretKey))
    const response = await httpRequest(`${config.webhookUrl}&timestamp=${timestamp}&sign=${sign}`, {
      method: 'POST',
      json: params,
    })
    let data: { errmsg?: string } = {}
    try {
      data = (await response.json()) as { errmsg?: string }
    } catch {
      throw new Error('DingTalk returned an unreadable response')
    }
    if (data.errmsg !== 'ok') throw new Error(data.errmsg || 'Unknown DingTalk error')
    return OK_MESSAGE
  },
})
