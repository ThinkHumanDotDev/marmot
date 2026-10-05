import { APIError, type Payload } from 'payload'
import QRCode from 'qrcode'

import { env } from '@/env'
import type { User } from '@/payload-types'

import {
  consumeBackupCode,
  generateBackupCodes,
  hashBackupCodes,
  looksLikeBackupCode,
} from './backup-codes'
import { decryptSecret, encryptSecret } from './crypto'
import { generateTotpSecret, totpUri, verifyTotp } from './totp'

/**
 * Account two-factor authentication: enrolment, verification and recovery codes. Every function
 * works on the raw user row (hidden fields included) with `overrideAccess: true`; callers are the
 * `/api/account/2fa/*` routes (session user acting on themself) and the login flow.
 */

/** Raw users row including the hidden 2FA fields. */
export type TwoFactorUser = User & {
  twoFactorSecret?: string | null
  twoFactorPendingSecret?: string | null
  twoFactorBackupCodes?: unknown
  twoFactorLastUsedStep?: number | null
}

export interface TwoFactorStatus {
  enabled: boolean
  verifiedAt: string | null
  backupCodesRemaining: number
}

export interface TwoFactorSetup {
  /** Base32 secret for manual entry. */
  secret: string
  otpauthUrl: string
  /** `data:image/png;base64,…` of the otpauth URL. */
  qrDataUrl: string
}

export type TwoFactorMethod = 'totp' | 'backup'

export async function loadTwoFactorUser(
  payload: Payload,
  userId: User['id'],
): Promise<TwoFactorUser> {
  return (await payload.findByID({
    collection: 'users',
    id: userId,
    depth: 0,
    overrideAccess: true,
    showHiddenFields: true,
  })) as TwoFactorUser
}

type TwoFactorFields = Partial<
  Pick<
    TwoFactorUser,
    | 'twoFactorEnabled'
    | 'twoFactorVerifiedAt'
    | 'twoFactorSecret'
    | 'twoFactorPendingSecret'
    | 'twoFactorBackupCodes'
    | 'twoFactorLastUsedStep'
  >
>

async function writeTwoFactorFields(payload: Payload, userId: User['id'], data: TwoFactorFields) {
  await payload.update({
    collection: 'users',
    id: userId,
    data: data as Partial<User>,
    depth: 0,
    overrideAccess: true,
  })
}

const backupCount = (value: unknown): number =>
  Array.isArray(value) ? value.filter((v) => typeof v === 'string').length : 0

export function twoFactorStatus(user: TwoFactorUser): TwoFactorStatus {
  return {
    enabled: user.twoFactorEnabled === true,
    verifiedAt: user.twoFactorVerifiedAt ?? null,
    backupCodesRemaining: user.twoFactorEnabled ? backupCount(user.twoFactorBackupCodes) : 0,
  }
}

export async function getTwoFactorStatus(
  payload: Payload,
  userId: User['id'],
): Promise<TwoFactorStatus> {
  return twoFactorStatus(await loadTwoFactorUser(payload, userId))
}

/**
 * Starts enrolment: a new secret is sealed into `twoFactorPendingSecret` and returned with the
 * otpauth URL and a QR code. Nothing changes for login until `confirmTwoFactorSetup` succeeds;
 * calling it again replaces the pending secret.
 */
export async function beginTwoFactorSetup(
  payload: Payload,
  userId: User['id'],
): Promise<TwoFactorSetup> {
  const user = await loadTwoFactorUser(payload, userId)
  if (user.twoFactorEnabled) {
    throw new APIError('Two-factor authentication is already enabled.', 409)
  }
  const secret = generateTotpSecret()
  await writeTwoFactorFields(payload, userId, {
    twoFactorPendingSecret: encryptSecret(secret, env.PAYLOAD_SECRET),
  })
  const otpauthUrl = totpUri(user.email, secret)
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240 })
  return { secret, otpauthUrl, qrDataUrl }
}

