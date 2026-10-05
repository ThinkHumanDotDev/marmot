import * as oidc from 'openid-client'
import { getPayload, type Payload } from 'payload'

import config from '@payload-config'
import { issueTwoFactorChallenge } from '@/auth/two-factor/handlers'
import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import { safeNextPath } from '@/lib/utils'

import {
  cookiesAreSecure,
  getAuthProviders,
  getOidcConfiguration,
  getOidcSettings,
  oidcPostLogoutRedirectUri,
  oidcRedirectUri,
  resetOidcConfiguration,
} from './client'
import { OidcLoginError, type OidcErrorCode } from './errors'
import { createPayloadSessionCookie, expiredPayloadCookie, revokePayloadSession } from './session'
import {
  clearStateCookie,
  OIDC_STATE_COOKIE,
  openTransaction,
  readCookie,
  sealTransaction,
  stateCookie,
} from './state'
import { pickClaims, resolveOidcUser } from './users'

const log = childLogger('oidc')

/**
 * Framework-agnostic handlers behind `src/app/api/auth/oidc/*` and `/api/auth/providers`. They
 * take and return Fetch `Request`/`Response` objects so integration tests can drive the whole
 * flow without booting Next.
 */

function redirect(location: string, cookies: string[] = [], status = 302): Response {
  const headers = new Headers({ Location: location })
  for (const cookie of cookies) headers.append('Set-Cookie', cookie)
  return new Response(null, { status, headers })
}

const loginErrorRedirect = (code: OidcErrorCode, cookies: string[] = []) =>
  redirect(`/login?error=${code}`, cookies, 303)

const wantsJson = (request: Request) =>
  (request.headers.get('accept') ?? '').includes('application/json')

/** `GET /api/auth/providers` */
export function handleProviders(): Response {
  return Response.json(getAuthProviders(), {
    headers: { 'Cache-Control': 'no-store' },
  })
}

/** `GET /api/auth/oidc/login?next=/path` → redirect to the provider's authorization endpoint. */
export async function handleOidcLogin(request: Request): Promise<Response> {
  const settings = getOidcSettings()
  if (!settings) return loginErrorRedirect('oidc_disabled')

  const next = safeNextPath(new URL(request.url).searchParams.get('next'))

  let configuration: oidc.Configuration
  try {
    configuration = await getOidcConfiguration()
  } catch {
    return loginErrorRedirect('oidc_failed')
  }

  const codeVerifier = oidc.randomPKCECodeVerifier()
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier)
  const state = oidc.randomState()
  const nonce = oidc.randomNonce()

  const authorizationUrl = oidc.buildAuthorizationUrl(configuration, {
    redirect_uri: oidcRedirectUri(),
    scope: settings.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  })

  const sealed = await sealTransaction({ state, nonce, codeVerifier, next }, env.PAYLOAD_SECRET)
  return redirect(authorizationUrl.href, [stateCookie(sealed, { secure: cookiesAreSecure() })])
}

/**
 * `GET /api/auth/oidc/callback?code=…&state=…` → exchange the code (PKCE), verify the ID token
 * (`state`, `nonce`, signature, issuer, audience), fetch UserInfo, find or provision the user and
 * set the Payload auth cookie.
 */
