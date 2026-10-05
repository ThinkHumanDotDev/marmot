/**
 * Plan entitlements: pure, client-safe maths shared by the server (hooks, routes) and the billing
 * settings UI. Nothing here touches the database, the environment or Stripe.
 *
 * Self-hosted installs run with `BILLING_ENABLED=false`, in which case every limit is `Infinity`
 * and every feature flag is `true`, whatever the organization's `plan` says. A hosted offering
 * flips the flag on and lets Stripe webhooks drive `organizations.plan` / `subscriptionStatus`.
 */

export const PLANS = ['free', 'team', 'pro', 'enterprise'] as const
export type Plan = (typeof PLANS)[number]

export const SUBSCRIPTION_STATUSES = [
  'none',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
] as const
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

export interface Entitlements {
  /** Monitors (groups included) the organization may own. */
  maxMonitors: number
  /** Members (any role) the organization may have. */
  maxMembers: number
  /** Status pages the organization may create. */
  maxStatusPages: number
  /** Smallest check interval a plan allows, in seconds. */
  minIntervalSeconds: number
  /** How long daily aggregates and important heartbeats are kept. */
  retentionDays: number
  /** Whether status pages may be served on custom hostnames. */
  customDomains: boolean
}

/** The resources whose count is enforced on create. */
export const COUNTED_RESOURCES = ['monitors', 'members', 'statusPages'] as const
export type CountedResource = (typeof COUNTED_RESOURCES)[number]

const LIMIT_KEY: Record<CountedResource, keyof Entitlements> = {
  monitors: 'maxMonitors',
  members: 'maxMembers',
  statusPages: 'maxStatusPages',
}

const RESOURCE_LABEL: Record<CountedResource, { singular: string; plural: string }> = {
  monitors: { singular: 'monitor', plural: 'monitors' },
  members: { singular: 'member', plural: 'members' },
  statusPages: { singular: 'status page', plural: 'status pages' },
}

export const PLAN_LABELS: Record<Plan, string> = {
  free: 'Free',
  team: 'Team',
  pro: 'Pro',
  enterprise: 'Enterprise',
}

/** Limit table of the hosted plans. Edit here; the docs table in `docs/billing.md` mirrors it. */
export const PLAN_LIMITS: Record<Plan, Entitlements> = {
  free: {
    maxMonitors: 10,
    maxMembers: 3,
    maxStatusPages: 1,
    minIntervalSeconds: 60,
    retentionDays: 30,
    customDomains: false,
  },
  team: {
    maxMonitors: 50,
    maxMembers: 10,
    maxStatusPages: 5,
    minIntervalSeconds: 30,
    retentionDays: 90,
    customDomains: true,
  },
  pro: {
    maxMonitors: 200,
    maxMembers: 50,
    maxStatusPages: 20,
    minIntervalSeconds: 20,
    retentionDays: 365,
    customDomains: true,
  },
  enterprise: {
    maxMonitors: Infinity,
    maxMembers: Infinity,
    maxStatusPages: Infinity,
    minIntervalSeconds: 20,
    retentionDays: Infinity,
    customDomains: true,
  },
}

/** Entitlements of a self-hosted (billing disabled) organization: everything, no limits. */
export const UNLIMITED_ENTITLEMENTS: Entitlements = {
  maxMonitors: Infinity,
  maxMembers: Infinity,
  maxStatusPages: Infinity,
  minIntervalSeconds: 20,
  retentionDays: Infinity,
  customDomains: true,
}

/** Plans an organization can move to through Stripe Checkout (`enterprise` is sold by hand). */
export const PURCHASABLE_PLANS: readonly Plan[] = ['team', 'pro']

export const isPlan = (value: unknown): value is Plan => PLANS.includes(value as Plan)

export const isSubscriptionStatus = (value: unknown): value is SubscriptionStatus =>
  SUBSCRIPTION_STATUSES.includes(value as SubscriptionStatus)

