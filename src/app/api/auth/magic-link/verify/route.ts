import { handleMagicLinkVerify } from '@/server/auth/magic-link'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/magic-link/verify `{ token }` → session cookie + `{ user, exp, created }`, or
 * `{ requiresTwoFactor: true, challenge }` + the `marmot-2fa` challenge cookie when the account has
 * two-factor authentication (continue with `POST /api/auth/2fa`). 400 for an unknown, expired or
 * used link, 403 when the password policy (SSO-only mode, organization enforcement) refuses it.
 */
export async function POST(request: Request) {
  return handleMagicLinkVerify(request)
}
