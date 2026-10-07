/**
 * Who may send notification mail through the instance-wide `SMTP_*` settings, and how much.
 *
 * An `smtp` channel with `useServerSmtp: true` sends with the operator's mail server and sender
 * domain. `NOTIFICATIONS_SERVER_SMTP` decides who may set that up (`all` | `superadmin` | `off`),
 * `NOTIFICATIONS_SERVER_SMTP_RATE` caps the messages per organization and hour, and every such
 * message is limited to `SERVER_SMTP_MAX_RECIPIENTS` addresses.
 *
 * The save-time rule (`checkServerSmtpChange`) runs in the `notifications` collection and the test
 * endpoint; the send-time rule (`assertServerSmtpSendAllowed`) runs in `sendNotification`, which the
 * worker, the expiry jobs and the test endpoint all go through.
 */
import addressparser from 'nodemailer/lib/addressparser'

import { isSuperadmin, type OrgId, type UserLike } from '@/access/permissions'
import { env } from '@/env'
import type { ErrorKey, ErrorValues } from '@/server/errors'
import { createRateLimiter, type RateLimiter } from '@/server/security/rate-limit'

export type ServerSmtpPolicy = 'all' | 'superadmin' | 'off'

/** Addresses per message (to, cc and bcc combined) when sending through the server settings. */
export const SERVER_SMTP_MAX_RECIPIENTS = 10

/** Rate-limit window: one hour. */
const RATE_WINDOW_SECONDS = 60 * 60

export const SERVER_SMTP_OFF_MESSAGE =
  'Sending through the server SMTP settings is turned off on this instance. Enter SMTP settings for this channel instead.'
export const SERVER_SMTP_SUPERADMIN_MESSAGE =
  'Only an instance superadmin can set up a channel that sends through the server SMTP settings. Enter SMTP settings for this channel instead.'
export const SERVER_SMTP_RECIPIENTS_MESSAGE = `Messages sent through the server SMTP settings can have at most ${SERVER_SMTP_MAX_RECIPIENTS} recipients (to, cc and bcc combined).`

export const serverSmtpPolicy = (): ServerSmtpPolicy => env.NOTIFICATIONS_SERVER_SMTP

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** True when a channel of `type` with `config` would send through the server SMTP settings. */
export function usesServerSmtp(type: string | null | undefined, config: unknown): boolean {
  return type === 'smtp' && asRecord(config).useServerSmtp === true
}

/** May `user` set up a channel that sends through the server SMTP settings? */
export function canUseServerSmtp(
  user: UserLike | null | undefined,
  policy: ServerSmtpPolicy = serverSmtpPolicy(),
): boolean {
  if (policy === 'all') return true
  if (policy === 'off') return false
  return isSuperadmin(user)
}

/** One-line explanation for the channel form, or `null` when the user may use the option. */
export function serverSmtpRestriction(
  user: UserLike | null | undefined,
  policy: ServerSmtpPolicy = serverSmtpPolicy(),
): string | null {
  if (canUseServerSmtp(user, policy)) return null
  return policy === 'off'
    ? 'Sending through the server SMTP settings is turned off on this instance.'
    : 'Only an instance superadmin can turn on the server SMTP settings for a channel.'
}

/** Number of addresses in the `to`, `cc` and `bcc` fields of an `smtp` config. */
export function countSmtpRecipients(config: unknown): number {
  const record = asRecord(config)
  let count = 0
  for (const key of ['to', 'cc', 'bcc'] as const) {
    const value = record[key]
    if (typeof value !== 'string' || value.trim() === '') continue
    count += addressparser(value, { flatten: true }).filter((entry) => entry.address).length
  }
  return count
}

/** Config without empty values, keys sorted, so a re-submitted form compares equal to the stored one. */
function normalizedConfig(config: unknown): string {
  const record = asRecord(config)
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined && record[key] !== null && record[key] !== '')
    .sort()
    .map((key) => [key, record[key]])
  return JSON.stringify(entries)
}

/**
 * Why a change is refused: `message` is the English text, `key`/`values` the `errors.*` message
 * for rendering it in the user's language.
 */
export type ServerSmtpChangeRefusal = { key: ErrorKey; values?: ErrorValues; message: string } & (
  { status: 403 } | { status: 400; path: string }
)

export interface ServerSmtpChangeInput {
  operation: 'create' | 'update'
  type: string | null | undefined
  config: unknown
  originalType?: string | null
  originalConfig?: unknown
  user: UserLike | null | undefined
  /** Local API call with `overrideAccess: true` (trusted server code, not a user request). */
  overrideAccess?: boolean
  policy?: ServerSmtpPolicy
}

