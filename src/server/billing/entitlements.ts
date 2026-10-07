/**
 * Server side of the entitlement scaffold: reads `env.BILLING_ENABLED`, loads the organization's
 * plan, counts usage through the Local API and turns `EntitlementError` into a Payload `APIError`
 * (HTTP 402) so REST clients and route handlers surface a readable message.
 *
 * With `BILLING_ENABLED=false` (the self-host default) `getOrgEntitlements` is unlimited and the
 * hooks return early without a single query, so existing behaviour is untouched.
 */
import {
  APIError,
  type CollectionBeforeChangeHook,
  type Payload,
  type PayloadRequest,
} from 'payload'

import { env } from '@/env'
import {
  assertEntitlement,
  effectivePlan,
  EntitlementError,
  getEntitlements,
  type CountedResource,
  type Entitlements,
  type Plan,
  type PlanSource,
} from '@/lib/entitlements'
import { apiError } from '@/server/errors'

export type OrgId = string | number

export const isBillingEnabled = (): boolean => env.BILLING_ENABLED

/** Collapses a relationship value (id or populated document) to its id. */
export const relationId = (value: unknown): OrgId | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

export interface UsageCounts {
  monitors: number
  members: number
  statusPages: number
}

type LocalOptions = { req?: PayloadRequest }

async function count(
  payload: Payload,
  collection: 'monitors' | 'status-pages' | 'users' | 'invitations',
  where: NonNullable<Parameters<Payload['count']>[0]['where']>,
  { req }: LocalOptions,
): Promise<number> {
  const result = await payload.count({ collection, where, req, overrideAccess: true })
  return result.totalDocs
}

export const countMonitors = (payload: Payload, orgId: OrgId, options: LocalOptions = {}) =>
  count(payload, 'monitors', { organization: { equals: orgId } }, options)

export const countStatusPages = (payload: Payload, orgId: OrgId, options: LocalOptions = {}) =>
  count(payload, 'status-pages', { organization: { equals: orgId } }, options)

/** Members of any role (memberships live on `users.organizations`). */
export const countMembers = (payload: Payload, orgId: OrgId, options: LocalOptions = {}) =>
  count(payload, 'users', { 'organizations.organization': { equals: orgId } }, options)

/** Invitations that may still turn into members. */
export const countPendingInvitations = (
  payload: Payload,
  orgId: OrgId,
  options: LocalOptions = {},
) =>
  count(
    payload,
    'invitations',
    { and: [{ organization: { equals: orgId } }, { status: { equals: 'pending' } }] },
    options,
  )

export async function getOrgUsage(
  payload: Payload,
  orgId: OrgId,
  options: LocalOptions = {},
): Promise<UsageCounts> {
  const [monitors, members, statusPages] = await Promise.all([
    countMonitors(payload, orgId, options),
    countMembers(payload, orgId, options),
    countStatusPages(payload, orgId, options),
  ])
  return { monitors, members, statusPages }
}

/** Loads the plan fields of an organization; `null` when it does not exist. */
export async function loadPlanSource(
  payload: Payload,
  orgId: OrgId,
  options: LocalOptions = {},
): Promise<(PlanSource & { id: OrgId }) | null> {
  try {
    const org = await payload.findByID({
      collection: 'organizations',
      id: orgId,
      depth: 0,
      req: options.req,
      overrideAccess: true,
      disableErrors: true,
    })
    return org ? { id: org.id, plan: org.plan, subscriptionStatus: org.subscriptionStatus } : null
  } catch {
    return null
  }
}

/** Entitlements of an organization under the current `BILLING_ENABLED` setting. */
export function entitlementsFor(org: PlanSource | null | undefined): Entitlements {
  return getEntitlements(org, { billingEnabled: isBillingEnabled() })
}

export async function getOrgEntitlements(
  payload: Payload,
  orgId: OrgId,
  options: LocalOptions = {},
): Promise<{ plan: Plan; entitlements: Entitlements }> {
  if (!isBillingEnabled()) return { plan: 'free', entitlements: entitlementsFor(null) }
  const org = await loadPlanSource(payload, orgId, options)
  return { plan: effectivePlan(org), entitlements: entitlementsFor(org) }
}

/** The HTTP status used when a plan limit blocks a write. */
export const ENTITLEMENT_HTTP_STATUS = 402

/** Wraps an `EntitlementError` in a public `APIError` (402) with structured `data`. */
export function toApiError(error: EntitlementError, plan: Plan): APIError {
  return apiError(
    'planLimit',
    ENTITLEMENT_HTTP_STATUS,
    { resource: error.resource, limit: error.limit },
    {
      data: {
        code: error.code,
        resource: error.resource,
        limit: error.limit,
        current: error.current,
        plan,
      },
      isPublic: true,
    },
  )
}

const currentCount = (
  payload: Payload,
  resource: CountedResource,
  orgId: OrgId,
  options: LocalOptions,
): Promise<number> => {
  switch (resource) {
    case 'monitors':
      return countMonitors(payload, orgId, options)
    case 'statusPages':
      return countStatusPages(payload, orgId, options)
    case 'members':
      // Seats are reserved as soon as someone is invited, so pending invitations count too.
      return Promise.all([
        countMembers(payload, orgId, options),
        countPendingInvitations(payload, orgId, options),
      ]).then(([members, pending]) => members + pending)
  }
}

/**
 * Throws a 402 `APIError` when adding one more `resource` to `orgId` would exceed the plan. A no-op
 * while billing is disabled.
 */
export async function assertOrgEntitlement(
  payload: Payload,
  resource: CountedResource,
  orgId: OrgId,
  options: LocalOptions = {},
): Promise<void> {
  if (!isBillingEnabled()) return
  const org = await loadPlanSource(payload, orgId, options)
  const plan = effectivePlan(org)
  const entitlements = entitlementsFor(org)
  const current = await currentCount(payload, resource, orgId, options)
  try {
    assertEntitlement(entitlements, resource, current)
  } catch (error) {
    if (error instanceof EntitlementError) throw toApiError(error, plan)
    throw error
  }
}

/**
 * `beforeChange` hook factory for org-scoped collections: on `create`, enforces the plan limit of
 * `resource` for `data.organization`. Updates are never blocked (a downgraded organization keeps
 * what it has; it just cannot add more).
 */
export function enforceEntitlementOnCreate(
  resource: CountedResource,
  field = 'organization',
): CollectionBeforeChangeHook {
  return async ({ data, operation, req }) => {
    if (operation !== 'create' || !isBillingEnabled()) return data
    const orgId = relationId((data as Record<string, unknown> | undefined)?.[field])
    if (orgId === null) return data
    await assertOrgEntitlement(req.payload, resource, orgId, { req })
    return data
  }
}
