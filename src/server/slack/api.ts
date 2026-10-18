/**
 * Minimal Slack Web API client (#129): the handful of methods the app uses, over `fetch` so tests
 * stub `globalThis.fetch`. Slack answers HTTP 200 with `{ ok: false, error }` for most failures;
 * those become a `SlackApiError` carrying the error code (`channel_not_found`, `invalid_auth`, …).
 * Request shapes follow https://api.slack.com/methods (and the published `@slack/web-api` types).
 */
import { childLogger } from '@/lib/logger'

const log = childLogger('slack:api')

export const SLACK_API_BASE = 'https://slack.com/api'

/** Requests to Slack give up after this long. */
export const SLACK_API_TIMEOUT_MS = 5_000

export class SlackApiError extends Error {
  /** Slack's error code, `http_<status>` for HTTP errors, or `network`. */
  readonly code: string
  /** HTTP status when Slack answered with one other than 200. */
  readonly status: number | null
  constructor(code: string, status: number | null = null) {
    super(`Slack API error: ${code}`)
    this.name = 'SlackApiError'
    this.code = code
    this.status = status
  }
}

/** Errors that a retry cannot fix (the channel, the token or the app is gone). */
const PERMANENT = new Set([
  'channel_not_found',
  'not_in_channel',
  'is_archived',
  'invalid_auth',
  'not_authed',
  'account_inactive',
  'token_revoked',
  'token_expired',
  'no_permission',
  'missing_scope',
  'restricted_action',
  'team_access_not_granted',
  'org_login_required',
  'ekm_access_denied',
  'invalid_blocks',
  'msg_too_long',
])

export const isPermanentSlackError = (error: SlackApiError): boolean =>
  PERMANENT.has(error.code) ||
  (error.status !== null && error.status >= 400 && error.status < 500 && error.status !== 429)

type SlackResponse = { ok?: boolean; error?: string } & Record<string, unknown>

async function call(
  method: string,
  init: { headers: Record<string, string>; body: string },
): Promise<SlackResponse> {
  let response: Response
  try {
    response = await fetch(`${SLACK_API_BASE}/${method}`, {
      method: 'POST',
      headers: init.headers,
      body: init.body,
      redirect: 'error',
      signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
    })
  } catch (err) {
    log.warn(
      { method, err: err instanceof Error ? err.message : String(err) },
      'slack request failed',
    )
    throw new SlackApiError('network')
  }
  if (response.status === 429) throw new SlackApiError('ratelimited', 429)
  if (!response.ok) throw new SlackApiError(`http_${response.status}`, response.status)
  const data = (await response.json().catch(() => null)) as SlackResponse | null
  if (!data || data.ok !== true) throw new SlackApiError(data?.error ?? 'invalid_response')
  return data
}

/** A bot-token method with a JSON body (`chat.postMessage`, `views.open`, …). */
export function slackApi<T extends Record<string, unknown> = SlackResponse>(
  method: string,
  token: string,
  body: Record<string, unknown>,
): Promise<T> {
  return call(method, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  }) as Promise<T>
}

export interface SlackOAuthAccess {
  access_token: string
  scope?: string
  bot_user_id?: string
  app_id?: string
  team?: { id?: string; name?: string } | null
  enterprise?: { id?: string; name?: string } | null
  authed_user?: { id?: string } | null
}

/** `oauth.v2.access`: exchanges the install code for the bot token (client credentials as Basic auth). */
export async function exchangeOAuthCode(input: {
  clientId: string
  clientSecret: string
  code: string
  redirectUri: string
}): Promise<SlackOAuthAccess> {
  const basic = Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64')
  const data = await call('oauth.v2.access', {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({ code: input.code, redirect_uri: input.redirectUri }).toString(),
  })
  if (typeof data.access_token !== 'string') throw new SlackApiError('invalid_response')
  return data as unknown as SlackOAuthAccess
}

/** Answers an interaction or command later through its `response_url` (valid 30 minutes). */
export async function postToResponseUrl(
  responseUrl: string,
  message: Record<string, unknown>,
): Promise<void> {
  // Only Slack's own hosts: the URL arrives in a signed request, but never post anywhere else.
  let url: URL
  try {
    url = new URL(responseUrl)
  } catch {
    return
  }
  if (url.protocol !== 'https:' || !/(^|\.)slack(-gov)?\.com$/.test(url.hostname)) return
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(message),
      redirect: 'error',
      signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
    })
    await response.text().catch(() => '')
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'response_url post failed')
  }
}
