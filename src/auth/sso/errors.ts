import { AUTH_ERROR_CODES } from '@thinkhuman/payload-plugin-auth'

/**
 * Messages for the `?error=<code>` the single sign-on flows redirect to `/login` with. The plugin's
 * codes come first; Marmot adds the codes its own hooks raise and keeps the pre-plugin `oidc_*`
 * names so old bookmarks and documentation links still render a message.
 */
export const SSO_ERROR_MESSAGES = {
  ...AUTH_ERROR_CODES,
  provider_unknown: 'This sign-in method is not configured on this server.',
  signup_disabled: 'Signup is disabled on this server. Ask an administrator for an invitation.',
  group_not_allowed:
    'Your account is not in a group that may sign in to Marmot. Ask your administrator for access.',
  groups_missing:
    'Your identity provider did not send your group memberships, so Marmot cannot check your access. Ask your administrator.',
  // Legacy aliases (before single sign-on moved to the payload-auth plugins).
  oidc_disabled: 'Single sign-on is not configured on this server.',
  oidc_state: AUTH_ERROR_CODES.state_mismatch,
  oidc_denied: AUTH_ERROR_CODES.access_denied,
  oidc_failed: AUTH_ERROR_CODES.exchange_failed,
} as const

export type SsoErrorCode = keyof typeof SSO_ERROR_MESSAGES

export const isSsoErrorCode = (value: unknown): value is SsoErrorCode =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(SSO_ERROR_MESSAGES, value)

/** Message for a `?error=` query value, or `undefined` for unknown/missing codes. */
export const ssoErrorMessage = (code: unknown): string | undefined =>
  isSsoErrorCode(code) ? SSO_ERROR_MESSAGES[code] : undefined
