/**
 * Thin Stripe client layer for the billing routes: customers, Checkout and the Billing Portal.
 * The SDK is loaded lazily (`import('stripe')`) so a self-hosted install that never sets
 * `STRIPE_SECRET_KEY` does not pull Stripe into the module graph of the web process.
 */
import type Stripe from 'stripe'
import { APIError, type Payload, type PayloadRequest } from 'payload'

import { env } from '@/env'
import { PLAN_LABELS, PURCHASABLE_PLANS, type Plan } from '@/lib/entitlements'
import { childLogger } from '@/lib/logger'

import type { Organization } from '@/payload-types'

const log = childLogger('billing')

export const isStripeConfigured = (): boolean => Boolean(env.STRIPE_SECRET_KEY)

let client: Promise<Stripe> | undefined

/** One Stripe client per process, created on first use. Throws 503 when no key is configured. */
export async function getStripeClient(): Promise<Stripe> {
  const key = env.STRIPE_SECRET_KEY
  if (!key) throw new APIError('Stripe is not configured.', 503, undefined, true)
  client ??= import('stripe').then(
    ({ default: StripeSdk }) =>
      new StripeSdk(key, {
        // Same SDK major and API version as @payloadcms/plugin-stripe, so one copy is installed.
        apiVersion: '2022-08-01',
        appInfo: { name: 'Marmot', url: 'https://github.com/ThinkHumanDotDev/marmot' },
      }),
  )
  return client
}

/** Forgets the cached client (tests). */
export function resetStripeClient(): void {
  client = undefined
}

type OrgId = Organization['id']

async function ownerEmail(payload: Payload, orgId: OrgId): Promise<string | undefined> {
  const { docs } = await payload.find({
    collection: 'users',
    where: { 'organizations.organization': { equals: orgId } },
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
  })
  const owner = docs.find((user) =>
    (user.organizations ?? []).some(
      (row) =>
        row.role === 'owner' &&
        String(typeof row.organization === 'object' ? row.organization.id : row.organization) ===
          String(orgId),
    ),
  )
  return owner?.email ?? docs[0]?.email
}

/**
 * Returns the organization's Stripe customer id, creating the customer (name + owner email) and
 * storing the id on the organization when it has none yet.
 */
export async function ensureStripeCustomer(
  payload: Payload,
  org: Organization,
  options: { req?: PayloadRequest; fallbackEmail?: string } = {},
): Promise<string> {
  if (org.stripeCustomerId) return org.stripeCustomerId
  const stripe = await getStripeClient()
  const email = (await ownerEmail(payload, org.id)) ?? options.fallbackEmail
  const customer = await stripe.customers.create({
    name: org.name,
    email,
    metadata: { organizationId: String(org.id), organizationSlug: org.slug },
  })
  await payload.update({
    collection: 'organizations',
    id: org.id,
    data: { stripeCustomerId: customer.id },
    depth: 0,
    req: options.req,
    overrideAccess: true,
    context: { skipStripeSync: true },
  })
  return customer.id
}

/** Pushes a renamed organization to its Stripe customer. Errors are logged, never thrown. */
export async function syncStripeCustomerName(org: Organization): Promise<void> {
  if (!org.stripeCustomerId || !isStripeConfigured()) return
  try {
    const stripe = await getStripeClient()
    await stripe.customers.update(org.stripeCustomerId, { name: org.name })
  } catch (error) {
    log.warn({ err: error, organization: org.id }, 'failed to sync organization name to stripe')
  }
}

export type BillingInterval = 'month' | 'year'

/**
 * Finds the active recurring price whose `metadata.plan` (or its product's) is `plan`. Prices are
 * configured in the Stripe dashboard; no price ids live in the environment.
 */
export async function findPriceForPlan(
  stripe: Stripe,
  plan: Plan,
  interval?: BillingInterval,
): Promise<Stripe.Price | null> {
  const prices = await stripe.prices.list({
    active: true,
    type: 'recurring',
    limit: 100,
    expand: ['data.product'],
  })
  const matches = prices.data.filter((price) => {
    const product = price.product
    const productPlan =
      product && typeof product === 'object' && 'metadata' in product
        ? product.metadata?.plan
        : undefined
    const priced = price.metadata?.plan ?? productPlan
    if (priced !== plan) return false
    return interval ? price.recurring?.interval === interval : true
  })
  // Prefer monthly when no interval was requested so the default upgrade is the cheaper commitment.
  return (
    matches.find((price) => price.recurring?.interval === (interval ?? 'month')) ??
    matches[0] ??
    null
  )
}

export interface CheckoutArgs {
  payload: Payload
  org: Organization
  plan: Plan
  interval?: BillingInterval
  /** Email of the requesting user; used when the organization has no owner (should not happen). */
  requesterEmail?: string
  req?: PayloadRequest
}

const settingsUrl = (org: Organization, query: string) =>
  `${env.NEXT_PUBLIC_SERVER_URL.replace(/\/$/, '')}/${org.slug}/settings/billing?${query}`

/** Creates a Stripe Checkout session that subscribes the organization to `plan`. */
export async function createCheckoutSession({
  payload,
  org,
  plan,
  interval,
  requesterEmail,
  req,
}: CheckoutArgs): Promise<{ url: string; sessionId: string }> {
  if (!PURCHASABLE_PLANS.includes(plan)) {
    throw new APIError(
      `The ${PLAN_LABELS[plan]} plan cannot be purchased online.`,
      400,
      undefined,
      true,
    )
  }
  const stripe = await getStripeClient()
  const price = await findPriceForPlan(stripe, plan, interval)
  if (!price) {
    throw new APIError(
      `No active Stripe price is tagged with metadata plan=${plan}.`,
      503,
      undefined,
      true,
    )
  }
  const customer = await ensureStripeCustomer(payload, org, { req, fallbackEmail: requesterEmail })
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer,
    line_items: [{ price: price.id, quantity: 1 }],
    success_url: settingsUrl(org, 'checkout=success'),
    cancel_url: settingsUrl(org, 'checkout=canceled'),
    client_reference_id: String(org.id),
    allow_promotion_codes: true,
    subscription_data: { metadata: { organizationId: String(org.id), plan } },
    metadata: { organizationId: String(org.id), plan },
  })
  if (!session.url) throw new APIError('Stripe did not return a checkout URL.', 502)
  return { url: session.url, sessionId: session.id }
}

/** Creates a Billing Portal session for the organization's customer. */
export async function createPortalSession(
  payload: Payload,
  org: Organization,
  options: { req?: PayloadRequest; requesterEmail?: string } = {},
): Promise<{ url: string }> {
  const stripe = await getStripeClient()
  const customer = await ensureStripeCustomer(payload, org, {
    req: options.req,
    fallbackEmail: options.requesterEmail,
  })
  const session = await stripe.billingPortal.sessions.create({
    customer,
    return_url: settingsUrl(org, 'portal=return'),
  })
  return { url: session.url }
}
