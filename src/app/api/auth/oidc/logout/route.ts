import { handleSsoLogout } from '@/auth/sso/handlers'

export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/oidc/logout — clears the Payload session and redirects to the provider's
 * end-session endpoint when it has one. Returns `{ redirectTo }` for JSON clients. Same as
 * `/api/auth/sso/logout`; kept for existing clients.
 */
export async function POST(request: Request) {
  return handleSsoLogout(request)
}
