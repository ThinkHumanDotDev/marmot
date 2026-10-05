/**
 * Telegram bot provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/telegram.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { renderMessageTemplate } from '@/server/notifications/message'
import { OK_MESSAGE, postJson, trimSlash } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

export const telegramConfigSchema = z.object({
  botToken: z.string().min(1),
  chatId: z.string().min(1),
  messageThreadId: z.string().optional(),
  serverUrl: z.string().url().default('https://api.telegram.org'),
  sendSilently: z.boolean().default(false),
  protectContent: z.boolean().default(false),
  useTemplate: z.boolean().default(false),
  template: z.string().optional(),
  templateParseMode: z.enum(['plain', 'HTML', 'MarkdownV2']).default('plain'),
})

export type TelegramConfig = z.infer<typeof telegramConfigSchema>

export const telegramFieldMeta: Record<keyof TelegramConfig, NotificationFieldMeta> = {
  botToken: {
    label: 'Bot token',
    secret: true,
    description: 'From @BotFather.',
    placeholder: '123456:ABC-DEF…',
  },
  chatId: {
    label: 'Chat ID',
    description:
      'Send a message to the bot, then open https://api.telegram.org/bot<token>/getUpdates.',
  },
  messageThreadId: {
    label: 'Message thread ID',
    description: 'Optional: topic id inside a forum supergroup.',
  },
  serverUrl: { label: 'API server URL', description: 'Change only for a local Bot API server.' },
  sendSilently: {
    label: 'Send silently',
    description: 'Users receive a notification with no sound.',
  },
  protectContent: { label: 'Protect content', description: 'Prevent forwarding and saving.' },
  useTemplate: { label: 'Use a custom message template' },
  template: { label: 'Message template', multiline: true },
  templateParseMode: {
    label: 'Template parse mode',
    options: { plain: 'Plain text', HTML: 'HTML', MarkdownV2: 'MarkdownV2' },
  },
}

/** Escapes special characters for Telegram MarkdownV2 format. */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~>#+\-=|{}.!\\]/g, '\\$&')
}

registerNotificationProvider({
  name: 'telegram',
  label: 'Telegram',
  group: 'chat',
  docsUrl: 'https://core.telegram.org/bots#how-do-i-create-a-bot',
  configSchema: telegramConfigSchema,
  fieldMeta: telegramFieldMeta,
  async send({ config: raw, message, monitor, heartbeat }) {
    const config = telegramConfigSchema.parse(raw)
    const params: Record<string, unknown> = {
      chat_id: config.chatId,
      text: message,
      disable_notification: config.sendSilently,
      protect_content: config.protectContent,
      link_preview_options: { is_disabled: true },
    }
    if (config.messageThreadId) params.message_thread_id = config.messageThreadId

    if (config.useTemplate && config.template?.trim()) {
      let msg = message
      let monitorForTemplate = monitor
      let heartbeatForTemplate = heartbeat
      if (config.templateParseMode === 'MarkdownV2') {
        msg = escapeMarkdownV2(msg)
        if (monitorForTemplate) {
          monitorForTemplate = {
            ...monitorForTemplate,
            name: escapeMarkdownV2(monitorForTemplate.name),
            url: monitorForTemplate.url ? escapeMarkdownV2(monitorForTemplate.url) : null,
            hostname: monitorForTemplate.hostname
              ? escapeMarkdownV2(monitorForTemplate.hostname)
              : null,
          }
        }
        if (heartbeatForTemplate) {
          heartbeatForTemplate = {
            ...heartbeatForTemplate,
            msg: heartbeatForTemplate.msg ? escapeMarkdownV2(heartbeatForTemplate.msg) : null,
          }
        }
      }
      params.text = renderMessageTemplate(
        config.template.trim(),
        msg,
        monitorForTemplate,
        heartbeatForTemplate,
      )
      if (config.templateParseMode !== 'plain') params.parse_mode = config.templateParseMode
    }

    await postJson(`${trimSlash(config.serverUrl)}/bot${config.botToken}/sendMessage`, params)
    return OK_MESSAGE
  },
})
