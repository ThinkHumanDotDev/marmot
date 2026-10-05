import { generateSecret, generateURI, verifySync } from 'otplib'

/**
 * Time-based one-time passwords (RFC 6238) for the account security settings and the login flow.
 *
 * Ported from Uptime Kuma (MIT, https://github.com/louislam/uptime-kuma): the `login`,
 * `prepare2FA`, `save2FA`, `disable2FA` and `verifyToken` socket handlers in `server/server.js`.
 * Kuma verifies with `notp` and a `window: 1` tolerance and refuses the last accepted token
 * (`twofa_last_token`); Marmot keeps the one-step tolerance and generalises the replay check to
 * "the matched time step must be after the last accepted one".
 */

export const TOTP_ISSUER = 'Marmot'
export const TOTP_PERIOD_SECONDS = 30
export const TOTP_DIGITS = 6
/** Accept the previous and the next time step as well (clock drift between phone and server). */
export const TOTP_WINDOW_STEPS = 1

/** New base32 secret (160 bits), the format authenticator apps expect. */
export function generateTotpSecret(): string {
  return generateSecret()
}

/** `otpauth://totp/Marmot:<email>?secret=…&issuer=Marmot…` for QR codes and manual entry. */
export function totpUri(email: string, secret: string): string {
  return generateURI({
    issuer: TOTP_ISSUER,
    label: email,
    secret,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
  })
}

export interface VerifyTotpOptions {
  /** Milliseconds since the epoch; defaults to `Date.now()`. */
  now?: number
  /** Time step of the last code that was accepted; codes at or before it are replays. */
  lastUsedStep?: number | null
}

export type VerifyTotpResult = { valid: true; step: number } | { valid: false }

/** Current TOTP time step for `now` (ms). */
export const totpStep = (now: number): number => Math.floor(now / 1000 / TOTP_PERIOD_SECONDS)

/** Code is 6 digits, possibly with whitespace the user typed. */
export const normalizeTotpCode = (input: string): string => input.replace(/\s+/g, '')

/**
 * Verifies `code` against `secret` within ±`TOTP_WINDOW_STEPS` steps and rejects any code whose
 * time step is not after `lastUsedStep`, so one code can never authenticate twice.
 */
export function verifyTotp(
  code: string,
  secret: string,
  { now = Date.now(), lastUsedStep }: VerifyTotpOptions = {},
): VerifyTotpResult {
  const token = normalizeTotpCode(code)
  if (!/^\d{6}$/.test(token)) return { valid: false }

  const result = verifySync({
    secret,
    token,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    epoch: Math.floor(now / 1000),
    epochTolerance: TOTP_WINDOW_STEPS * TOTP_PERIOD_SECONDS,
  })
  if (!result.valid) return { valid: false }

  const step = totpStep(now) + result.delta
  if (typeof lastUsedStep === 'number' && step <= lastUsedStep) return { valid: false }
  return { valid: true, step }
}
