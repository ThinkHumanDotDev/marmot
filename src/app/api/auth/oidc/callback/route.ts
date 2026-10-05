import { handleOidcCallback } from '@/auth/oidc/handlers'

export const dynamic = 'force-dynamic'

/** GET /api/auth/oidc/callback — redirect URI registered at the identity provider. */
export async function GET(request: Request) {
  return handleOidcCallback(request)
}
