import {
  getTwoFactorStatus,
  regenerateBackupCodes,
  verifyTwoFactorCode,
} from '@/auth/two-factor/service'
import { getRequestContext, readJson, unauthorized, withErrors } from '@/server/http'
import { recordUserAuditEvent } from '@/server/security/audit'

import { requireCode } from '../shared'
import { apiError } from '@/server/errors'

export const dynamic = 'force-dynamic'

/** GET /api/account/2fa/backup-codes → `{ enabled, verifiedAt, backupCodesRemaining }` */
export const GET = withErrors(async (request: Request) => {
  const { payload, user } = await getRequestContext(request)
  if (!user) return unauthorized(request)
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
  if (!user) return unauthorized(request)
  const { code } = await readJson<{ code?: unknown }>(request)
  if (user.twoFactorEnabled !== true) {
    throw apiError('twoFactorNotEnabled', 409)
  }
  const method = await verifyTwoFactorCode(payload, user.id, requireCode(code))
  if (method !== 'totp') throw apiError('totpCodeRequired', 400)
  const { backupCodes } = await regenerateBackupCodes(payload, user.id)
  await recordUserAuditEvent(payload, request, user, 'auth.backup_codes_regenerated')
  return Response.json({ backupCodes }, { headers: { 'Cache-Control': 'no-store' } })
})