/** Subscription states in which the paid plan still applies (grace period included). */
export const ACTIVE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'none',
  'trialing',
  'active',
  'past_due',
]

/** The slice of an organization document the entitlement maths needs. */
export interface PlanSource {
  plan?: string | null
  subscriptionStatus?: string | null
}

/**
 * The plan whose limits apply. A paid plan whose subscription was canceled or is unpaid falls back
 * to `free`; `subscriptionStatus: 'none'` keeps the stored plan so superadmins can grant a plan by
 * hand (enterprise deals, sponsored projects).
 */
export function effectivePlan(org: PlanSource | null | undefined): Plan {
  const plan = isPlan(org?.plan) ? org.plan : 'free'
  if (plan === 'free') return 'free'
  const status = isSubscriptionStatus(org?.subscriptionStatus) ? org.subscriptionStatus : 'none'
  return ACTIVE_SUBSCRIPTION_STATUSES.includes(status) ? plan : 'free'
}

export interface EntitlementOptions {
  /** `env.BILLING_ENABLED`. When false the organization is unlimited. */
  billingEnabled: boolean
}

export function getEntitlements(
  org: PlanSource | null | undefined,
  { billingEnabled }: EntitlementOptions,
): Entitlements {
  if (!billingEnabled) return { ...UNLIMITED_ENTITLEMENTS }
  return { ...PLAN_LIMITS[effectivePlan(org)] }
}

/** Thrown by `assertEntitlement` when a create would exceed the plan. */
export class EntitlementError extends Error {
  readonly code = 'entitlement_exceeded' as const
  readonly resource: CountedResource
  readonly limit: number
  readonly current: number

  constructor(resource: CountedResource, limit: number, current: number, message?: string) {
    super(message ?? entitlementMessage(resource, limit))
    this.name = 'EntitlementError'
    this.resource = resource
    this.limit = limit
    this.current = current
  }
}

/** Human-readable explanation shown to the user when a limit is hit. */
export function entitlementMessage(resource: CountedResource, limit: number): string {
  const label = RESOURCE_LABEL[resource]
  const noun = limit === 1 ? label.singular : label.plural
  return `Your plan allows ${limit} ${noun}. Upgrade your plan to add more.`
}

export function limitOf(entitlements: Entitlements, resource: CountedResource): number {
  return entitlements[LIMIT_KEY[resource]] as number
}

/** `true` when one more `resource` fits under the plan given `currentCount` existing ones. */
export function isWithinEntitlement(
  entitlements: Entitlements,
  resource: CountedResource,
  currentCount: number,
): boolean {
  return currentCount < limitOf(entitlements, resource)
}

/** Throws `EntitlementError` unless one more `resource` fits. */
export function assertEntitlement(
  entitlements: Entitlements,
  resource: CountedResource,
  currentCount: number,
): void {
  if (!isWithinEntitlement(entitlements, resource, currentCount)) {
    throw new EntitlementError(resource, limitOf(entitlements, resource), currentCount)
  }
}

/** Entitlements as JSON can carry them: `Infinity` becomes `null` ("unlimited"). */
export type SerializedEntitlements = {
  [K in keyof Entitlements]: Entitlements[K] extends number ? number | null : Entitlements[K]
}

export function serializeEntitlements(entitlements: Entitlements): SerializedEntitlements {
  const finite = (n: number) => (Number.isFinite(n) ? n : null)
  return {
    maxMonitors: finite(entitlements.maxMonitors),
    maxMembers: finite(entitlements.maxMembers),
    maxStatusPages: finite(entitlements.maxStatusPages),
    minIntervalSeconds: entitlements.minIntervalSeconds,
    retentionDays: finite(entitlements.retentionDays),
    customDomains: entitlements.customDomains,
  }
}

/** Formats a limit for display: `∞` for unlimited. */
export const formatLimit = (limit: number | null): string =>
  limit === null || !Number.isFinite(limit) ? '∞' : String(limit)
