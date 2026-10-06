import { handleSamlMetadata } from '@/auth/sso/handlers'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ connection: string }> }

/** GET /api/auth/saml/:connection/metadata — service-provider metadata XML for the IdP. */
export async function GET(request: Request, { params }: Context) {
  return handleSamlMetadata(request, (await params).connection)
}
