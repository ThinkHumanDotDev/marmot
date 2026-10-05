/**
 * Stripe webhook handlers for the billing scaffold. They map a subscription's price / product /
 * subscription `metadata.plan` to `organizations.plan` and Stripe's subscription status to
 * `organizations.subscriptionStatus`. Registered with `@payloadcms/plugin-stripe` in
 * `src/plugins/index.ts` only when `STRIPE_SECRET_KEY` is set; the plugin verifies the signature
 * and serves `POST /api/stripe/webhooks`.
 *
 * The handlers are written against a minimal structural view of the Stripe objects so they can be
 * unit-tested with plain fixtures and do not pull the Stripe SDK into the module graph.
 */
import type { StripeWebhookHandler, StripeWebhookHandlers } from '@payloadcms/plugin-stripe/types'
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import { isPlan, type Plan, type SubscriptionStatus } from '@/lib/entitlements'

import type { Organization } from '@/payload-types'

const log = childLogger('billing')

type Metadata = Record<string, string> | null | undefined

export interface StripeProductLike {
  id: string
  metadata?: Metadata
}

export interface StripePriceLike {
  id: string
  metadata?: Metadata
  product?: string | StripeProductLike | null
}

export interface StripeSubscriptionLike {
  id: string
  customer: string | { id: string }
  status: string
  metadata?: Metadata
  items?: { data?: { price?: StripePriceLike | null }[] }
}

export interface StripeCustomerLike {
  id: string
}

export interface SubscriptionEventLike {
  id?: string
  type: string
  data: { object: StripeSubscriptionLike }
}

export interface CustomerEventLike {
  id?: string
  type: string
  data: { object: StripeCustomerLike }
}

export const SUBSCRIPTION_EVENTS = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
] as const

/** Stripe subscription status → `organizations.subscriptionStatus`. */
export function mapSubscriptionStatus(status: string): SubscriptionStatus {
  switch (status) {
    case 'trialing':
    case 'active':
    case 'past_due':
    case 'canceled':
    case 'unpaid':
      return status
    case 'paused':
      return 'past_due'
    case 'incomplete_expired':
      return 'canceled'
    case 'incomplete':
    default:
      return 'none'
  }
}

export const customerId = (customer: StripeSubscriptionLike['customer']): string =>
  typeof customer === 'string' ? customer : customer.id

/**
 * Resolves the plan a subscription buys. Precedence: `price.metadata.plan`, then the product's
 * `metadata.plan` (expanded inline or fetched through `resolveProductPlan`), then the subscription's
 * own `metadata.plan` (set by our Checkout session). Returns `null` when nothing matches a known plan.
 */
export async function planFromSubscription(
  subscription: StripeSubscriptionLike,
  resolveProductPlan?: (productId: string) => Promise<string | null | undefined>,
): Promise<Plan | null> {
  for (const item of subscription.items?.data ?? []) {
    const price = item.price
    if (!price) continue
    if (isPlan(price.metadata?.plan)) return price.metadata.plan
    const product = price.product
    if (product && typeof product === 'object') {
      if (isPlan(product.metadata?.plan)) return product.metadata.plan
    } else if (typeof product === 'string' && resolveProductPlan) {
      const plan = await resolveProductPlan(product)
      if (isPlan(plan)) return plan
    }
  }
  const own = subscription.metadata?.plan
  return isPlan(own) ? own : null
}

/** The organization a subscription belongs to: by subscription id, then customer, then metadata. */
export async function findOrganizationForSubscription(
  payload: Payload,
  subscription: StripeSubscriptionLike,
): Promise<Organization | null> {
  const customer = customerId(subscription.customer)
  const or: Record<string, unknown>[] = [
    { stripeSubscriptionId: { equals: subscription.id } },
    { stripeCustomerId: { equals: customer } },
  ]
  const { docs } = await payload.find({
    collection: 'organizations',
    where: { or } as never,
    depth: 0,
    limit: 2,
    overrideAccess: true,
  })
  const bySubscription = docs.find((doc) => doc.stripeSubscriptionId === subscription.id)
  if (bySubscription) return bySubscription
  if (docs[0]) return docs[0]

  const orgId = subscription.metadata?.organizationId
  if (!orgId) return null
  const id = payload.db.defaultIDType === 'number' && /^\d+$/.test(orgId) ? Number(orgId) : orgId
  const org = await payload.findByID({
    collection: 'organizations',
    id,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
  })
  return org ?? null
}

