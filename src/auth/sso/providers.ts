import { oidc, type OAuthProvider } from '@thinkhumandotdev/payload-auth/oauth'

import { env } from '@/env'

/** Provider id of the env-configured OpenID Connect client (`OIDC_*`), kept for existing installs. */
export const OIDC_PROVIDER_ID = 'oidc'

/**
 * Instance-wide sign-in providers, built from the environment on every call so a restart is all
 * that is needed to change them. Today that is the generic OIDC client; `meta.autoProvision`
 * carries `OIDC_AUTO_PROVISION` into the user-resolution hooks.
 */
export function getInstanceProviders(): OAuthProvider[] {
  const providers: OAuthProvider[] = []
  if (env.OIDC_ISSUER_URL && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET) {
    providers.push(
      oidc({
        id: OIDC_PROVIDER_ID,
        name: env.OIDC_DISPLAY_NAME,
        issuer: env.OIDC_ISSUER_URL,
        clientId: env.OIDC_CLIENT_ID,
        clientSecret: env.OIDC_CLIENT_SECRET,
        scopes: env.OIDC_SCOPES.split(/\s+/).filter(Boolean),
        icon: 'key',
        meta: { autoProvision: env.OIDC_AUTO_PROVISION },
      }),
    )
  }
  return providers
}

export const isOidcEnabled = (): boolean =>
  getInstanceProviders().some((provider) => provider.id === OIDC_PROVIDER_ID)