export async function handleOidcCallback(request: Request): Promise<Response> {
  const settings = getOidcSettings()
  if (!settings) return loginErrorRedirect('oidc_disabled')

  const secure = cookiesAreSecure()
  const clearState = clearStateCookie({ secure })
  const url = new URL(request.url)

  const transaction = await openTransaction(
    readCookie(request.headers, OIDC_STATE_COOKIE),
    env.PAYLOAD_SECRET,
  )
  if (!transaction) return loginErrorRedirect('oidc_state', [clearState])

  if (url.searchParams.get('error')) {
    log.warn(
      { error: url.searchParams.get('error') },
      'identity provider returned an authorization error',
    )
    return loginErrorRedirect('oidc_denied', [clearState])
  }
  if (url.searchParams.get('state') !== transaction.state) {
    return loginErrorRedirect('oidc_state', [clearState])
  }

  const payload = await getPayload({ config })

  try {
    const configuration = await getOidcConfiguration()

    // Rebuild the callback URL from the public server URL: behind a reverse proxy `request.url`
    // may carry the internal host, and the token request must repeat the registered redirect URI.
    const currentUrl = new URL(oidcRedirectUri())
    currentUrl.search = url.search

    const tokens = await oidc.authorizationCodeGrant(configuration, currentUrl, {
      pkceCodeVerifier: transaction.codeVerifier,
      expectedState: transaction.state,
      expectedNonce: transaction.nonce,
      idTokenExpected: true,
    })

    const idToken = tokens.claims()
    if (!idToken?.sub) throw new Error('ID token has no sub claim')

    let merged: Record<string, unknown> = { ...idToken }
    if (configuration.serverMetadata().userinfo_endpoint) {
      try {
        const userinfo = await oidc.fetchUserInfo(configuration, tokens.access_token, idToken.sub)
        merged = { ...merged, ...userinfo }
      } catch (error) {
        log.warn({ err: error }, 'UserInfo request failed; using ID token claims only')
      }
    }

    const user = await resolveOidcUser({
      payload,
      issuer: configuration.serverMetadata().issuer,
      claims: pickClaims(merged),
      autoProvision: settings.autoProvision,
      signupDisabled: env.DISABLE_SIGNUP,
    })

    if (user.twoFactorEnabled === true) {
      // The account opted into Marmot's own second factor on top of the identity provider: no
      // session yet, the login page asks for the code (`POST /api/auth/2fa`).
      const { cookie } = await issueTwoFactorChallenge(user.id)
      log.info({ user: user.id }, 'OIDC login needs a second factor')
      const params = new URLSearchParams({ two_factor: '1', next: transaction.next })
      return redirect(`/login?${params}`, [cookie, clearState], 303)
    }

    const session = await createPayloadSessionCookie({ payload, userId: user.id })
    log.info({ user: user.id }, 'OIDC login succeeded')
    return redirect(transaction.next, [session.cookie, clearState], 303)
  } catch (error) {
    if (error instanceof OidcLoginError) {
      log.warn({ code: error.code }, 'OIDC login refused')
      return loginErrorRedirect(error.code, [clearState])
    }
    // Never log tokens or the response body: the error message from openid-client is enough.
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'OIDC login failed')
    // Provider metadata or keys may have rotated; rediscover on the next attempt.
    resetOidcConfiguration()
    return loginErrorRedirect('oidc_failed', [clearState])
  }
}

/**
 * `POST /api/auth/oidc/logout` → revoke the Payload session, clear the cookie and send the browser
 * to the provider's `end_session_endpoint` when it advertises one (RP-initiated logout), else to
 * `/login`. Responds with JSON `{ redirectTo }` for `Accept: application/json`, 303 otherwise.
 */
export async function handleOidcLogout(request: Request): Promise<Response> {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: request.headers })

  if (user && user.collection === 'users') {
    const sid = (user as { _sid?: string })._sid
    await revokePayloadSession({ payload, userId: user.id, sid })
  }

  const redirectTo = await endSessionUrl(payload)
  const cookies = [expiredPayloadCookie(payload)]

  if (wantsJson(request)) {
    const headers = new Headers({ 'Cache-Control': 'no-store' })
    for (const cookie of cookies) headers.append('Set-Cookie', cookie)
    return Response.json({ redirectTo }, { headers })
  }
  return redirect(redirectTo, cookies, 303)
}

async function endSessionUrl(_payload: Payload): Promise<string> {
  const settings = getOidcSettings()
  if (!settings) return '/login'
  try {
    const configuration = await getOidcConfiguration()
    if (!configuration.serverMetadata().end_session_endpoint) return '/login'
    return oidc.buildEndSessionUrl(configuration, {
      post_logout_redirect_uri: oidcPostLogoutRedirectUri(),
    }).href
  } catch {
    return '/login'
  }
}
