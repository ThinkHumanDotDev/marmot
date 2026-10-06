import { getPayload } from 'payload'

import config from '@payload-config'

import { getAuthProviders, oauth } from './oauth'

/**
 * Request handlers behind `src/app/api/auth/{providers,oidc,sso}`. Fetch `Request` → `Response`,
 * so integration tests drive the whole flow without booting Next.
 */

/** `GET /api/auth/providers` */
export function handleProviders(): Response {
  return Response.json(getAuthProviders(), { headers: { 'Cache-Control': 'no-store' } })
}

/** `GET /api/auth/sso/:provider/login?next=/path` (and the legacy `/api/auth/oidc/login`). */
export async function handleSsoLogin(request: Request, providerId: string): Promise<Response> {
  const payload = await getPayload({ config })
  return oauth.handlers.login(request, { payload, providerId })
}

/** `GET /api/auth/sso/:provider/callback` (and the legacy `/api/auth/oidc/callback`). */
export async function handleSsoCallback(request: Request, providerId: string): Promise<Response> {
  const payload = await getPayload({ config })
  return oauth.handlers.callback(request, { payload, providerId })
}

/**
 * `POST /api/auth/sso/logout` (and the legacy `/api/auth/oidc/logout`) → revoke the Payload session
 * and send the browser to the provider's end-session endpoint when it has one, else to `/login`.
 * Returns `{ redirectTo }` for `Accept: application/json`, a 303 otherwise.
 */
export async function handleSsoLogout(request: Request): Promise<Response> {
  const payload = await getPayload({ config })
  return oauth.handlers.logout(request, { payload })
}
