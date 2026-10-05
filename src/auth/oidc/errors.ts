/**
 * Error codes the OIDC flow redirects back to `/login?error=<code>` with. Kept as a closed list so
 * the login page can show a friendly message without reflecting arbitrary query input.
 */
export const OIDC_ERROR_MESSAGES = {
  oidc_disabled: 'Single sign-on is not configured on this server.',
  oidc_state: 'Your sign-in session expired or was tampered with. Please try again.',
  oidc_denied: 'The identity provider refused the sign-in request.',
  oidc_failed: 'Single sign-on failed. Please try again or contact your administrator.',
  email_missing: 'Your identity provider did not share an email address, which Marmot requires.',
  email_unverified:
    'An account with your email already exists but your identity provider has not verified it.',
  provisioning_disabled: 'No account exists for your identity and automatic signup is disabled.',
  signup_disabled: 'Signup is disabled on this server. Ask an administrator for an invitation.',
} as const

export type OidcErrorCode = keyof typeof OIDC_ERROR_MESSAGES

export const isOidcErrorCode = (value: unknown): value is OidcErrorCode =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(OIDC_ERROR_MESSAGES, value)

/** Message for a `?error=` query value, or `undefined` for unknown/missing codes. */
export const oidcErrorMessage = (code: unknown): string | undefined =>
  isOidcErrorCode(code) ? OIDC_ERROR_MESSAGES[code] : undefined

/** Thrown by the user-resolution step; the callback turns it into a login redirect. */
export class OidcLoginError extends Error {
  readonly code: OidcErrorCode
  readonly status: number

  constructor(code: OidcErrorCode, status = 403) {
    super(OIDC_ERROR_MESSAGES[code])
    this.name = 'OidcLoginError'
    this.code = code
    this.status = status
  }
}
