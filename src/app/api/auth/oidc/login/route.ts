import { handleOidcLogin } from '@/auth/oidc/handlers'

export const dynamic = 'force-dynamic'

/** GET /api/auth/oidc/login?next=/path — starts the OIDC authorization code flow (PKCE). */
export async function GET(request: Request) {
  return handleOidcLogin(request)
}
