import { randomInt } from 'node:crypto'

import { hashBackupCode } from './crypto'

/**
 * Single-use recovery codes handed out once when 2FA is enabled (and on regeneration). Only keyed
 * digests are stored; a code is consumed by removing its digest.
 */

export const BACKUP_CODE_COUNT = 10
/** Unambiguous lowercase alphabet (no 0/o, 1/l/i): 31 symbols × 10 chars ≈ 49 bits per code. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const CODE_LENGTH = 10

/** `xxxxx-xxxxx`, as shown to the user. */
export function generateBackupCode(): string {
  let raw = ''
  for (let i = 0; i < CODE_LENGTH; i += 1) raw += ALPHABET[randomInt(ALPHABET.length)]
  return `${raw.slice(0, 5)}-${raw.slice(5)}`
}

export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  return Array.from({ length: count }, generateBackupCode)
}

/** Lowercase alphanumerics only, so `ABCDE-FGHJK` and `abcde fghjk` both match. */
export const normalizeBackupCode = (input: string): string =>
  input.toLowerCase().replace(/[^a-z0-9]/g, '')

/** `true` when the input could be a backup code rather than a 6-digit TOTP code. */
export const looksLikeBackupCode = (input: string): boolean =>
  normalizeBackupCode(input).length === CODE_LENGTH

export function hashBackupCodes(codes: string[], secret: string): string[] {
  return codes.map((code) => hashBackupCode(normalizeBackupCode(code), secret))
}

/**
 * Consumes `code` from the stored digests. Returns the remaining digests when it matched, `null`
 * when it did not (or the list is not a list of strings).
 */
export function consumeBackupCode(code: string, hashes: unknown, secret: string): string[] | null {
  if (!Array.isArray(hashes)) return null
  const list = hashes.filter((h): h is string => typeof h === 'string')
  const digest = hashBackupCode(normalizeBackupCode(code), secret)
  const index = list.indexOf(digest)
  if (index === -1) return null
  return [...list.slice(0, index), ...list.slice(index + 1)]
}
