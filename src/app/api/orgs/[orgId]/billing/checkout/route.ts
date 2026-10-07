import { errorText } from '@/server/request-locale'
import { isPlan, PURCHASABLE_PLANS } from '@/lib/entitlements'
import { billingContext, errorResponse, jsonError, readJson } from '@/server/billing/http'
import { createCheckoutSession, type BillingInterval } from '@/server/billing/stripe'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/**
 * POST /api/orgs/:orgId/billing/checkout  `{ plan: 'team' | 'pro', interval?: 'month' | 'year' }`
 * Creates a Stripe Checkout session for the organization and returns `{ url }` (admin+).
 * 501 while billing is disabled, 503 when Stripe is not configured.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { orgId } = await params
  const auth = await billingContext(request, orgId)
  if (!auth.ok) return auth.response
  const { payload, org, user } = auth.ctx

  const body = await readJson<{ plan?: unknown; interval?: unknown }>(request)
  if (!isPlan(body.plan) || !PURCHASABLE_PLANS.includes(body.plan)) {
    return jsonError(
      errorText(request, 'planInvalid', { plans: PURCHASABLE_PLANS.join(', ') }),
      400,
    )
  }
  const interval: BillingInterval | undefined =
    body.interval === 'month' || body.interval === 'year' ? body.interval : undefined

  try {
    const session = await createCheckoutSession({
      payload,
      org,
      plan: body.plan,
      interval,
      requesterEmail: user.email,
    })
    return Response.json(session)
  } catch (error) {
    return errorResponse(error, request)
  }
}
