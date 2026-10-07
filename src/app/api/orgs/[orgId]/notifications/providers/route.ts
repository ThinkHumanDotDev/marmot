import { getProviderDescriptors, resolveOrgRequest } from '@/server/notifications/api'
import { requestLocale } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/** GET /api/orgs/:orgId/notifications/providers — form descriptors of every provider. */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'notification:read')
  if (ctx instanceof Response) return ctx
  return Response.json({ providers: getProviderDescriptors(requestLocale(request)) })
}
