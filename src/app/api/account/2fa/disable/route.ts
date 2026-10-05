import { APIError } from 'payload'

import { disableTwoFactor, verifyTwoFactorCode } from '@/auth/two-factor/service'
import { getRequestContext, readJson, unauthorized, withErrors } from '@/server/http'

import { requireCode, requirePassword } from '../shared'

export const dynamic = 'force-dynamic'

/**
 * POST /api/account/2fa/disable `{ password, code }` → `{ enabled: false }`
 *
 * Requires the password (local accounts) and a current TOTP or backup code, so a hijacked
 * session alone cannot switch the protection off.
 */
export const POST = withErrors(async (request: Request) => {
  const { payload, user } = await getRequestContext(request)
  if (!user) return unauthorized()
  const { password, code } = await readJson<{ password?: unknown; code?: unknown }>(request)
  if (user.twoFactorEnabled !== true) {
    throw new APIError('Two-factor authentication is not enabled.', 409)
  }
  await requirePassword(payload, user, password)
  const method = await verifyTwoFactorCode(payload, user.id, requireCode(code))
  if (!method) throw new APIError('That code is not valid.', 400)
  await disableTwoFactor(payload, user.id)
  return Response.json({ enabled: false })
})
