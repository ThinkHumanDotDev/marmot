import { handlePasswordLogin } from '@/auth/two-factor/handlers'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/login `{ email, password }` → session cookie + `{ user, exp }`, or
 * `{ requiresTwoFactor: true, challenge }` + the `marmot-2fa` challenge cookie when the account
 * has two-factor authentication (continue with `POST /api/auth/2fa`).
 */
export async function POST(request: Request) {
  return handlePasswordLogin(request)
}
