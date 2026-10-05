/**
 * Twilio SMS provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/twilio.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { httpRequest, OK_MESSAGE } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const twilioConfigSchema = z.object({
  accountSid: z.string().min(1),
  apiKey: z.string().optional(),
  authToken: z.string().min(1),
  fromNumber: z.string().min(1),
  toNumber: z.string().min(1),
  messagingServiceSid: z.string().optional(),
})

export type TwilioConfig = z.infer<typeof twilioConfigSchema>

export const twilioFieldMeta: Record<keyof TwilioConfig, NotificationFieldMeta> = {
  accountSid: { label: 'Account SID', placeholder: 'AC…' },
  apiKey: {
    label: 'API key SID',
    description: 'Optional: authenticate with an API key instead of the account SID.',
  },
  authToken: { label: 'Auth token (or API key secret)', secret: true },
  fromNumber: { label: 'From number', placeholder: '+15005550006' },
  toNumber: { label: 'To number', placeholder: '+15005550007' },
  messagingServiceSid: { label: 'Messaging service SID', placeholder: 'MG…' },
}

registerNotificationProvider({
  name: 'twilio',
  label: 'Twilio SMS',
  group: 'generic',
  docsUrl: 'https://www.twilio.com/docs/messaging/api/message-resource',
  configSchema: twilioConfigSchema,
  fieldMeta: twilioFieldMeta,
  async send({ config: raw, message }) {
    const config = twilioConfigSchema.parse(raw)
    const user = config.apiKey || config.accountSid
    const body = new URLSearchParams()
    body.append('To', config.toNumber)
    body.append('From', config.fromNumber)
    body.append('Body', message)
    if (config.messagingServiceSid) body.append('MessagingServiceSid', config.messagingServiceSid)

    await httpRequest(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
          Authorization: `Basic ${Buffer.from(`${user}:${config.authToken}`).toString('base64')}`,
        },
        rawBody: body.toString(),
      },
    )
    return OK_MESSAGE
  },
})
