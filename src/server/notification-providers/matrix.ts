/**
 * Matrix provider (client-server API, `m.room.message`).
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/matrix.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { randomBytes } from 'node:crypto'
import { z } from 'zod'

import { renderMessageTemplate } from '@/server/notifications/message'
import { httpRequest, OK_MESSAGE, trimSlash } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const matrixConfigSchema = z.object({
  homeserverUrl: z.string().url(),
  internalRoomId: z.string().min(1),
  accessToken: z.string().min(1),
  useTemplate: z.boolean().default(false),
  template: z.string().optional(),
})

export type MatrixConfig = z.infer<typeof matrixConfigSchema>

export const matrixFieldMeta: Record<keyof MatrixConfig, NotificationFieldMeta> = {
  homeserverUrl: { label: 'Homeserver URL', placeholder: 'https://matrix.example.org' },
  internalRoomId: {
    label: 'Internal room ID',
    placeholder: '!abc123:example.org',
    description: 'Room settings → Advanced → Internal room ID.',
  },
  accessToken: {
    label: 'Access token',
    secret: true,
    description: 'Log in with a dedicated bot user and copy its access token.',
  },
  useTemplate: { label: 'Use a custom message template' },
  template: { label: 'Message template', multiline: true },
}

registerNotificationProvider({
  name: 'matrix',
  label: 'Matrix',
  group: 'chat',
  docsUrl: 'https://spec.matrix.org/latest/client-server-api/#mroommessage',
  configSchema: matrixConfigSchema,
  fieldMeta: matrixFieldMeta,
  async send({ config: raw, message, monitor, heartbeat, locale }) {
    const config = matrixConfigSchema.parse(raw)
    const size = 20
    const txnId = encodeURIComponent(randomBytes(size).toString('base64').slice(0, size))
    const roomId = encodeURIComponent(config.internalRoomId)

    const body =
      config.useTemplate && config.template?.trim()
        ? renderMessageTemplate(config.template.trim(), message, monitor, heartbeat, locale)
        : message

    await httpRequest(
      `${trimSlash(config.homeserverUrl)}/_matrix/client/r0/rooms/${roomId}/send/m.room.message/${txnId}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${config.accessToken}` },
        json: { msgtype: 'm.text', body },
      },
    )
    return OK_MESSAGE
  },
})
