/**
 * Microsoft Teams (Power Automate / incoming webhook) provider sending an Adaptive Card.
 * Ported from Uptime Kuma 2.5.5 `server/notification-providers/teams.js` (MIT, Louis Lam).
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from 'zod'

import { formatHeartbeatTime } from '@/server/notifications/message'
import { extractAddress, OK_MESSAGE, postJson } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta } from './types'
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

const statusMessage = (status: Status, monitorName: string | undefined, withSymbol: boolean) => {
  if (status === 'down') return `${withSymbol ? '🔴 ' : ''}[${monitorName}] went down`
  if (status === 'up') return `${withSymbol ? '✅ ' : ''}[${monitorName}] is back online`
  return 'Notification'
}

const styleFor = (status: Status) =>
  status === 'down' ? 'attention' : status === 'up' ? 'good' : 'emphasis'

export function buildTeamsPayload({
  monitor,
  heartbeat,
  message,
}: {
  monitor: Monitor | null
  heartbeat: Heartbeat | null
  message: string
}) {
  const monitorUrl = extractAddress(monitor)
  const monitorName = monitor?.name
  const status = heartbeat?.status
  const facts: { title: string; value: string }[] = []
  const actions: unknown[] = []

  const description = heartbeat ? heartbeat.msg || message : message
  if (description) facts.push({ title: 'Description', value: description })
  if (monitorName) facts.push({ title: 'Monitor', value: monitorName })
  if (monitorUrl && monitorUrl !== 'https://') {
    facts.push({ title: 'URL', value: `[${monitorUrl}](${monitorUrl})` })
    actions.push({ type: 'Action.OpenUrl', title: 'Visit Monitor URL', url: monitorUrl })
  }
  const time = formatHeartbeatTime(heartbeat)
  if (time) facts.push({ title: 'Time', value: time })

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
                  text: `**${statusMessage(status, monitorName, false)}**`,
                },
                {
                  type: 'TextBlock',
                  size: 'Small',
                  weight: 'Default',
                  text: 'Marmot Alert',
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
    summary: statusMessage(status, monitorName, true),
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
  async send({ config: raw, message, monitor, heartbeat }) {
    const config = teamsConfigSchema.parse(raw)
    await postJson(config.webhookUrl, buildTeamsPayload({ monitor, heartbeat, message }))
    return OK_MESSAGE
  },
})
