/**
 * Installing the Slack app into an organization (#129, OAuth v2 "Add to Slack"):
 *
 * 1. `GET /api/orgs/:orgId/slack/install` (`integration:manage`, signed in): signs a state for the
 *    organization and member, stores its nonce in an HttpOnly cookie and redirects to Slack.
 * 2. Slack redirects the browser to `GET /api/slack/oauth/callback?code&state`: the state must
 *    verify, match the cookie and the signed-in member, who must still be allowed to manage
 *    integrations. The code is exchanged for the bot token (`oauth.v2.access`), which is sealed
 *    and stored, and the Slack user who approved the install is linked to the member.
 * 3. The browser lands on Settings → Integrations with `?slack=installed` (or `?slack=<error>`).
 */
import { getPayload, type Payload } from 'payload'

import config from '@payload-config'
import { canInOrg } from '@/access/overrides'
import { isApiKeyPrincipal } from '@/access/permissions'
import { childLogger } from '@/lib/logger'
import { SLACK_BOT_SCOPES } from '@/lib/slack-app'
import type { Organization } from '@/payload-types'
import { authenticateRequest } from '@/server/auth/request-auth'
import type { RequestUser } from '@/server/monitors/http'
import { isSecureRequest } from '@/server/status-pages/access'

import { exchangeOAuthCode, SlackApiError } from './api'
import { absoluteUrl, slackAppConfig, slackDisabledResponse, slackRedirectUri } from './config'
import { saveInstallation } from './installations'
import {
  createOAuthState,
  OAUTH_STATE_TTL_SECONDS,
  SLACK_STATE_COOKIE,
  verifyOAuthState,
} from './tokens'

const log = childLogger('slack:oauth')

const COOKIE_PATH = '/api/slack/oauth'

export const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize'

const stateCookie = (request: Request, value: string, maxAge: number): string =>
  [
    `${SLACK_STATE_COOKIE}=${value}`,
    `Path=${COOKIE_PATH}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(isSecureRequest(request) ? ['Secure'] : []),
  ].join('; ')

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return null
}

const redirect = (location: string, cookie?: string): Response =>
  new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
      ...(cookie ? { 'Set-Cookie': cookie } : {}),
    },
  })

/** Step 1: the redirect to Slack's consent screen. */
export async function startInstall(request: Request, rawOrgId: string): Promise<Response> {
  const app = slackAppConfig()
  if (!app) return slackDisabledResponse()
  const payload = await getPayload({ config })
  const auth = await authenticateRequest(payload, request)
  if (auth.response) return auth.response
  const user = auth.user
  if (!user || isApiKeyPrincipal(user)) {
    return Response.json({ error: 'Sign in to install the Slack app.' }, { status: 401 })
  }
  const orgId =
    payload.db.defaultIDType === 'number' && /^\d+$/.test(rawOrgId) ? Number(rawOrgId) : rawOrgId
  if (!(await canInOrg(payload, user, orgId, 'integration:manage'))) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { state, nonce } = createOAuthState(orgId, user.id)
  const url = new URL(SLACK_AUTHORIZE_URL)
  url.searchParams.set('client_id', app.clientId)
  url.searchParams.set('scope', SLACK_BOT_SCOPES.join(','))
  url.searchParams.set('redirect_uri', slackRedirectUri())
  url.searchParams.set('state', state)
  return redirect(url.toString(), stateCookie(request, nonce, OAUTH_STATE_TTL_SECONDS))
}

async function orgSlug(payload: Payload, orgId: string | number): Promise<string | null> {
  const org = (await payload
    .findByID({ collection: 'organizations', id: orgId, depth: 0, overrideAccess: true })
    .catch(() => null)) as Organization | null
  return org?.slug ?? null
}

/** Step 2: Slack's redirect back. Always answers with a redirect into the app. */
export async function finishInstall(request: Request): Promise<Response> {
  const app = slackAppConfig()
  if (!app) return slackDisabledResponse()
  const payload = await getPayload({ config })
  const params = new URL(request.url).searchParams
  const clear = stateCookie(request, '', 0)
  const state = verifyOAuthState(params.get('state'))
  const nonce = readCookie(request, SLACK_STATE_COOKIE)
  if (!state || !nonce || nonce !== state.nonce) {
    log.info('slack install refused: state mismatch')
    return redirect(absoluteUrl('/?slack=invalid-state'), clear)
  }
  const orgId =
    payload.db.defaultIDType === 'number' && /^\d+$/.test(state.orgId)
      ? Number(state.orgId)
      : state.orgId
  const slug = await orgSlug(payload, orgId)
  const back = (outcome: string) =>
    redirect(
      absoluteUrl(slug ? `/${slug}/settings/integrations?slack=${outcome}` : `/?slack=${outcome}`),
      clear,
    )

  const auth = await authenticateRequest(payload, request)
  const user = auth.user as RequestUser | null | undefined
  if (!user || isApiKeyPrincipal(user) || String(user.id) !== state.userId) {
    return back('invalid-state')
  }
  if (!(await canInOrg(payload, user, orgId, 'integration:manage'))) return back('forbidden')
  if (params.get('error')) return back('denied')
  const code = params.get('code')
  if (!code) return back('denied')

  try {
    const access = await exchangeOAuthCode({
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      code,
      redirectUri: slackRedirectUri(),
    })
    const teamId = access.team?.id
    if (!teamId) return back('failed')
    const saved = await saveInstallation(payload, {
      orgId,
      userId: user.id,
      teamId,
      teamName: access.team?.name ?? null,
      enterpriseId: access.enterprise?.id ?? null,
      appId: access.app_id ?? null,
      botUserId: access.bot_user_id ?? null,
      botToken: access.access_token,
      scopes: (access.scope ?? '').split(',').filter(Boolean),
      authedUserId: access.authed_user?.id ?? null,
      actor: user,
    })
    if (!saved.ok) return back('team-taken')
    log.info({ orgId, teamId }, 'slack app installed')
    return back('installed')
  } catch (err) {
    log.warn(
      { err: err instanceof SlackApiError ? err.code : err instanceof Error ? err.message : err },
      'slack install failed',
    )
    return back('failed')
  }
}
