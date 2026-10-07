/**
 * ServerChan (Server酱) provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/serverchan.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { providerText } from '@/server/notifications/message'
import { OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const serverchanConfigSchema = z.object({
  sendKey: z.string().min(1),
})

export type ServerchanConfig = z.infer<typeof serverchanConfigSchema>

export const serverchanFieldMeta: Record<keyof ServerchanConfig, NotificationFieldMeta> = {
  sendKey: {
    label: 'SendKey',
    secret: true,
    description: 'ServerChan 3 keys (sctp…) are sent through ft07.com automatically.',
  },
}

/** ServerChan 3 keys look like `sctp<uid>t…` and must go through the per-user ft07.com host. */
export function serverchanUrl(sendKey: string): string {
  const match = sendKey.match(/^sctp(\d+)t/i)
  const key = encodeURIComponent(sendKey)
  return match?.[1]
    ? `https://${match[1]}.push.ft07.com/send/${key}.send`
    : `https://sctapi.ftqq.com/${key}.send`
}

registerNotificationProvider({
  name: 'serverchan',
  label: 'ServerChan',
  group: 'push',
  docsUrl: 'https://sct.ftqq.com/',
  configSchema: serverchanConfigSchema,
  fieldMeta: serverchanFieldMeta,
  async send({ config: raw, message, monitor, heartbeat, locale }) {
    const config = serverchanConfigSchema.parse(raw)
    const p = providerText(locale)
    let title = p('message')
    if (monitor && heartbeat?.status === 'up') title = p('monitorUpNamed', { name: monitor.name })
    else if (monitor && heartbeat?.status === 'down') {
      title = p('monitorDownNamed', { name: monitor.name })
    }

    await postJson(serverchanUrl(config.sendKey), { title, desp: message })
    return OK_MESSAGE
  },
})
