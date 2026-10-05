/**
 * ClickSend SMS provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/clicksendsms.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { httpRequest, OK_MESSAGE } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const CLICKSEND_API_URL = 'https://rest.clicksend.com/v3/sms/send'

export const clicksendConfigSchema = z.object({
  login: z.string().min(1),
  password: z.string().min(1),
  toNumber: z.string().min(1),
  senderName: z.string().optional(),
})

export type ClicksendConfig = z.infer<typeof clicksendConfigSchema>

export const clicksendFieldMeta: Record<keyof ClicksendConfig, NotificationFieldMeta> = {
  login: { label: 'API username' },
  password: { label: 'API key', secret: true },
  toNumber: { label: 'Recipient number', placeholder: '+61411111111' },
  senderName: {
    label: 'Sender name / number',
    description: 'Optional dedicated number or approved alphanumeric sender id.',
  },
}

type ClicksendResponse = { data?: { messages?: { status?: string }[] } }

registerNotificationProvider({
  name: 'clicksend',
  label: 'ClickSend SMS',
  group: 'generic',
  docsUrl: 'https://developers.clicksend.com/docs/rest/v3/#send-sms',
  configSchema: clicksendConfigSchema,
  fieldMeta: clicksendFieldMeta,
  async send({ config: raw, message }) {
    const config = clicksendConfigSchema.parse(raw)
    const response = await httpRequest(CLICKSEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.login}:${config.password}`).toString('base64')}`,
        Accept: 'text/json',
      },
      json: {
        messages: [
          {
            // SMS is GSM-7/ASCII only; strip emoji and other non-ASCII characters like Kuma does.
            body: message.replace(/[^\x00-\x7F]/g, ''),
            to: config.toNumber,
            source: 'marmot',
            ...(config.senderName ? { from: config.senderName } : {}),
          },
        ],
      },
    })

    let data: ClicksendResponse = {}
    try {
      data = (await response.json()) as ClicksendResponse
    } catch {
      // ClickSend always answers JSON; treat an unreadable body as success since HTTP was 2xx.
    }
    const status = data.data?.messages?.[0]?.status
    if (status && status !== 'SUCCESS') {
      throw new Error(`ClickSend rejected the message: ${status}`)
    }
    return OK_MESSAGE
  },
})
