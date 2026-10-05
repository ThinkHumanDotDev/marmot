import { APIError } from 'payload'

import {
  getTwoFactorStatus,
  regenerateBackupCodes,
  verifyTwoFactorCode,
} from '@/auth/two-factor/service'
import { getRequestContext, readJson, unauthorized, withErrors } from '@/server/http'

import { requireCode } from '../shared'

export const dynamic = 'force-dynamic'

/** GET /api/account/2fa/backup-codes → `{ enabled, verifiedAt, backupCodesRemaining }` */
export const GET = withErrors(async (request: Request) => {
  const { payload, user } = await getRequestContext(request)
  if (!user) return unauthorized()
  return Response.json(await getTwoFactorStatus(payload, user.id), {
    headers: { 'Cache-Control': 'no-store' },
  })
})

/**
 * POST /api/account/2fa/backup-codes `{ code }` → `{ backupCodes }`
 *
 * Replaces the backup codes after a valid authenticator code. Old codes stop working at once.
 */
export const POST = withErrors(async (request: Request) => {
  const { payload, user } = await getRequestContext(request)
  if (!user) return unauthorized()
  const { code } = await readJson<{ code?: unknown }>(request)
  if (user.twoFactorEnabled !== true) {
    throw new APIError('Two-factor authentication is not enabled.', 409)
  }
  const method = await verifyTwoFactorCode(payload, user.id, requireCode(code))
  if (method !== 'totp') throw new APIError('Enter a code from your authenticator app.', 400)
  const { backupCodes } = await regenerateBackupCodes(payload, user.id)
  return Response.json({ backupCodes }, { headers: { 'Cache-Control': 'no-store' } })
})
