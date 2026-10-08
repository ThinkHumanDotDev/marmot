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
  assertCustomDomains,
  assertMinInterval,
  assertRetention,
  effectivePlan,
  EntitlementError,
  getEntitlements,
  isWithinEntitlement,
  limitOf,
  type CountedResource,
  type EntitlementResource,
  type Entitlements,
  type Plan,
  type PlanSource,
} from '@/lib/entitlements'
import { apiError, type ErrorKey } from '@/server/errors'

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

const ERROR_KEY: Record<EntitlementResource, ErrorKey> = {
  monitors: 'planLimit',
  members: 'planLimit',
  statusPages: 'planLimit',
  minIntervalSeconds: 'planMinInterval',
  retentionDays: 'planRetention',
  customDomains: 'planCustomDomains',
}

/** Wraps an `EntitlementError` in a public `APIError` (402) with structured `data`. */
export function toApiError(error: EntitlementError, plan: Plan): APIError {
  return apiError(
    ERROR_KEY[error.resource],
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
 * Throws a 402 `APIError` when adding one more `resource` (or `options.adding` of them) to `orgId`
 * would exceed the plan. A no-op while billing is disabled.
 */
export async function assertOrgEntitlement(
  payload: Payload,
  resource: CountedResource,
  orgId: OrgId,
  options: LocalOptions & {
    /** How many are about to be added at once (imports); the default is one. */
    adding?: number
  } = {},
): Promise<void> {
  if (!isBillingEnabled()) return
  const adding = Math.max(1, options.adding ?? 1)
  const org = await loadPlanSource(payload, orgId, options)
  const plan = effectivePlan(org)
  const entitlements = entitlementsFor(org)
  const current = await currentCount(payload, resource, orgId, options)
  // The last of the `adding` documents must still fit.
  if (isWithinEntitlement(entitlements, resource, current + adding - 1)) return
  throw toApiError(new EntitlementError(resource, limitOf(entitlements, resource), current), plan)
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

// ---- Feature limits (#161): minimum interval, retention, custom domains ------------------------

/**
 * Loads the organization's plan and runs `check` against its entitlements, turning an
 * `EntitlementError` into the 402 `APIError`. A no-op (no query) while billing is disabled.
 */
async function assertOrgFeature(
  payload: Payload,
  orgId: OrgId,
  options: LocalOptions,
  check: (entitlements: Entitlements) => void,
): Promise<void> {
  if (!isBillingEnabled()) return
  const org = await loadPlanSource(payload, orgId, options)
  try {
    check(entitlementsFor(org))
  } catch (error) {
    if (error instanceof EntitlementError) throw toApiError(error, effectivePlan(org))
    throw error
  }
}

/** 402 when `seconds` is below the organization's minimum check interval. */
export const assertOrgMinInterval = (
  payload: Payload,
  orgId: OrgId,
  seconds: number,
  options: LocalOptions = {},
) => assertOrgFeature(payload, orgId, options, (e) => assertMinInterval(e, seconds))

/** 402 when a period of `days` reaches further back than the organization's plan keeps. */
export const assertOrgRetention = (
  payload: Payload,
  orgId: OrgId,
  days: number,
  options: LocalOptions = {},
) => assertOrgFeature(payload, orgId, options, (e) => assertRetention(e, days))

/** 402 unless the organization's plan includes custom status page domains. */
export const assertOrgCustomDomains = (
  payload: Payload,
  orgId: OrgId,
  options: LocalOptions = {},
) => assertOrgFeature(payload, orgId, options, assertCustomDomains)

/**
 * The organization's minimum check interval in seconds for the scheduler, or `0` ("no floor")
 * while billing is disabled, without a query.
 */
export async function getOrgMinIntervalSeconds(
  payload: Payload,
  orgId: OrgId | null,
  options: LocalOptions = {},
): Promise<number> {
  if (!isBillingEnabled() || orgId === null) return 0
  return entitlementsFor(await loadPlanSource(payload, orgId, options)).minIntervalSeconds
}

/**
 * `getOrgMinIntervalSeconds` with a per-call memo, for loops over many monitors (worker boot,
 * probe configuration). Each organization is loaded once.
 */
export function minIntervalResolver(payload: Payload): (orgId: OrgId | null) => Promise<number> {
  const memo = new Map<string, Promise<number>>()
  return (orgId) => {
    if (!isBillingEnabled() || orgId === null) return Promise.resolve(0)
    const key = String(orgId)
    let value = memo.get(key)
    if (!value) {
      value = getOrgMinIntervalSeconds(payload, orgId)
      memo.set(key, value)
    }
    return value
  }
}

/** Whether the organization's plan serves status pages on custom domains (always while billing is off). */
export async function orgAllowsCustomDomains(
  payload: Payload,
  orgId: OrgId | null,
  options: LocalOptions = {},
): Promise<boolean> {
  if (!isBillingEnabled() || orgId === null) return true
  return entitlementsFor(await loadPlanSource(payload, orgId, options)).customDomains
}

/** Days of history the organization's plan keeps (`Infinity` while billing is disabled). */
export async function getOrgRetentionDays(
  payload: Payload,
  orgId: OrgId,
  options: LocalOptions = {},
): Promise<number> {
  if (!isBillingEnabled()) return Infinity
  return entitlementsFor(await loadPlanSource(payload, orgId, options)).retentionDays
}

/**
 * Whether one more member fits (members plus pending invitations below `maxMembers`). For the
 * paths that add members without an invitation (invite link, single sign-on) and must not fail
 * hard. Always `true` while billing is disabled.
 */
export async function hasMemberSeat(
  payload: Payload,
  orgId: OrgId,
  options: LocalOptions = {},
): Promise<boolean> {
  if (!isBillingEnabled()) return true
  const org = await loadPlanSource(payload, orgId, options)
  const current = await currentCount(payload, 'members', orgId, options)
  return current < entitlementsFor(org).maxMembers
}

/**
 * `beforeChange` hook of `monitors`: a create or an update that sets `interval` or `retryInterval`
 * below the plan's minimum fails with 402. Values that do not change are never checked, so a
 * downgraded organization can still edit its monitors (the engine checks them no faster than the
 * plan allows, see `effectiveIntervalMs`).
 */
export const enforceMinIntervalOnChange: CollectionBeforeChangeHook = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  if (!isBillingEnabled() || !data) return data
  const record = data as Record<string, unknown>
  const original = (originalDoc ?? {}) as Record<string, unknown>
  const orgId = relationId(record.organization ?? original.organization)
  if (orgId === null) return data
  const requested: number[] = []
  for (const field of ['interval', 'retryInterval'] as const) {
    const value = record[field]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    if (operation === 'update' && original[field] === value) continue
    requested.push(value)
  }
  if (requested.length === 0) return data
  await assertOrgMinInterval(req.payload, orgId, Math.min(...requested), { req })
  return data
}

/**
 * `beforeChange` hook of `status-pages`: adding a custom hostname needs a plan with
 * `customDomains` (402 otherwise). Hostnames the page already has are kept as they are, so a
 * downgraded organization can still edit its page; they just stop resolving
 * (`/api/status-pages/resolve-domain`) until the plan includes custom domains again.
 */
export const enforceCustomDomainsOnChange: CollectionBeforeChangeHook = async ({
  data,
  originalDoc,
  req,
}) => {
  if (!isBillingEnabled() || !data) return data
  const hostnames = (rows: unknown): string[] =>
    Array.isArray(rows)
      ? rows
          .map((row) => (row as { hostname?: unknown } | null)?.hostname)
          .filter((h): h is string => typeof h === 'string' && h.length > 0)
      : []
  const next = hostnames((data as { domains?: unknown }).domains)
  if (next.length === 0) return data
  const existing = new Set(hostnames((originalDoc as { domains?: unknown } | undefined)?.domains))
  if (next.every((hostname) => existing.has(hostname))) return data
  const orgId = relationId(
    (data as { organization?: unknown }).organization ??
      (originalDoc as { organization?: unknown } | undefined)?.organization,
  )
  if (orgId === null) return data
  await assertOrgCustomDomains(req.payload, orgId, { req })
  return data
}
