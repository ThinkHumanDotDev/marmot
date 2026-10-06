/**
 * Generic OIDC single sign-on (see docs/Single-Sign-On.md).
 *
 * - `client.ts`   settings, discovery cache, redirect URIs, `getAuthProviders()`
 * - `state.ts`    encrypted transaction cookie (PKCE verifier, state, nonce, next path)
 * - `users.ts`    maps claims to a Marmot user (lookup, email linking, provisioning)
 * - `session.ts`  issues the regular Payload auth cookie
 * - `handlers.ts` request handlers used by the Next route files
 */
export {
  cookiesAreSecure,
  getAuthProviders,
  getOidcConfiguration,
  getOidcSettings,
  isOidcEnabled,
  oidcPostLogoutRedirectUri,
  oidcRedirectUri,
  resetOidcConfiguration,
  type AuthProviders,
  type OidcSettings,
} from './client'
export {
  isOidcErrorCode,
  OIDC_ERROR_MESSAGES,
  oidcErrorMessage,
  OidcLoginError,
  type OidcErrorCode,
} from './errors'
export { handleOidcCallback, handleOidcLogin, handleOidcLogout, handleProviders } from './handlers'
export {
  createPayloadSessionCookie,
  expiredPayloadCookie,
  revokePayloadSession,
  type PayloadSessionCookie,
} from './session'
export {
  clearStateCookie,
  OIDC_STATE_COOKIE,
  OIDC_STATE_COOKIE_PATH,
  OIDC_STATE_TTL_SECONDS,
  openTransaction,
  readCookie,
  sealTransaction,
  stateCookie,
  type OidcTransaction,
} from './state'
export {
  displayNameFromClaims,
  normalizeEmail,
  pickClaims,
  randomLocalPassword,
  resolveOidcUser,
  type OidcClaims,
  type ResolveOidcUserArgs,
} from './users'