/**
 * Save-time rule for a channel. Returns why the change is refused, or `null`.
 *
 * Only changes that set up server-SMTP sending are checked: a create with `useServerSmtp`, an update
 * that switches it on, or an update that edits the config of a channel that keeps using it. Updates
 * that leave the config alone (rename, pause, worker bookkeeping) and turning the option off are
 * always allowed, so existing channels keep working after an upgrade.
 */
export function checkServerSmtpChange(
  input: ServerSmtpChangeInput,
): ServerSmtpChangeRefusal | null {
  if (!usesServerSmtp(input.type, input.config)) return null
  const unchanged =
    input.operation === 'update' &&
    usesServerSmtp(input.originalType, input.originalConfig) &&
    normalizedConfig(input.config) === normalizedConfig(input.originalConfig)
  if (unchanged) return null

  const policy = input.policy ?? serverSmtpPolicy()
  if (policy === 'off') {
    return { status: 403, key: 'serverSmtpOff', message: SERVER_SMTP_OFF_MESSAGE }
  }
  if (policy === 'superadmin' && !input.overrideAccess && !isSuperadmin(input.user)) {
    return { status: 403, key: 'serverSmtpSuperadminOnly', message: SERVER_SMTP_SUPERADMIN_MESSAGE }
  }
  if (countSmtpRecipients(input.config) > SERVER_SMTP_MAX_RECIPIENTS) {
    return {
      status: 400,
      key: 'serverSmtpTooManyRecipients',
      values: { max: SERVER_SMTP_MAX_RECIPIENTS },
      message: SERVER_SMTP_RECIPIENTS_MESSAGE,
      path: 'config.to',
    }
  }
  return null
}

export type ServerSmtpSendRefusalReason = 'disabled' | 'too-many-recipients' | 'rate-limited'

/** A delivery refused by the server-SMTP rules. Not retried: retrying cannot change the outcome. */
export class ServerSmtpSendError extends Error {
  readonly reason: ServerSmtpSendRefusalReason
  /** Seconds until the organization may send again (`rate-limited` only). */
  readonly retryAfterSeconds: number
  constructor(reason: ServerSmtpSendRefusalReason, message: string, retryAfterSeconds = 0) {
    super(message)
    this.name = 'ServerSmtpSendError'
    this.reason = reason
    this.retryAfterSeconds = retryAfterSeconds
  }
}

let limiter: { points: number; limiter: RateLimiter } | undefined

function getLimiter(points: number): RateLimiter {
  if (limiter?.points !== points) {
    limiter = {
      points,
      limiter: createRateLimiter('server-smtp', {
        points,
        duration: RATE_WINDOW_SECONDS,
        // Plain hourly window: no extra block once the budget is spent.
        blockDuration: 0,
      }),
    }
  }
  return limiter.limiter
}

/**
 * Send-time rule for one message through the server SMTP settings. Throws `ServerSmtpSendError`
 * when the option is off, the message has too many recipients, or the organization spent its
 * hourly budget. Fails open (with one warning, see `createRateLimiter`) when Redis is down.
 */
export async function assertServerSmtpSendAllowed({
  orgId,
  config,
}: {
  orgId: OrgId | null | undefined
  config: unknown
}): Promise<void> {
  if (serverSmtpPolicy() === 'off') {
    throw new ServerSmtpSendError('disabled', SERVER_SMTP_OFF_MESSAGE)
  }
  if (countSmtpRecipients(config) > SERVER_SMTP_MAX_RECIPIENTS) {
    throw new ServerSmtpSendError('too-many-recipients', SERVER_SMTP_RECIPIENTS_MESSAGE)
  }
  const points = env.NOTIFICATIONS_SERVER_SMTP_RATE
  if (points === 0) return
  if (orgId === null || orgId === undefined) {
    throw new ServerSmtpSendError(
      'disabled',
      'A channel that sends through the server SMTP settings must belong to an organization.',
    )
  }
  const decision = await getLimiter(points).consume(String(orgId))
  if (!decision.allowed) {
    throw new ServerSmtpSendError(
      'rate-limited',
      `This organization reached its limit of ${points} messages per hour through the server SMTP settings. Try again in ${Math.ceil(decision.retryAfterSeconds / 60)} min.`,
      decision.retryAfterSeconds,
    )
  }
}
