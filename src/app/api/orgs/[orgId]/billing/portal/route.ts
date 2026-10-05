import { billingContext, errorResponse } from '@/server/billing/http'
import { createPortalSession } from '@/server/billing/stripe'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/**
 * POST /api/orgs/:orgId/billing/portal — opens the Stripe Billing Portal for the organization's
 * customer and returns `{ url }` (admin+). 501 while billing is disabled, 503 without Stripe.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const auth = await billingContext(request, orgId)
  if (!auth.ok) return auth.response
  const { payload, org, user } = auth.ctx
  try {
    return Response.json(await createPortalSession(payload, org, { requesterEmail: user.email }))
  } catch (error) {
    return errorResponse(error)
  }
}
