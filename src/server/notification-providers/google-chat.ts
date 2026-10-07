/**
 * Google Chat (Workspace) webhook provider sending a cardsV2 message.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/google-chat.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import {
  formatHeartbeatTime,
  providerText,
  renderMessageTemplate,
} from '@/server/notifications/message'
import { extractAddress, OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const googleChatConfigSchema = z.object({
  webhookUrl: z.string().url(),
  maxRetries: z.number().int().min(1).max(10).default(1),
  useTemplate: z.boolean().default(false),
  template: z.string().optional(),
})

export type GoogleChatConfig = z.infer<typeof googleChatConfigSchema>

export const googleChatFieldMeta: Record<keyof GoogleChatConfig, NotificationFieldMeta> = {
  webhookUrl: {
    label: 'Webhook URL',
    placeholder: 'https://chat.googleapis.com/v1/spaces/…',
    secret: true,
  },
  maxRetries: {
    label: 'Max attempts on rate limit (1–10)',
    description: 'Retries with a 1–3 minute delay when Google Chat answers HTTP 429.',
  },
  useTemplate: { label: 'Use a custom message template' },
  template: {
    label: 'Message template',
    multiline: true,
    description: 'Supports {{ monitor.name }}, {{ heartbeat.msg }}, {{ status }}.',
  },
}

const defaultRateLimitDelay = () => 60_000 + Math.random() * 120_000
let rateLimitDelayMs = defaultRateLimitDelay

/** Tests override the 60–180 s back-off between rate-limited attempts. */
export function setGoogleChatRateLimitDelay(fn: (() => number) | null): void {
  rateLimitDelayMs = fn ?? defaultRateLimitDelay
}

async function postWithRetry(url: string, data: unknown, maxAttempts: number): Promise<void> {
  let attemptsLeft = maxAttempts
  for (;;) {
    try {
      await postJson(url, data)
      return
    } catch (error) {
      const rateLimited = error instanceof Error && /HTTP 429\b/.test(error.message)
      attemptsLeft--
      if (!rateLimited || attemptsLeft <= 0) throw error
      await new Promise((resolve) => setTimeout(resolve, rateLimitDelayMs()))
    }
  }
}

registerNotificationProvider({
  name: 'google-chat',
  label: 'Google Chat',
  group: 'chat',
  docsUrl: 'https://developers.google.com/workspace/chat/quickstart/webhooks',
  configSchema: googleChatConfigSchema,
  fieldMeta: googleChatFieldMeta,
  async send({ config: raw, message, monitor, heartbeat, locale }) {
    const config = googleChatConfigSchema.parse(raw)

    if (config.useTemplate && config.template?.trim()) {
      const text = renderMessageTemplate(
        config.template.trim(),
        message,
        monitor,
        heartbeat,
        locale,
      )
      await postWithRetry(config.webhookUrl, { text }, config.maxRetries)
      return OK_MESSAGE
    }

    const p = providerText(locale)
    let title = p('alert')
    if (monitor && heartbeat) {
      title =
        heartbeat.status === 'up'
          ? `✅ ${p('backOnline', { name: monitor.name })}`
          : `🔴 ${p('wentDown', { name: monitor.name })}`
    }

    const widgets: unknown[] = [
      { textParagraph: { text: `<b>${p('messageField')}:</b>\n${message}` } },
    ]
    if (heartbeat) {
      widgets.push({
        textParagraph: { text: `<b>${p('time')}:</b>\n${formatHeartbeatTime(heartbeat)}` },
      })
    }
    const address = extractAddress(monitor)
    if (address) {
      widgets.push({ textParagraph: { text: `<b>${p('address')}:</b>\n${address}` } })
    }

    await postWithRetry(
      config.webhookUrl,
      {
        fallbackText: title,
        cardsV2: [{ card: { header: { title }, sections: [{ widgets }] } }],
      },
      config.maxRetries,
    )
    return OK_MESSAGE
  },
})
