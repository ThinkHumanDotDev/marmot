/**
 * Slack app (#129): names shared by the server (slash command, interactivity, delivery) and the
 * settings UI. Free of Node-only imports.
 */

/** Bot scopes the app asks for: the slash command, posting messages and posting to public channels. */
export const SLACK_BOT_SCOPES = ['commands', 'chat:write', 'chat:write.public'] as const

/** The slash command the manifest registers. */
export const SLACK_COMMAND = '/marmot'

/** `action_id`s of the interactive buttons on alert messages. */
export const SLACK_ACTIONS = {
  acknowledge: 'marmot_ack',
  checkNow: 'marmot_check_now',
} as const

/** `callback_id` of the incident modal. */
export const SLACK_INCIDENT_MODAL = 'marmot_incident'

/** What `/marmot incident <mode>` does. */
export const SLACK_INCIDENT_MODES = ['create', 'update', 'resolve'] as const
export type SlackIncidentMode = (typeof SLACK_INCIDENT_MODES)[number]

/**
 * Subscriber target of a channel subscribed through the Slack app: `slack://<team id>/<channel id>`.
 * Plain Slack subscribers keep an incoming-webhook URL; only the slash command creates these.
 */
const APP_TARGET = /^slack:\/\/([A-Z0-9]{2,32})\/([A-Z0-9]{2,32})$/

export const slackAppTarget = (teamId: string, channelId: string): string =>
  `slack://${teamId}/${channelId}`

export function parseSlackAppTarget(
  target: string | null | undefined,
): { teamId: string; channelId: string } | null {
  const match = APP_TARGET.exec(target ?? '')
  return match ? { teamId: match[1]!, channelId: match[2]! } : null
}

export const isSlackAppTarget = (target: string | null | undefined): boolean =>
  parseSlackAppTarget(target) !== null

/** Slack ids (team, user, channel): upper-case letters and digits. */
export const isSlackId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z0-9]{2,32}$/.test(value)

/** A linked Slack user as Settings → Integrations shows it. */
export interface SlackLinkRow {
  id: string
  slackUserId: string
  user: { id: string; name: string; email: string } | null
  createdAt: string
}

/** The organization's installation as Settings → Integrations shows it (never the token). */
export interface SlackInstallationRow {
  id: string
  teamId: string
  teamName: string
  scopes: string[]
  installedBy: { id: string; name: string } | null
  createdAt: string
  links: SlackLinkRow[]
}

export interface SlackSettings {
  /** All three `SLACK_*` variables are set. */
  enabled: boolean
  installation: SlackInstallationRow | null
}
