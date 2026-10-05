import * as oidc from 'openid-client'

import { env, isProduction } from '@/env'
import { childLogger } from '@/lib/logger'

const log = childLogger('oidc')

export interface OidcSettings {
  issuerUrl: string
  clientId: string
  clientSecret: string
  displayName: string
  scopes: string
  autoProvision: boolean
}

/**
 * SSO is enabled only when issuer, client id and client secret are all configured. Read lazily on
 * every call (not at import time) so a restart is all that is needed to change the configuration.
 */
export function getOidcSettings(): OidcSettings | null {
  const issuerUrl = env.OIDC_ISSUER_URL
  const clientId = env.OIDC_CLIENT_ID
  const clientSecret = env.OIDC_CLIENT_SECRET
  if (!issuerUrl || !clientId || !clientSecret) return null
  return {
    issuerUrl,
    clientId,
    clientSecret,
    displayName: env.OIDC_DISPLAY_NAME,
    scopes: env.OIDC_SCOPES,
    autoProvision: env.OIDC_AUTO_PROVISION,
  }
}

export const isOidcEnabled = (): boolean => getOidcSettings() !== null

const serverUrl = () => env.NEXT_PUBLIC_SERVER_URL.replace(/\/$/, '')

/** Register this exact URL as the redirect URI at the identity provider. */
export const oidcRedirectUri = (): string => `${serverUrl()}/api/auth/oidc/callback`

/** Where the provider sends the browser after RP-initiated logout. */
export const oidcPostLogoutRedirectUri = (): string => `${serverUrl()}/login`

/** `Secure` cookies when Marmot is served over https. */
export const cookiesAreSecure = (): boolean => serverUrl().startsWith('https://')

export interface AuthProviders {
  local: true
  oidc: { enabled: boolean; displayName: string }
}

/** Body of `GET /api/auth/providers`; what the login page needs to render the SSO button. */
export function getAuthProviders(): AuthProviders {
  const settings = getOidcSettings()
  return {
    local: true,
    oidc: {
      enabled: settings !== null,
      displayName: settings?.displayName ?? env.OIDC_DISPLAY_NAME,
    },
  }
}

let cachedConfiguration: Promise<oidc.Configuration> | null = null

/**
 * Discovered provider configuration (`/.well-known/openid-configuration`), cached for the life of
 * the process. A failed discovery is not cached so the next request retries; callers that hit an
 * error while using the configuration call `resetOidcConfiguration()` so a provider restart with
 * new metadata or keys is picked up on the following attempt.
 */
export function getOidcConfiguration(): Promise<oidc.Configuration> {
  if (cachedConfiguration) return cachedConfiguration

  const settings = getOidcSettings()
  if (!settings) return Promise.reject(new Error('OIDC is not configured'))

  const issuer = new URL(settings.issuerUrl)
  // openid-client refuses plain-http issuers by default. Allow them outside production so a local
  // Keycloak/Authentik (or the in-process test issuer) works without TLS.
  const execute = issuer.protocol === 'http:' && !isProduction() ? [oidc.allowInsecureRequests] : []

  cachedConfiguration = oidc
    .discovery(issuer, settings.clientId, settings.clientSecret, undefined, {
      execute,
      timeout: 15,
    })
    .catch((error: unknown) => {
      cachedConfiguration = null
      log.error({ err: error, issuer: settings.issuerUrl }, 'OIDC discovery failed')
      throw error
    })
  return cachedConfiguration
}

export function resetOidcConfiguration(): void {
  cachedConfiguration = null
}
