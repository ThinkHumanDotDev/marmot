/**
 * "Slack (app)" channel (#129): posts alerts with the organization's installed Slack app
 * (`chat.postMessage` with the bot token) instead of an incoming webhook, so the messages carry
 * interactive buttons: **Acknowledge** the monitor's open incident (#100) and **Check now** (#98).
 * Clicks arrive at `/api/slack/interactions` and only work for Slack users linked to a member with
 * the matching permission. Offered only when the Slack app is configured (`SLACK_*` variables).
 */
import { z } from 'zod'

import { supportsCheckNow } from '@/lib/on-demand-check'
import { isRemoteMonitor } from '@/lib/probe-locations'
import { SLACK_ACTIONS } from '@/lib/slack-app'
import { formatHeartbeatTime, providerText } from '@/server/notifications/message'
import { absoluteUrl, isSlackAppEnabled } from '@/server/slack/config'

import { OK_MESSAGE } from './http'
import { registerNotificationProvider } from './registry'
import type { NotificationFieldMeta, NotificationSendContext } from './types'

export const slackAppConfigSchema = z.object({
  channel: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^(#?[a-z0-9][a-z0-9._-]*|[A-Z0-9]{2,32})$/),
  channelNotify: z.boolean().default(false),
})

export type SlackAppConfig = z.infer<typeof slackAppConfigSchema>

export const slackAppFieldMeta: Record<keyof SlackAppConfig, NotificationFieldMeta> = {
  channel: {
    label: 'Channel',
    placeholder: '#alerts',
    description:
      'Channel name or ID. Private channels need the app invited first (/invite @Marmot).',
  },
  channelNotify: { label: 'Notify channel (@channel)' },
}

/** Block Kit message of an alert (exported for tests). */
export function buildSlackAppMessage(
  ctx: Pick<
    NotificationSendContext,
    'message' | 'monitor' | 'heartbeat' | 'locale' | 'organization' | 'incidentId'
  >,
  channelNotify = false,
): { text: string; blocks: unknown[] } {
  const p = providerText(ctx.locale)
  const { monitor, heartbeat } = ctx
  const text = ctx.message
  const body = `${escape(ctx.message).slice(0, 2900)}${channelNotify ? ' <!channel>' : ''}`
  if (!monitor || !heartbeat) {
    return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: body } }] }
  }
  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: (monitor.name || p('alert')).slice(0, 150), emoji: true },
    },
    { type: 'section', text: { type: 'mrkdwn', text: body } },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*${p('time')}:* ${formatHeartbeatTime(heartbeat)}` }],
    },
  ]
  const actions: unknown[] = []
  if (ctx.incidentId !== null && ctx.incidentId !== undefined) {
    actions.push({
      type: 'button',
      action_id: SLACK_ACTIONS.acknowledge,
      style: 'primary',
      text: { type: 'plain_text', text: p('acknowledge') },
      value: String(ctx.incidentId),
    })
  }
  if (monitor.active !== false && supportsCheckNow(monitor.type) && !isRemoteMonitor(monitor)) {
    actions.push({
      type: 'button',
      action_id: SLACK_ACTIONS.checkNow,
      text: { type: 'plain_text', text: p('checkNow') },
      value: String(monitor.id),
    })
  }
  if (ctx.organization?.slug) {
    actions.push({
      type: 'button',
      action_id: 'marmot_open',
      text: { type: 'plain_text', text: p('openInMarmot') },
      url: absoluteUrl(`/${ctx.organization.slug}/monitors/${monitor.id}`),
    })
  }
  if (actions.length > 0) blocks.push({ type: 'actions', elements: actions })
  return { text, blocks }
}

/** Slack's three control characters in user text. */
const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

registerNotificationProvider({
  name: 'slack-app',
  label: 'Slack (app)',
  group: 'chat',
  docsUrl: 'https://github.com/ThinkHumanDotDev/marmot/wiki/Slack-App',
  configSchema: slackAppConfigSchema,
  fieldMeta: slackAppFieldMeta,
  available: isSlackAppEnabled,
  async send(ctx) {
    const config = slackAppConfigSchema.parse(ctx.config)
    if (!isSlackAppEnabled()) throw new Error('The Slack app is not configured on this instance')
    // Lazy: the installation lookup needs Payload, which the provider registry must not import.
    const { postSlackAppAlert } = await import('@/server/slack/alerts')
    await postSlackAppAlert(ctx.organizationId ?? null, config.channel, {
      ...buildSlackAppMessage(ctx, config.channelNotify),
    })
    return OK_MESSAGE
  },
})
