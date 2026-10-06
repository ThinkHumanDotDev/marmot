import { github, google, oidc, type OAuthProvider } from '@thinkhumandotdev/payload-auth/oauth'

import { env } from '@/env'

/** Provider id of the env-configured OpenID Connect client (`OIDC_*`), kept for existing installs. */
export const OIDC_PROVIDER_ID = 'oidc'

/** Ids of the social presets (`GITHUB_*`, `GOOGLE_*`). */
export const GITHUB_PROVIDER_ID = 'github'
export const GOOGLE_PROVIDER_ID = 'google'

/**
 * Instance-wide sign-in providers, built from the environment on every call so a restart is all
 * that is needed to change them: the generic OIDC client (`meta.autoProvision` carries
 * `OIDC_AUTO_PROVISION` into the user-resolution hooks) and the GitHub / Google presets, which
 * always provision subject to the sign-up and invitation rules.
 */
export function getInstanceProviders(): OAuthProvider[] {
  const providers: OAuthProvider[] = []
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    providers.push(
      github({
        id: GITHUB_PROVIDER_ID,
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        meta: { autoProvision: true },
      }),
    )
  }
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.push(
      google({
        id: GOOGLE_PROVIDER_ID,
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        meta: { autoProvision: true },
      }),
    )
  }
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
