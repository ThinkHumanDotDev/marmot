/**
 * Discord webhook provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/discord.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { providerText, renderMessageTemplate } from '@/server/notifications/message'
import { extractAddress, OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'

/** This message will not trigger push and desktop notifications. */
const SUPPRESS_NOTIFICATIONS_FLAG = 1 << 12

export const discordConfigSchema = z.object({
  webhookUrl: z.string().url(),
  username: z.string().optional(),
  prefixMessage: z.string().optional(),
  messageFormat: z.enum(['normal', 'minimalist', 'custom']).default('normal'),
  messageTemplate: z.string().optional(),
  channelType: z.enum(['channel', 'createNewForumPost', 'postToThread']).default('channel'),
  threadId: z.string().optional(),
  postName: z.string().optional(),
  suppressNotifications: z.boolean().default(false),
  disableUrl: z.boolean().default(false),
})

export type DiscordConfig = z.infer<typeof discordConfigSchema>

export const discordFieldMeta: Record<keyof DiscordConfig, NotificationFieldMeta> = {
  webhookUrl: {
    label: 'Discord webhook URL',
    placeholder: 'https://discord.com/api/webhooks/…',
    description: 'Channel settings → Integrations → Webhooks.',
    secret: true,
  },
  username: { label: 'Bot display name', placeholder: 'Marmot' },
  prefixMessage: {
    label: 'Prefix custom message',
    placeholder: 'Hello @everyone …',
    description: 'Sent as plain content above the embed (use it to mention roles).',
  },
  messageFormat: {
    label: 'Message format',
    options: { normal: 'Embed', minimalist: 'Minimalist', custom: 'Custom template' },
  },
  messageTemplate: {
    template: 'text',
    label: 'Message template',
    multiline: true,
    description: 'Used when format is "Custom template". Supports {{ monitor.name }} placeholders.',
  },
  channelType: {
    label: 'Message type',
    options: {
      channel: 'Send to channel',
      createNewForumPost: 'Create new forum post',
      postToThread: 'Post to existing thread',
    },
  },
  threadId: { label: 'Thread ID', description: 'For "Post to existing thread".' },
  postName: { label: 'Forum post name', description: 'For "Create new forum post".' },
  suppressNotifications: { label: 'Suppress push notifications' },
  disableUrl: { label: 'Hide the monitor URL in messages' },
}

type DiscordPayload = {
  username: string
  content?: string
  embeds?: unknown[]
  thread_name?: string
  flags?: number
}

const unixSeconds = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)

function formatDuration(timeInSeconds: number): string {
  const hours = Math.floor(timeInSeconds / 3600)
  const minutes = Math.floor((timeInSeconds % 3600) / 60)
  const seconds = timeInSeconds % 60
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (seconds > 0 && hours === 0) parts.push(`${seconds}s`)
  return parts.length > 0 ? parts.join(' ') : '0s'
}

registerNotificationProvider({
  name: 'discord',
  label: 'Discord',
  group: 'chat',
  docsUrl: 'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks',
  configSchema: discordConfigSchema,
  fieldMeta: discordFieldMeta,
  async send(ctx) {
    const { config: raw, message, monitor, heartbeat, locale, downtimeSeconds } = ctx
    const config = discordConfigSchema.parse(raw)
    const p = providerText(locale)
    const username = config.username || 'Marmot'
    const url = new URL(config.webhookUrl)
    if (config.channelType === 'postToThread' && config.threadId) {
      url.searchParams.append('thread_id', config.threadId)
    }

    const decorate = (payload: DiscordPayload): DiscordPayload => {
      if (config.channelType === 'createNewForumPost' && config.postName) {
        payload.thread_name = config.postName
      }
      if (config.suppressNotifications) payload.flags = SUPPRESS_NOTIFICATIONS_FLAG
      return payload
    }

    // Test notifications and the lightweight formats send plain content.
    if (!heartbeat || !monitor || config.messageFormat === 'minimalist') {
      let content = message
      if (heartbeat && monitor && config.messageFormat === 'minimalist') {
        content =
          heartbeat.status === 'down'
            ? `🔴 ${p('isDownSentence', { name: monitor.name })}`
            : `🟢 ${p('isUpSentence', { name: monitor.name })}`
      } else if (config.messageFormat === 'custom' && config.messageTemplate?.trim()) {
        content = renderMessageTemplate(
          config.messageTemplate.trim(),
          message,
          monitor,
          heartbeat,
          locale,
          ctx,
        )
      }
      await postJson(url.toString(), decorate({ username, content }))
      return OK_MESSAGE
    }

    if (config.messageFormat === 'custom' && config.messageTemplate?.trim()) {
      const content = renderMessageTemplate(
        config.messageTemplate.trim(),
        message,
        monitor,
        heartbeat,
        locale,
        ctx,
      )
      await postJson(url.toString(), decorate({ username, content }))
      return OK_MESSAGE
    }

    const address = extractAddress(monitor)
    const addressField =
      !config.disableUrl && address
        ? [{ name: monitor.type === 'push' ? p('serviceType') : p('serviceUrl'), value: address }]
        : []

    let payload: DiscordPayload
    if (heartbeat.status === 'down') {
      payload = {
        username,
        embeds: [
          {
            title: `❌ ${p('yourServiceDown', { name: monitor.name })} ❌`,
            color: 16711680,
            timestamp: heartbeat.time,
            fields: [
              { name: p('serviceName'), value: monitor.name },
              ...addressField,
              { name: p('wentOffline'), value: `<t:${unixSeconds(heartbeat.time)}:F>` },
              { name: p('error'), value: heartbeat.msg || 'N/A' },
            ],
          },
        ],
      }
    } else {
      // The measured outage (#126) when the dispatcher knows it, else Kuma's beat duration.
      const downtime =
        downtimeSeconds != null && downtimeSeconds > 0
          ? Math.round(downtimeSeconds)
          : typeof heartbeat.duration === 'number' && heartbeat.duration > 0
            ? heartbeat.duration
            : null
      payload = {
        username,
        embeds: [
          {
            title: `✅ ${p('yourServiceUp', { name: monitor.name })} ✅`,
            color: 65280,
            timestamp: heartbeat.time,
            fields: [
              { name: p('serviceName'), value: monitor.name },
              ...addressField,
              ...(downtime
                ? [{ name: p('downtimeDuration'), value: formatDuration(downtime) }]
                : []),
              { name: p('time'), value: `<t:${unixSeconds(heartbeat.time)}:F>` },
              ...(heartbeat.ping != null
                ? [{ name: p('ping'), value: `${heartbeat.ping} ms` }]
                : []),
            ],
          },
        ],
      }
    }
    if (config.prefixMessage) payload.content = config.prefixMessage

    await postJson(url.toString(), decorate(payload))
    return OK_MESSAGE
  },
})
