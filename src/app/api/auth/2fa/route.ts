import { handleTwoFactorLogin } from '@/auth/two-factor/handlers'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/2fa `{ code, challenge? }` → verifies a TOTP or backup code for the challenge
 * issued by `POST /api/auth/login` (cookie, or `challenge` in the body) and sets the session cookie.
 */
export async function POST(request: Request) {
  return handleTwoFactorLogin(request)
}
