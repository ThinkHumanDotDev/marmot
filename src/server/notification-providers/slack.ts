/**
 * Slack incoming-webhook provider.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/slack.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { formatHeartbeatTime, renderMessageTemplate } from '@/server/notifications/message'
import { extractAddress, OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'
import type { Heartbeat, Monitor } from '@/payload-types'

export const slackConfigSchema = z.object({
  webhookUrl: z.string().url(),
  channel: z.string().optional(),
  username: z.string().optional(),
  iconEmoji: z.string().optional(),
  richMessage: z.boolean().default(true),
  channelNotify: z.boolean().default(false),
  useTemplate: z.boolean().default(false),
  template: z.string().optional(),
})

export type SlackConfig = z.infer<typeof slackConfigSchema>

export const slackFieldMeta: Record<keyof SlackConfig, NotificationFieldMeta> = {
  webhookUrl: {
    label: 'Webhook URL',
    placeholder: 'https://hooks.slack.com/services/…',
    secret: true,
  },
  channel: { label: 'Channel name', placeholder: '#alerts' },
  username: { label: 'Username', placeholder: 'Marmot' },
  iconEmoji: { label: 'Icon emoji', placeholder: ':bell:' },
  richMessage: { label: 'Rich message (blocks)' },
  channelNotify: { label: 'Notify channel (@channel)' },
  useTemplate: { label: 'Use a custom message template' },
  template: {
    label: 'Message template',
    multiline: true,
    description: 'Supports {{ monitor.name }}, {{ heartbeat.msg }}, {{ status }}.',
  },
}

const isHttpUrl = (value: string) => /^https?:\/\//i.test(value)

function buildActions(monitor: Monitor) {
  const actions: unknown[] = []
  const address = extractAddress(monitor)
  if (isHttpUrl(address)) {
    try {
      actions.push({
        type: 'button',
        text: { type: 'plain_text', text: 'Visit site' },
        value: 'Site',
        url: new URL(address).toString(),
      })
    } catch {
      // not a URL after all
    }
  }
  return actions
}

export function buildSlackBlocks(
  monitor: Monitor,
  heartbeat: Heartbeat,
  title: string,
  msg: string,
): unknown[] {
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: title } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Message*\n${msg}` },
        { type: 'mrkdwn', text: `*Time*\n${formatHeartbeatTime(heartbeat)}` },
      ],
    },
  ]
  const actions = buildActions(monitor)
  if (actions.length > 0) blocks.push({ type: 'actions', elements: actions })
  return blocks
}

registerNotificationProvider({
  name: 'slack',
  label: 'Slack',
  group: 'chat',
  docsUrl: 'https://api.slack.com/messaging/webhooks',
  configSchema: slackConfigSchema,
  fieldMeta: slackFieldMeta,
  async send({ config: raw, message, monitor, heartbeat, locale }) {
    const config = slackConfigSchema.parse(raw)
    let msg = message
    if (config.channelNotify) msg += ' <!channel>'

    const base = {
      channel: config.channel || undefined,
      username: config.username || undefined,
      icon_emoji: config.iconEmoji || undefined,
    }

    if (!heartbeat || !monitor) {
      await postJson(config.webhookUrl, { ...base, text: msg })
      return OK_MESSAGE
    }

    if (config.useTemplate && config.template?.trim()) {
      const text = renderMessageTemplate(config.template.trim(), msg, monitor, heartbeat, locale)
      await postJson(config.webhookUrl, { ...base, text })
      return OK_MESSAGE
    }

    const title = monitor.name || 'Marmot Alert'
    const data: Record<string, unknown> = { ...base, text: msg, attachments: [] }

    if (config.richMessage) {
      data.attachments = [
        {
          color: heartbeat.status === 'up' ? '#2eb886' : '#e01e5a',
          blocks: buildSlackBlocks(monitor, heartbeat, title, msg),
        },
      ]
    } else {
      data.text = `${title}\n${msg}`
    }

    await postJson(config.webhookUrl, data)
    return OK_MESSAGE
  },
})
