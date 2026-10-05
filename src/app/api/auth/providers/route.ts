import { handleProviders } from '@/auth/oidc/handlers'

export const dynamic = 'force-dynamic'

/** GET /api/auth/providers → `{ local: true, oidc: { enabled, displayName } }` */
export async function GET() {
  return handleProviders()
}
