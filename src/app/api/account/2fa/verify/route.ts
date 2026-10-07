import { confirmTwoFactorSetup } from '@/auth/two-factor/service'
import { getRequestContext, readJson, unauthorized, withErrors } from '@/server/http'
import { recordUserAuditEvent } from '@/server/security/audit'

import { requireCode } from '../shared'

export const dynamic = 'force-dynamic'

/**
 * POST /api/account/2fa/verify `{ code }` → `{ enabled: true, backupCodes }`
 *
 * Confirms the pending setup with a code from the authenticator app and turns 2FA on. The backup
 * codes are returned exactly once; regenerate them later via `POST /api/account/2fa/backup-codes`.
 */
export const POST = withErrors(async (request: Request) => {
  const { payload, user } = await getRequestContext(request)
  if (!user) return unauthorized(request)
  const { code } = await readJson<{ code?: unknown }>(request)
  const { backupCodes } = await confirmTwoFactorSetup(payload, user.id, requireCode(code))
  await recordUserAuditEvent(payload, request, user, 'auth.two_factor_enabled')
  return Response.json({ enabled: true, backupCodes }, { headers: { 'Cache-Control': 'no-store' } })
})
