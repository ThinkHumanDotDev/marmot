import { beginTwoFactorSetup } from '@/auth/two-factor/service'
import { getRequestContext, readJson, unauthorized, withErrors } from '@/server/http'

import { requirePassword } from '../shared'

export const dynamic = 'force-dynamic'

/**
 * POST /api/account/2fa/setup `{ password }` → `{ secret, otpauthUrl, qrDataUrl }`
 *
 * Generates a pending secret for the session user. Login is unaffected until the code is
 * confirmed with `POST /api/account/2fa/verify`. 409 when 2FA is already enabled.
 */
export const POST = withErrors(async (request: Request) => {
  const { payload, user } = await getRequestContext(request)
  if (!user) return unauthorized(request)
  const { password } = await readJson<{ password?: unknown }>(request)
  await requirePassword(payload, user, password)
  const setup = await beginTwoFactorSetup(payload, user.id)
  return Response.json(setup, { headers: { 'Cache-Control': 'no-store' } })
})
