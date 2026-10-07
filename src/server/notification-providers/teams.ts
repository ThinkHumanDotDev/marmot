/**
 * Microsoft Teams (Power Automate / incoming webhook) provider sending an Adaptive Card.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/teams.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { formatHeartbeatTime, providerText } from '@/server/notifications/message'
import { extractAddress, OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'
import type { Locale } from '@/i18n/locales'
import type { Heartbeat, Monitor } from '@/payload-types'

export const teamsConfigSchema = z.object({
  webhookUrl: z.string().url(),
})

export type TeamsConfig = z.infer<typeof teamsConfigSchema>

export const teamsFieldMeta: Record<keyof TeamsConfig, NotificationFieldMeta> = {
  webhookUrl: {
    label: 'Webhook URL',
    secret: true,
    description:
      'Power Automate "When a Teams webhook request is received" URL, or a legacy incoming webhook.',
  },
}

type Status = Heartbeat['status'] | undefined

const statusMessage = (
  status: Status,
  monitorName: string | undefined,
  withSymbol: boolean,
  p: ReturnType<typeof providerText>,
) => {
  if (status === 'down')
    return `${withSymbol ? '🔴 ' : ''}${p('wentDown', { name: `[${monitorName}]` })}`
  if (status === 'up')
    return `${withSymbol ? '✅ ' : ''}${p('backOnline', { name: `[${monitorName}]` })}`
  return p('notification')
}

const styleFor = (status: Status) =>
  status === 'down' ? 'attention' : status === 'up' ? 'good' : 'emphasis'

export function buildTeamsPayload({
  monitor,
  heartbeat,
  message,
  locale,
}: {
  monitor: Monitor | null
  heartbeat: Heartbeat | null
  message: string
  /** Language of the card's headings (`notifications.messages.providers.*`); English by default. */
  locale?: Locale
}) {
  const p = providerText(locale)
  const monitorUrl = extractAddress(monitor)
  const monitorName = monitor?.name
  const status = heartbeat?.status
  const facts: { title: string; value: string }[] = []
  const actions: unknown[] = []

  const description = heartbeat ? heartbeat.msg || message : message
  if (description) facts.push({ title: p('description'), value: description })
  if (monitorName) facts.push({ title: p('monitor'), value: monitorName })
  if (monitorUrl && monitorUrl !== 'https://') {
    facts.push({ title: 'URL', value: `[${monitorUrl}](${monitorUrl})` })
    actions.push({ type: 'Action.OpenUrl', title: p('visitMonitorUrl'), url: monitorUrl })
  }
  const time = formatHeartbeatTime(heartbeat)
  if (time) facts.push({ title: p('time'), value: time })

  const body: unknown[] = [
    {
      type: 'Container',
      verticalContentAlignment: 'Center',
      items: [
        {
          type: 'ColumnSet',
          style: styleFor(status),
          columns: [
            {
              type: 'Column',
              width: 'stretch',
              items: [
                {
                  type: 'TextBlock',
                  size: 'Medium',
                  weight: 'Bolder',
                  text: `**${statusMessage(status, monitorName, false, p)}**`,
                },
                {
                  type: 'TextBlock',
                  size: 'Small',
                  weight: 'Default',
                  text: p('alert'),
                  isSubtle: true,
                  spacing: 'None',
                },
              ],
            },
          ],
        },
      ],
    },
    { type: 'FactSet', separator: false, facts },
  ]
  if (actions.length > 0) body.push({ type: 'ActionSet', actions })

  return {
    type: 'message',
    summary: statusMessage(status, monitorName, true, p),
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: '',
        content: {
          type: 'AdaptiveCard',
          body,
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          version: '1.5',
        },
      },
    ],
  }
}

registerNotificationProvider({
  name: 'teams',
  label: 'Microsoft Teams',
  group: 'chat',
  docsUrl:
    'https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook',
  configSchema: teamsConfigSchema,
  fieldMeta: teamsFieldMeta,
  async send({ config: raw, message, monitor, heartbeat, locale }) {
    const config = teamsConfigSchema.parse(raw)
    await postJson(config.webhookUrl, buildTeamsPayload({ monitor, heartbeat, message, locale }))
    return OK_MESSAGE
  },
})
