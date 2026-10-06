import { handleProviders } from '@/auth/sso/handlers'

export const dynamic = 'force-dynamic'

/** GET /api/auth/providers → `{ local: true, oidc: { enabled, displayName }, providers: [...] }` */
export async function GET() {
  return handleProviders()
}