/**
 * Confirms enrolment with a code from the authenticator app. Promotes the pending secret, marks
 * the account as protected and returns the backup codes, which are shown exactly once.
 */
export async function confirmTwoFactorSetup(
  payload: Payload,
  userId: User['id'],
  code: string,
  now = Date.now(),
): Promise<{ backupCodes: string[] }> {
  const user = await loadTwoFactorUser(payload, userId)
  if (user.twoFactorEnabled) {
    throw new APIError('Two-factor authentication is already enabled.', 409)
  }
  const secret = decryptSecret(user.twoFactorPendingSecret, env.PAYLOAD_SECRET)
  if (!secret) throw new APIError('Start the setup again to get a new QR code.', 400)

  const result = verifyTotp(code, secret, { now })
  if (!result.valid) throw new APIError('That code is not valid. Try the next one.', 400)

  const backupCodes = generateBackupCodes()
  await writeTwoFactorFields(payload, userId, {
    twoFactorEnabled: true,
    twoFactorVerifiedAt: new Date(now).toISOString(),
    twoFactorSecret: user.twoFactorPendingSecret,
    twoFactorPendingSecret: null,
    twoFactorBackupCodes: hashBackupCodes(backupCodes, env.PAYLOAD_SECRET),
    twoFactorLastUsedStep: result.step,
  })
  return { backupCodes }
}

/** Removes every trace of 2FA from the account (secret, pending secret, backup codes). */
export async function disableTwoFactor(payload: Payload, userId: User['id']): Promise<void> {
  await writeTwoFactorFields(payload, userId, {
    twoFactorEnabled: false,
    twoFactorVerifiedAt: null,
    twoFactorSecret: null,
    twoFactorPendingSecret: null,
    twoFactorBackupCodes: null,
    twoFactorLastUsedStep: null,
  })
}

/** Replaces the backup codes; the previous ones stop working immediately. */
export async function regenerateBackupCodes(
  payload: Payload,
  userId: User['id'],
): Promise<{ backupCodes: string[] }> {
  const user = await loadTwoFactorUser(payload, userId)
  if (!user.twoFactorEnabled) {
    throw new APIError('Two-factor authentication is not enabled.', 409)
  }
  const backupCodes = generateBackupCodes()
  await writeTwoFactorFields(payload, userId, {
    twoFactorBackupCodes: hashBackupCodes(backupCodes, env.PAYLOAD_SECRET),
  })
  return { backupCodes }
}

/**
 * Verifies a login code: a 6-digit TOTP code (within the window, never one already used) or one
 * of the backup codes (consumed on success). Returns the method that matched, or `null`.
 */
export async function verifyTwoFactorCode(
  payload: Payload,
  userId: User['id'],
  code: string,
  now = Date.now(),
): Promise<TwoFactorMethod | null> {
  const user = await loadTwoFactorUser(payload, userId)
  if (!user.twoFactorEnabled) return null
  const input = code.trim()

  if (looksLikeBackupCode(input)) {
    const remaining = consumeBackupCode(input, user.twoFactorBackupCodes, env.PAYLOAD_SECRET)
    if (remaining) {
      await writeTwoFactorFields(payload, userId, { twoFactorBackupCodes: remaining })
      return 'backup'
    }
    return null
  }

  const secret = decryptSecret(user.twoFactorSecret, env.PAYLOAD_SECRET)
  if (!secret) return null
  const result = verifyTotp(input, secret, { now, lastUsedStep: user.twoFactorLastUsedStep })
  if (!result.valid) return null
  await writeTwoFactorFields(payload, userId, { twoFactorLastUsedStep: result.step })
  return 'totp'
}

/** Whether the account must enter a code after the password (or after SSO). */
export async function requiresTwoFactor(payload: Payload, userId: User['id']): Promise<boolean> {
  const { docs } = await payload.find({
    collection: 'users',
    where: { id: { equals: userId } },
    select: { twoFactorEnabled: true },
    depth: 0,
    limit: 1,
    overrideAccess: true,
  })
  return docs[0]?.twoFactorEnabled === true
}
