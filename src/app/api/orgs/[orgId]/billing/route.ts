import { billingContext, errorResponse } from '@/server/billing/http'
import { getBillingOverview } from '@/server/billing/overview'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/**
 * GET /api/orgs/:orgId/billing — plan, subscription status, entitlements and usage (admin+).
 * 501 `{ error: 'billing disabled' }` while `BILLING_ENABLED` is off.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const auth = await billingContext(request, orgId)
  if (!auth.ok) return auth.response
  try {
    return Response.json(await getBillingOverview(auth.ctx.payload, auth.ctx.org))
  } catch (error) {
    return errorResponse(error)
  }
}
