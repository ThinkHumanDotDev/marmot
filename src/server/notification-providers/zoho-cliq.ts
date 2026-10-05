/**
 * Zoho Cliq incoming-webhook provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/zoho-cliq.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { extractAddress, OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'
import type { Heartbeat } from '@/payload-types'

export const zohoCliqConfigSchema = z.object({
  webhookUrl: z.string().url(),
})

export type ZohoCliqConfig = z.infer<typeof zohoCliqConfigSchema>

export const zohoCliqFieldMeta: Record<keyof ZohoCliqConfig, NotificationFieldMeta> = {
  webhookUrl: {
    label: 'Webhook URL',
    secret: true,
    placeholder: 'https://cliq.zoho.com/api/v2/channelsbyname/…/message?zapikey=…',
  },
}

const statusLine = (status: Heartbeat['status'] | undefined, monitorName: string | undefined) => {
  if (status === 'down') return `🔴 [${monitorName}] went down\n`
  if (status === 'up') return `### ✅ [${monitorName}] is back online\n`
  return 'Notification\n'
}

registerNotificationProvider({
  name: 'zoho-cliq',
  label: 'Zoho Cliq',
  group: 'chat',
  docsUrl: 'https://www.zoho.com/cliq/help/platform/webhook-tokens.html',
  configSchema: zohoCliqConfigSchema,
  fieldMeta: zohoCliqFieldMeta,
  async send({ config: raw, message, monitor, heartbeat }) {
    const config = zohoCliqConfigSchema.parse(raw)
    const lines = [statusLine(heartbeat?.status, monitor?.name)]
    lines.push(`*Description:* ${heartbeat ? heartbeat.msg || message : message}`)
    const address = extractAddress(monitor)
    if (heartbeat && address && address !== 'https://') lines.push(`*URL:* ${address}`)

    await postJson(config.webhookUrl, { text: lines.join('\n') })
    return OK_MESSAGE
  },
})
