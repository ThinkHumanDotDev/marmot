import type Stripe from 'stripe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadEnv, resetEnvCache } from '@/env'
import { PLAN_LIMITS, PURCHASABLE_PLANS, serializeEntitlements } from '@/lib/entitlements'
import { MARMOT_VERSION } from '@/lib/version'
import {
  getPricingPlans,
  isPricingEnabled,
  resetPricingCache,
  type PriceLister,
} from '@/server/billing/pricing'
import { getSiteLinks, REPOSITORY_URL } from '@/server/site-links'

const FLAGS = [
  'LANDING_PAGE_ENABLED',
  'BILLING_ENABLED',
  'STRIPE_SECRET_KEY',
  'TERMS_URL',
  'PRIVACY_URL',
  'SOURCE_URL',
] as const
const saved: Partial<Record<(typeof FLAGS)[number], string>> = {}

const setEnv = (values: Partial<Record<(typeof FLAGS)[number], string>>) => {
  for (const key of FLAGS) {
    if (values[key] === undefined) delete process.env[key]
    else process.env[key] = values[key]
  }
  resetEnvCache()
  resetPricingCache()
}

/** A Stripe client stub whose `prices.list` returns `prices` and counts the calls. */
function stubStripe(prices: Partial<Stripe.Price>[]): PriceLister & { calls: number } {
  const stub = {
    calls: 0,
    prices: {
      list: async () => {
        stub.calls++
        return { data: prices } as unknown as Stripe.ApiList<Stripe.Price>
      },
    },
  }
  return stub as unknown as PriceLister & { calls: number }
}

const price = (
  plan: string | undefined,
  interval: 'month' | 'year',
  cents: number,
  where: 'price' | 'product' = 'price',
): Partial<Stripe.Price> => ({
  unit_amount: cents,
  currency: 'usd',
  recurring: { interval, interval_count: 1 } as Stripe.Price.Recurring,
  metadata: where === 'price' && plan ? { plan } : {},
  product: { metadata: where === 'product' && plan ? { plan } : {} } as Stripe.Product,
})

describe('/pricing (#178)', () => {
  beforeEach(() => {
    for (const key of FLAGS) saved[key] = process.env[key]
  })
  afterEach(() => setEnv(saved))

  // `src/app/(frontend)/pricing/page.tsx` answers 404 (`notFound()`) when this returns null.
  it('is a 404 unless both the landing page and billing are on', async () => {
    for (const flags of [
      {},
      { LANDING_PAGE_ENABLED: 'true' },
      { BILLING_ENABLED: 'true' },
      { LANDING_PAGE_ENABLED: 'false', BILLING_ENABLED: 'true' },
    ]) {
      setEnv(flags)
      expect(isPricingEnabled()).toBe(false)
      expect(await getPricingPlans({ stripe: stubStripe([]) })).toBeNull()
    }
  })

  it('lists the free plan and every purchasable plan with the enforced limits, without prices when Stripe is not configured', async () => {
    setEnv({ LANDING_PAGE_ENABLED: 'true', BILLING_ENABLED: 'true' })
    expect(isPricingEnabled()).toBe(true)
    const plans = await getPricingPlans()
    expect(plans?.map((p) => p.plan)).toEqual(['free', ...PURCHASABLE_PLANS])
    for (const plan of plans ?? []) {
      expect(plan.limits).toEqual(serializeEntitlements(PLAN_LIMITS[plan.plan]))
      expect(plan.prices).toEqual({ month: null, year: null })
    }
    expect(plans?.[0]?.purchasable).toBe(false)
    expect(plans?.slice(1).every((p) => p.purchasable)).toBe(true)
  })

  it('takes monthly and yearly prices from the Stripe prices tagged with the plan', async () => {
    setEnv({ LANDING_PAGE_ENABLED: 'true', BILLING_ENABLED: 'true' })
    const stripe = stubStripe([
      price('team', 'month', 1200),
      price('team', 'year', 12000, 'product'),
      price('team', 'month', 9900), // older duplicate: the first listed wins, as at checkout
      price('pro', 'month', 4950),
      price(undefined, 'month', 100), // untagged
      price('enterprise', 'month', 99900), // not purchasable
    ])
    const plans = await getPricingPlans({ stripe })
    const byPlan = Object.fromEntries((plans ?? []).map((p) => [p.plan, p.prices]))
    expect(byPlan.team).toEqual({
      month: { amount: 12, currency: 'USD' },
      year: { amount: 120, currency: 'USD' },
    })
    expect(byPlan.pro).toEqual({ month: { amount: 49.5, currency: 'USD' }, year: null })
    expect(byPlan.free).toEqual({ month: null, year: null })
    expect(byPlan.enterprise).toBeUndefined()

    // Cached: a second view does not hit Stripe again.
    await getPricingPlans({ stripe })
    expect(stripe.calls).toBe(1)
  })

  it('shows limits without prices when Stripe fails', async () => {
    setEnv({ LANDING_PAGE_ENABLED: 'true', BILLING_ENABLED: 'true' })
    const failing = {
      prices: {
        list: async () => {
          throw new Error('stripe down')
        },
      },
    } as unknown as PriceLister
    const plans = await getPricingPlans({ stripe: failing })
    expect(plans?.every((p) => p.prices.month === null && p.prices.year === null)).toBe(true)
  })
})

describe('terms, privacy and source links (#178)', () => {
  const base = {
    NODE_ENV: 'test' as const,
    PAYLOAD_SECRET: 'x'.repeat(16),
    DATABASE_URL: 'postgres://x',
  }

  beforeEach(() => {
    for (const key of FLAGS) saved[key] = process.env[key]
  })
  afterEach(() => setEnv(saved))

  it('treats empty TERMS_URL / PRIVACY_URL / SOURCE_URL as unset and rejects non-URLs', () => {
    const env = loadEnv({ ...base, TERMS_URL: '', PRIVACY_URL: ' ', SOURCE_URL: '' })
    expect(env.TERMS_URL).toBeUndefined()
    expect(env.PRIVACY_URL).toBeUndefined()
    expect(env.SOURCE_URL).toBeUndefined()
    expect(() => loadEnv({ ...base, TERMS_URL: 'not a url' })).toThrow(/TERMS_URL/)
  })

  it('links the source at the running version unless SOURCE_URL is set', () => {
    setEnv({})
    expect(getSiteLinks()).toEqual({
      termsUrl: null,
      privacyUrl: null,
      sourceUrl: `${REPOSITORY_URL}/tree/v${MARMOT_VERSION}`,
    })
    setEnv({
      TERMS_URL: 'https://example.com/terms',
      PRIVACY_URL: 'https://example.com/privacy',
      SOURCE_URL: 'https://git.example.com/marmot-fork',
    })
    expect(getSiteLinks()).toEqual({
      termsUrl: 'https://example.com/terms',
      privacyUrl: 'https://example.com/privacy',
      sourceUrl: 'https://git.example.com/marmot-fork',
    })
  })
})
