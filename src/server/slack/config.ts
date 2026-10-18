/**
 * Slack app configuration (#129). The app is off unless `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and
 * `SLACK_SIGNING_SECRET` are all set: the routes under `/api/slack` and `/api/orgs/:orgId/slack`
 * answer 404, Settings → Integrations hides the card and the "Slack (app)" channel type is not
 * offered.
 */
import { env } from '@/env'

export interface SlackAppConfig {
  clientId: string
  clientSecret: string
  signingSecret: string
}

/** The app's credentials, or `null` when the Slack app is disabled. */
export function slackAppConfig(): SlackAppConfig | null {
  const clientId = env.SLACK_CLIENT_ID
  const clientSecret = env.SLACK_CLIENT_SECRET
  const signingSecret = env.SLACK_SIGNING_SECRET
  if (!clientId || !clientSecret || !signingSecret) return null
  return { clientId, clientSecret, signingSecret }
}

export const isSlackAppEnabled = (): boolean => slackAppConfig() !== null

const serverUrl = () => env.NEXT_PUBLIC_SERVER_URL.replace(/\/+$/, '')

/** Where Slack sends the browser back after the install (the manifest's redirect URL). */
export const slackRedirectUri = (): string => `${serverUrl()}/api/slack/oauth/callback`

/** Absolute URL on this instance. */
export const absoluteUrl = (path: string): string => `${serverUrl()}${path}`

/** 404 for every Slack route while the app is disabled. */
export const slackDisabledResponse = (): Response =>
  Response.json({ error: 'Not found' }, { status: 404 })
