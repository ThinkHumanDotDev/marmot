/**
 * Data behind the public `/pricing` page (#178). Plans and limits come from `PURCHASABLE_PLANS` /
 * `PLAN_LIMITS` and prices from the active Stripe prices tagged `metadata.plan`, the same source
 * the checkout route uses, so the page cannot drift from what is enforced and sold.
 */
import type Stripe from 'stripe'

import { env } from '@/env'
import {
  PLAN_LABELS,
  PLAN_LIMITS,
  PURCHASABLE_PLANS,
  serializeEntitlements,
  type Plan,
  type SerializedEntitlements,
} from '@/lib/entitlements'
import { childLogger } from '@/lib/logger'

import { getStripeClient, isStripeConfigured, planOfPrice, type BillingInterval } from './stripe'

const log = childLogger('billing')

/** A price as the page renders it: the amount in the currency's major unit (`12.5` = $12.50). */
export interface PlanPrice {
  amount: number
  currency: string
}

export interface PricingPlan {
  plan: Plan
  label: string
  limits: SerializedEntitlements
  /** `false` for the free plan every new organization starts on (no Stripe price). */
  purchasable: boolean
  /** `null` when Stripe is not configured or has no active price for that interval. */
  prices: Record<BillingInterval, PlanPrice | null>
}

/** `/pricing` exists only on a hosted instance that sells plans: landing page and billing on. */
export const isPricingEnabled = (): boolean => env.LANDING_PAGE_ENABLED && env.BILLING_ENABLED

/** The subset of the Stripe client the page needs (tests pass a stub). */
export type PriceLister = { prices: Pick<Stripe['prices'], 'list'> }

const CACHE_MS = 5 * 60_000
let cache: { at: number; prices: Map<string, PlanPrice> } | undefined

/** Forgets the cached Stripe prices (tests). */
export function resetPricingCache(): void {
  cache = undefined
}

const priceKey = (plan: string, interval: BillingInterval) => `${plan}:${interval}`

/**
 * Active recurring prices by `plan:interval`. Cached for five minutes so an anonymous page does not
 * hit the Stripe API on every view; a Stripe error yields no prices rather than a broken page.
 */
async function loadPrices(stripe?: PriceLister): Promise<Map<string, PlanPrice>> {
  if (!stripe && !isStripeConfigured()) return new Map()
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.prices
  const prices = new Map<string, PlanPrice>()
  try {
    const client = stripe ?? (await getStripeClient())
    const { data } = await client.prices.list({
      active: true,
      type: 'recurring',
      limit: 100,
      expand: ['data.product'],
    })
    for (const price of data) {
      const plan = planOfPrice(price)
      const interval = price.recurring?.interval
      if (!plan || (interval !== 'month' && interval !== 'year')) continue
      if (price.unit_amount === null || price.recurring?.interval_count !== 1) continue
      const key = priceKey(plan, interval)
      // The first match wins, as in `findPriceForPlan` (Stripe lists the newest first).
      if (prices.has(key)) continue
      prices.set(key, { amount: price.unit_amount / 100, currency: price.currency.toUpperCase() })
    }
  } catch (error) {
    log.warn({ err: error }, 'failed to load stripe prices for the pricing page')
    return new Map()
  }
  cache = { at: Date.now(), prices }
  return prices
}

/**
 * The free plan new organizations start on, then every purchasable plan with its limits and its
 * monthly and yearly price; `null` when the pricing page is switched off (the page answers 404).
 */
export async function getPricingPlans(
  options: { stripe?: PriceLister } = {},
): Promise<PricingPlan[] | null> {
  if (!isPricingEnabled()) return null
  const prices = await loadPrices(options.stripe)
  const free: PricingPlan = {
    plan: 'free',
    label: PLAN_LABELS.free,
    limits: serializeEntitlements(PLAN_LIMITS.free),
    purchasable: false,
    prices: { month: null, year: null },
  }
  return [
    free,
    ...PURCHASABLE_PLANS.map((plan) => ({
      plan,
      label: PLAN_LABELS[plan],
      limits: serializeEntitlements(PLAN_LIMITS[plan]),
      purchasable: true,
      prices: {
        month: prices.get(priceKey(plan, 'month')) ?? null,
        year: prices.get(priceKey(plan, 'year')) ?? null,
      },
    })),
  ]
}
