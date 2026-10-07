/**
 * Web Push provider (VAPID) using the `web-push` package.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/Webpush.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 *
 * Kuma keeps one instance-wide VAPID key pair and collects the browser subscription in its UI.
 * Marmot stores the key pair and the subscription JSON on the channel so no extra settings or
 * service worker are needed; generate keys with `npx web-push generate-vapid-keys`.
 */
import { Agent as HttpsAgent } from 'node:https'

import webpush, { type PushSubscription } from 'web-push'
import { z } from 'zod'

import {
  guardedLookup,
  literalTargetDenial,
  outboundGuardActive,
} from '@/server/security/outbound-guard'
import { OK_MESSAGE } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const webpushConfigSchema = z.object({
  subscription: z.string().min(1),
  vapidPublicKey: z.string().min(1),
  vapidPrivateKey: z.string().min(1),
  vapidSubject: z.string().min(1),
  title: z.string().optional(),
})

export type WebpushConfig = z.infer<typeof webpushConfigSchema>

export const webpushFieldMeta: Record<keyof WebpushConfig, NotificationFieldMeta> = {
  subscription: {
    label: 'Push subscription (JSON)',
    multiline: true,
    secret: true,
    placeholder: '{"endpoint":"https://…","keys":{"p256dh":"…","auth":"…"}}',
    description:
      'The PushSubscription object returned by `pushManager.subscribe()` in the browser.',
  },
  vapidPublicKey: { label: 'VAPID public key' },
  vapidPrivateKey: { label: 'VAPID private key', secret: true },
  vapidSubject: {
    label: 'VAPID subject',
    placeholder: 'mailto:ops@example.com',
    description: 'A mailto: address or https URL identifying the sender.',
  },
  title: { label: 'Notification title', placeholder: 'Marmot' },
}

export function parsePushSubscription(value: string): PushSubscription {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Push subscription is not valid JSON')
  }
  const sub = parsed as Partial<PushSubscription> | null
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw new Error('Push subscription must contain endpoint, keys.p256dh and keys.auth')
  }
  return { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }
}

registerNotificationProvider({
  name: 'webpush',
  label: 'Web Push',
  group: 'push',
  docsUrl: 'https://github.com/web-push-libs/web-push',
  configSchema: webpushConfigSchema,
  fieldMeta: webpushFieldMeta,
  async send({ config: raw, message }) {
    const config = webpushConfigSchema.parse(raw)
    const subscription = parsePushSubscription(config.subscription)
    const payload = JSON.stringify({ title: config.title || 'Marmot', body: message })

    // The endpoint comes from the subscription (user input): with the outbound address guard on,
    // literal hosts are checked here and names by the agent's lookup at connect time.
    let agent: HttpsAgent | undefined
    if (outboundGuardActive()) {
      const denial = literalTargetDenial(new URL(subscription.endpoint).hostname)
      if (denial) throw new Error(denial)
      agent = new HttpsAgent({ lookup: guardedLookup as never })
    }

    try {
      await webpush.sendNotification(subscription, payload, {
        vapidDetails: {
          subject: config.vapidSubject,
          publicKey: config.vapidPublicKey,
          privateKey: config.vapidPrivateKey,
        },
        ...(agent ? { agent } : {}),
      })
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode
      const body = (error as { body?: string }).body
      const msg = error instanceof Error ? error.message : String(error)
      throw new Error(
        status ? `Web Push failed (HTTP ${status})${body ? ` ${body.slice(0, 200)}` : ''}` : msg,
      )
    } finally {
      agent?.destroy()
    }
    return OK_MESSAGE
  },
})
