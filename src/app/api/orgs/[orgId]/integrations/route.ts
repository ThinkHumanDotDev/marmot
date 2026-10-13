import {
  createIntegration,
  createIntegrationSchema,
  integrationEndpoints,
  listIntegrations,
} from '@/server/integrations/manage'
import {
  errorMessage,
  errorStatus,
  jsonError,
  readJson,
  resolveOrgRequest,
} from '@/server/notifications/api'
import { errorText } from '@/server/request-locale'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/** GET /api/orgs/:orgId/integrations — inbound alert integrations, without tokens (`integration:read`). */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'integration:read')
  if (ctx instanceof Response) return ctx
  return Response.json({ docs: await listIntegrations(ctx) })
}

/**
 * POST /api/orgs/:orgId/integrations `{ name, format, rules?, generic?, … }` — create an integration
 * (`integration:manage`). The response carries the `token` (and the `url` and `email` built from it)
 * exactly once.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const ctx = await resolveOrgRequest(request, orgId, 'integration:manage')
  if (ctx instanceof Response) return ctx

  const body = await readJson(request)
  if (!body) return jsonError(400, errorText(request, 'invalidJsonBody'))
  const parsed = createIntegrationSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(400, parsed.error.issues[0]?.message ?? errorText(request, 'validationFailed'))
  }
  try {
    const { integration, token } = await createIntegration(ctx, parsed.data)
    return Response.json(
      { doc: integration, token, ...integrationEndpoints(token) },
      { status: 201 },
    )
  } catch (error) {
    return jsonError(errorStatus(error), errorMessage(error, request))
  }
}
