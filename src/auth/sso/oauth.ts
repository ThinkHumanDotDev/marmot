import type { ProviderInfo } from '@thinkhuman/payload-plugin-auth'
import { createOAuth, type OAuthProvider } from '@thinkhuman/payload-plugin-auth/oauth'

import { issueTwoFactorChallenge } from '@/auth/two-factor/handlers'
import { AUTH_ACCOUNTS_SLUG } from '@/collections/AuthAccounts'
import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import type { User } from '@/payload-types'
import { findEnabledConnection, toOAuthProvider } from '@/server/sso/connections'
import { isLocalLoginDisabled } from '@/server/sso/local-login'

import { userResolution } from './hooks'
import { getInstanceProviders, OIDC_PROVIDER_ID } from './providers'

const log = childLogger('sso')

const serverUrl = () => env.NEXT_PUBLIC_SERVER_URL.replace(/\/$/, '')

/**
 * Redirect URI to register at a provider. The env-configured OIDC client keeps the URL existing
 * installs registered before single sign-on moved to the plugin; every other provider (and every
 * organization connection) lives under `/api/auth/sso/<id>/callback`.
 */
export const ssoRedirectUri = (providerId: string): string =>
  providerId === OIDC_PROVIDER_ID
    ? `${serverUrl()}/api/auth/oidc/callback`
    : `${serverUrl()}/api/auth/sso/${providerId}/callback`

/** Where the provider sends the browser after RP-initiated logout. */
export const ssoPostLogoutRedirectUri = (): string => `${serverUrl()}/login`

/** Provider the login page should link to, with the path that starts its flow. */
export interface LoginProvider extends ProviderInfo {
  loginPath: string
}

export const ssoLoginPath = (providerId: string): string => `/api/auth/sso/${providerId}/login`

export interface AuthProviders {
  /** Password login is offered (`false` in SSO-only mode, `OIDC_DISABLE_LOCAL_LOGIN`). */
  local: boolean
  /** The env-configured OIDC client; kept for API compatibility with `{ local, oidc }` consumers. */
  oidc: { enabled: boolean; displayName: string }
  /** Every enabled instance-wide provider, in display order. */
  providers: LoginProvider[]
}

/** Body of `GET /api/auth/providers`; what the login page needs to render the SSO buttons. */
export function getAuthProviders(): AuthProviders {
  const providers = getInstanceProviders()
  const oidcProvider = providers.find((provider) => provider.id === OIDC_PROVIDER_ID)
  return {
    local: !isLocalLoginDisabled(),
    oidc: {
      enabled: oidcProvider !== undefined,
      displayName: oidcProvider?.name ?? env.OIDC_DISPLAY_NAME,
    },
    providers: providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      icon: provider.icon,
      loginPath: ssoLoginPath(provider.id),
    })),
  }
}

/** Sends a signed-in user who was linking an identity back to where they started. */
export function linkErrorResponse(
  transaction: { linkUserId?: string; next: string } | undefined,
  code: string,
  cookies: string[],
): Response | undefined {
  if (!transaction?.linkUserId) return undefined
  const target = new URL(transaction.next, 'http://marmot.local')
  target.searchParams.set('error', code)
  const headers = new Headers({
    Location: `${target.pathname}${target.search}`,
    'Cache-Control': 'no-store',
  })
  for (const value of cookies) headers.append('Set-Cookie', value)
  return new Response(null, { status: 303, headers })
}

/**
 * Accounts with Marmot's own second factor get the challenge instead of a session (the login page
 * asks for the code, `POST /api/auth/2fa`). Linking flows are already signed in and skip it.
 */
export async function twoFactorResponse(
  user: User,
  next: string,
  cookies: string[],
  linking: boolean,
): Promise<Response | undefined> {
  if (linking || user.twoFactorEnabled !== true) return undefined
  const { cookie } = await issueTwoFactorChallenge(user.id)
  log.info({ user: user.id }, 'SSO login needs a second factor')
  const params = new URLSearchParams({ two_factor: '1', next })
  const headers = new Headers({ Location: `/login?${params}`, 'Cache-Control': 'no-store' })
  for (const value of [cookie, ...cookies]) headers.append('Set-Cookie', value)
  return new Response(null, { status: 303, headers })
}

/**
 * The OAuth / OpenID Connect integration (`@thinkhuman/payload-plugin-auth/oauth`), configured for
 * Marmot:
 *
 * - providers are resolved per request: the instance-wide ones from the environment, then the
 *   organizations' OIDC connections by slug (`sso-connections`), so nothing is restarted when an
 *   admin saves a connection;
 * - the routes are Marmot's own (`src/app/api/auth/{oidc,sso}`), rate limited there, hence
 *   `basePath: false`;
 * - identities map to users through `userResolution` (`./hooks.ts`).
 */
export const oauth = createOAuth({
  usersSlug: 'users',
  accounts: { slug: AUTH_ACCOUNTS_SLUG },
  basePath: false,
  redirectUri: (provider: OAuthProvider) => ssoRedirectUri(provider.id),
  postLogoutRedirectUri: ssoPostLogoutRedirectUri(),
  successRedirect: '/',
  errorRedirect: '/login',
  cookie: { name: 'marmot-sso', path: '/api/auth' },
  providers: {
    get: async (id, { payload }) => {
      const instance = getInstanceProviders().find((provider) => provider.id === id)
      if (instance) return instance
      const connection = await findEnabledConnection(payload, id)
      return connection ? toOAuthProvider(connection) : null
    },
    list: async () => getInstanceProviders(),
  },
  users: userResolution,
  onError: ({ transaction, code, cookies }) => linkErrorResponse(transaction, code, cookies),
  onAuthenticated: ({ user, next, cookies, linking }) =>
    twoFactorResponse(user as unknown as User, next, cookies, linking),
})