export interface SubscriptionChange {
  organization: Organization['id']
  plan: Plan
  subscriptionStatus: SubscriptionStatus
  stripeSubscriptionId: string | null
  stripeCustomerId: string
}

export interface HandleSubscriptionOptions {
  resolveProductPlan?: (productId: string) => Promise<string | null | undefined>
}

/**
 * Applies a `customer.subscription.*` event to the owning organization. Returns what was written,
 * or `null` when the subscription could not be matched to an organization (logged, not thrown, so
 * Stripe does not retry forever).
 */
export async function handleSubscriptionEvent(
  payload: Payload,
  event: SubscriptionEventLike,
  { resolveProductPlan }: HandleSubscriptionOptions = {},
): Promise<SubscriptionChange | null> {
  const subscription = event.data.object
  const org = await findOrganizationForSubscription(payload, subscription)
  if (!org) {
    log.warn(
      { event: event.id, type: event.type, subscription: subscription.id },
      'stripe subscription does not match any organization',
    )
    return null
  }

  const deleted = event.type === 'customer.subscription.deleted'
  const status = deleted ? 'canceled' : mapSubscriptionStatus(subscription.status)
  const resolved = deleted ? null : await planFromSubscription(subscription, resolveProductPlan)
  if (!deleted && !resolved) {
    log.warn(
      { event: event.id, subscription: subscription.id, organization: org.id },
      'stripe subscription carries no known plan metadata; keeping the current plan',
    )
  }

  const change: SubscriptionChange = {
    organization: org.id,
    plan: deleted ? 'free' : (resolved ?? (isPlan(org.plan) ? org.plan : 'free')),
    subscriptionStatus: status,
    stripeSubscriptionId: deleted ? null : subscription.id,
    stripeCustomerId: customerId(subscription.customer),
  }

  await payload.update({
    collection: 'organizations',
    id: org.id,
    data: {
      plan: change.plan,
      subscriptionStatus: change.subscriptionStatus,
      stripeSubscriptionId: change.stripeSubscriptionId,
      stripeCustomerId: change.stripeCustomerId,
    },
    depth: 0,
    overrideAccess: true,
    context: { skipStripeSync: true },
  })

  log.info(
    { organization: org.id, plan: change.plan, status: change.subscriptionStatus },
    'applied stripe subscription event',
  )
  return change
}

/** `customer.deleted`: forget the customer and subscription; the plan falls back to free. */
export async function handleCustomerDeleted(
  payload: Payload,
  event: CustomerEventLike,
): Promise<Organization['id'] | null> {
  const { docs } = await payload.find({
    collection: 'organizations',
    where: { stripeCustomerId: { equals: event.data.object.id } },
    depth: 0,
    limit: 1,
    overrideAccess: true,
  })
  const org = docs[0]
  if (!org) return null
  await payload.update({
    collection: 'organizations',
    id: org.id,
    data: {
      plan: 'free',
      subscriptionStatus: 'none',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    },
    depth: 0,
    overrideAccess: true,
    context: { skipStripeSync: true },
  })
  return org.id
}

/** Looks a product up through the plugin's Stripe client to read `metadata.plan`. */
const productPlanResolver =
  (stripe: { products: { retrieve: (id: string) => Promise<unknown> } }) =>
  async (productId: string) => {
    try {
      const product = (await stripe.products.retrieve(productId)) as StripeProductLike
      return product.metadata?.plan
    } catch (error) {
      log.warn({ err: error, product: productId }, 'failed to load stripe product')
      return null
    }
  }

const subscriptionHandler: StripeWebhookHandler<SubscriptionEventLike> = async ({
  event,
  payload,
  stripe,
}) => {
  await handleSubscriptionEvent(payload, event, { resolveProductPlan: productPlanResolver(stripe) })
}

const customerDeletedHandler: StripeWebhookHandler<CustomerEventLike> = async ({
  event,
  payload,
}) => {
  await handleCustomerDeleted(payload, event)
}

/** Handlers keyed by Stripe event type, as `stripePlugin({ webhooks })` expects them. */
export const stripeWebhookHandlers: StripeWebhookHandlers = {
  'customer.subscription.created': subscriptionHandler,
  'customer.subscription.updated': subscriptionHandler,
  'customer.subscription.deleted': subscriptionHandler,
  'customer.deleted': customerDeletedHandler,
}
