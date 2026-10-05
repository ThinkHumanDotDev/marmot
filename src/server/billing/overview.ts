/**
 * The billing summary shown on the settings page and returned by `GET /api/orgs/:orgId/billing`:
 * plan, subscription status, entitlements and current usage.
 */
import type { Payload } from 'payload'

import {
  effectivePlan,
  isSubscriptionStatus,
  PLAN_LABELS,
  PURCHASABLE_PLANS,
  serializeEntitlements,
  type Plan,
  type SerializedEntitlements,
  type SubscriptionStatus,
} from '@/lib/entitlements'
import { entitlementsFor, getOrgUsage, isBillingEnabled, type UsageCounts } from './entitlements'
import { isStripeConfigured } from './stripe'

import type { Organization } from '@/payload-types'

export interface BillingOverview {
  billingEnabled: boolean
  /** Whether Checkout / Portal can actually be opened (Stripe key configured). */
  stripeConfigured: boolean
  /** The plan stored on the organization (what was bought). */
  plan: Plan
  planLabel: string
  /** The plan whose limits apply (falls back to free when the subscription lapsed). */
  effectivePlan: Plan
  subscriptionStatus: SubscriptionStatus
  hasCustomer: boolean
  hasSubscription: boolean
  entitlements: SerializedEntitlements
  usage: UsageCounts
  /** Plans the organization could upgrade to from here. */
  upgrades: Plan[]
}

export async function getBillingOverview(
  payload: Payload,
  org: Organization,
): Promise<BillingOverview> {
  const plan = (org.plan ?? 'free') as Plan
  const effective = effectivePlan(org)
  const status = isSubscriptionStatus(org.subscriptionStatus) ? org.subscriptionStatus : 'none'
  const [usage] = await Promise.all([getOrgUsage(payload, org.id)])
  const rank = (p: Plan) => ['free', 'team', 'pro', 'enterprise'].indexOf(p)

  return {
    billingEnabled: isBillingEnabled(),
    stripeConfigured: isStripeConfigured(),
    plan,
    planLabel: PLAN_LABELS[plan],
    effectivePlan: effective,
    subscriptionStatus: status,
    hasCustomer: Boolean(org.stripeCustomerId),
    hasSubscription: Boolean(org.stripeSubscriptionId),
    entitlements: serializeEntitlements(entitlementsFor(org)),
    usage,
    upgrades: PURCHASABLE_PLANS.filter((candidate) => rank(candidate) > rank(effective)),
  }
}
