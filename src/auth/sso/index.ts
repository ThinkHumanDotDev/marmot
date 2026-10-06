/**
 * Single sign-on (see docs/Single-Sign-On.md), built on `@thinkhumandotdev/payload-auth`.
 *
 * - `providers.ts` instance-wide providers from the environment (`OIDC_*`)
 * - `oauth.ts`     the configured OAuth/OIDC integration: redirect URIs, the 2FA hand-off
 * - `saml.ts`      the configured SAML integration (organization connections only)
 * - `hooks.ts`     user resolution shared by both (invitations, `DISABLE_SIGNUP`, legacy
 *                  `oidcSubject` columns, just-in-time organization membership)
 * - `errors.ts`    messages for `/login?error=<code>`
 * - `handlers.ts`  request handlers used by the Next route files
 */
export { isSsoErrorCode, SSO_ERROR_MESSAGES, ssoErrorMessage, type SsoErrorCode } from './errors'
export {
  handleProviders,
  handleSamlAcs,
  handleSamlLogin,
  handleSamlMetadata,
  handleSsoCallback,
  handleSsoLogin,
  handleSsoLogout,
} from './handlers'
export { userResolution } from './hooks'
export { saml } from './saml'
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
