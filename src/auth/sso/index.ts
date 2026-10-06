/**
 * Single sign-on (see docs/Single-Sign-On.md), built on `@thinkhumandotdev/payload-auth`.
 *
 * - `providers.ts` instance-wide providers from the environment (`OIDC_*`)
 * - `oauth.ts`     the configured OAuth/OIDC integration: redirect URIs, user-resolution hooks
 *                  (invitations, `DISABLE_SIGNUP`, legacy `oidcSubject` columns), the 2FA hand-off
 * - `errors.ts`    messages for `/login?error=<code>`
 * - `handlers.ts`  request handlers used by the Next route files
 */
export { isSsoErrorCode, SSO_ERROR_MESSAGES, ssoErrorMessage, type SsoErrorCode } from './errors'
export { handleProviders, handleSsoCallback, handleSsoLogin, handleSsoLogout } from './handlers'
export {
  getAuthProviders,
  oauth,
  ssoLoginPath,
  ssoPostLogoutRedirectUri,
  ssoRedirectUri,
  type AuthProviders,
  type LoginProvider,
} from './oauth'
export { getInstanceProviders, isOidcEnabled, OIDC_PROVIDER_ID } from './providers'
