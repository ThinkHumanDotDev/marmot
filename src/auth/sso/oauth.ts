import { AuthError, type ProviderInfo } from '@thinkhumandotdev/payload-auth'
import { createOAuth, type OAuthProvider } from '@thinkhumandotdev/payload-auth/oauth'
import type { Payload } from 'payload'

import { issueTwoFactorChallenge } from '@/auth/two-factor/handlers'
import { AUTH_ACCOUNTS_SLUG } from '@/collections/AuthAccounts'
import { acceptInvitation } from '@/collections/Invitations'
import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import type { Invitation, User } from '@/payload-types'

import { getInstanceProviders, OIDC_PROVIDER_ID } from './providers'

const log = childLogger('sso')

const serverUrl = () => env.NEXT_PUBLIC_SERVER_URL.replace(/\/$/, '')

/**
 * Redirect URI to register at a provider. The env-configured OIDC client keeps the URL existing
 * installs registered before single sign-on moved to the plugin; every other provider lives under
 * `/api/auth/sso/<id>/callback`.
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
  local: true
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
    local: true,
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

async function findPendingInvitation(
  payload: Payload,
  email: string,
): Promise<Invitation | undefined> {
  const { docs } = await payload.find({
    collection: 'invitations',
    where: {
      and: [
        { email: { equals: email } },
        { status: { equals: 'pending' } },
        { expiresAt: { greater_than: new Date().toISOString() } },
      ],
    },
    sort: '-createdAt',
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  return docs[0]
}

/**
 * The OAuth / OpenID Connect integration (`@thinkhumandotdev/payload-auth/oauth`), configured for
 * Marmot:
 *
 * - providers are resolved per request from the environment (and, later, from per-organization
 *   connections), so nothing is cached across configuration changes beyond provider discovery;
 * - the routes are Marmot's own (`src/app/api/auth/{oidc,sso}`), rate limited there, hence
 *   `basePath: false`;
 * - identities map to users as before: linked account → legacy `oidcIssuer`/`oidcSubject` columns →
 *   verified email → provisioning. Provisioning honours `OIDC_AUTO_PROVISION` and, with
 *   `DISABLE_SIGNUP`, requires a pending invitation that is accepted during the login;
 * - accounts with two-factor authentication get Marmot's challenge instead of a session.
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
    get: async (id) => getInstanceProviders().find((provider) => provider.id === id) ?? null,
    list: async () => getInstanceProviders(),
  },
  users: {
    autoProvision: ({ provider }) => provider.meta?.autoProvision !== false,
    /**
     * Installs from before the `auth-accounts` collection stored the OIDC identity on the user.
     * Match it here so those users keep signing in; the account row created from this match takes
     * over on the next login.
     */
    findUser: async ({ payload, identity, provider }) => {
      if (provider.id !== OIDC_PROVIDER_ID) return null
      const { docs } = await payload.find({
        collection: 'users',
        where: {
          and: [
            { oidcIssuer: { equals: env.OIDC_ISSUER_URL } },
            { oidcSubject: { equals: identity.providerAccountId } },
          ],
        },
        limit: 1,
        depth: 0,
        overrideAccess: true,
      })
      return docs[0] ?? null
    },
    beforeProvision: async ({ payload, identity }) => {
      if (!env.DISABLE_SIGNUP) return
      const email = identity.email?.trim().toLowerCase()
      if (!email || !(await findPendingInvitation(payload, email))) {
        throw new AuthError('signup_disabled')
      }
    },
    mapNewUser: ({ provider }) => ({
      authProvider: (provider.id === OIDC_PROVIDER_ID
        ? 'oidc'
        : 'oauth') satisfies User['authProvider'],
    }),
    afterProvision: async ({ payload, user, identity }) => {
      if (!env.DISABLE_SIGNUP) return
      const email = identity.email?.trim().toLowerCase()
      const invitation = email ? await findPendingInvitation(payload, email) : undefined
      if (!invitation?.token) return
      try {
        await acceptInvitation({ payload, token: invitation.token, user: user as unknown as User })
      } catch (error) {
        // The account exists either way; the invitation link can still be used afterwards.
        log.warn({ err: error, user: user.id }, 'could not accept invitation during provisioning')
      }
    },
  },
  onError: ({ transaction, code, cookies }) => {
    // A signed-in user who was linking an identity goes back to the account page, not to /login.
    if (!transaction?.linkUserId) return
    const target = new URL(transaction.next, 'http://marmot.local')
    target.searchParams.set('error', code)
    const headers = new Headers({
      Location: `${target.pathname}${target.search}`,
      'Cache-Control': 'no-store',
    })
    for (const value of cookies) headers.append('Set-Cookie', value)
    return new Response(null, { status: 303, headers })
  },
  onAuthenticated: async ({ user: authenticated, next, cookies, linking }) => {
    const user = authenticated as unknown as User
    if (linking || user.twoFactorEnabled !== true) return
    // The account opted into Marmot's own second factor on top of the identity provider: no
    // session yet, the login page asks for the code (`POST /api/auth/2fa`).
    const { cookie } = await issueTwoFactorChallenge(user.id)
    log.info({ user: user.id }, 'SSO login needs a second factor')
    const params = new URLSearchParams({ two_factor: '1', next })
    const headers = new Headers({ Location: `/login?${params}`, 'Cache-Control': 'no-store' })
    for (const value of [cookie, ...cookies]) headers.append('Set-Cookie', value)
    return new Response(null, { status: 303, headers })
  },
})
