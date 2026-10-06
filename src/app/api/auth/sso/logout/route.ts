import { handleSsoLogout } from '@/auth/sso/handlers'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/sso/logout `{ provider? }` — clears the Payload session and, when the provider the
 * user signed in with advertises an end-session endpoint, answers with its URL (`{ redirectTo }` for
 * JSON clients, a 303 otherwise) so the identity-provider session ends too.
 */
export async function POST(request: Request) {
  return handleSsoLogout(request)
}
