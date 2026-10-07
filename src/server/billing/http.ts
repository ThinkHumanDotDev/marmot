/**
 * Shared plumbing for the billing route handlers under `/api/orgs/[orgId]/billing/**`: the
 * `BILLING_ENABLED` gate (501 when off), authentication, the `organization:update` (admin+) check
 * and loading the organization with the user's own access.
 */
import { APIError, getPayload, type Payload } from 'payload'

import config from '@payload-config'
import { authenticateRequest } from '@/server/auth/request-auth'
import { errorMessageFor, errorText } from '@/server/request-locale'
import { can } from '@/access/permissions'
import { isBillingEnabled } from './entitlements'

import type { Organization, User } from '@/payload-types'

export type RequestUser = User & { collection: 'users' }

export const jsonError = (message: string, status: number, details?: unknown) =>
  Response.json({ error: message, ...(details !== undefined ? { details } : {}) }, { status })

export const BILLING_DISABLED_STATUS = 501

export const billingDisabled = (request: Request) =>
  jsonError(errorText(request, 'billingDisabled'), BILLING_DISABLED_STATUS)

export type BillingContext = { payload: Payload; user: RequestUser; org: Organization }

/** Postgres/SQLite use numeric ids, MongoDB uses strings. */
export const coerceId = (payload: Payload, id: string): string | number =>
  payload.db.defaultIDType === 'number' && /^\d+$/.test(id) ? Number(id) : id

/**
 * Runs the common checks of every billing route. Order matters: the 501 comes first so a disabled
 * install never leaks whether an organization exists; then 401, then 404 (unknown or foreign
 * organization), then 403 for members below admin.
 */
export async function billingContext(
  request: Request,
  orgId: string,
): Promise<{ ok: true; ctx: BillingContext } | { ok: false; response: Response }> {
  if (!isBillingEnabled()) return { ok: false, response: billingDisabled(request) }

  const payload = await getPayload({ config })
  // Session or organization API key; keys are refused on billing routes (`request-auth.ts`).
  const auth = await authenticateRequest(payload, request)
  if (auth.response) return { ok: false, response: auth.response }
  const user = auth.user
  if (!user) return { ok: false, response: jsonError(errorText(request, 'unauthenticated'), 401) }

  const org = await payload.findByID({
    collection: 'organizations',
    id: coerceId(payload, orgId),
    depth: 0,
    user,
    overrideAccess: false,
    disableErrors: true,
  })
  if (!org) {
    return { ok: false, response: jsonError(errorText(request, 'organizationNotFound'), 404) }
  }
  if (!can(user, org.id, 'organization:update')) {
    return { ok: false, response: jsonError(errorText(request, 'forbidden'), 403) }
  }
  return { ok: true, ctx: { payload, user: user as RequestUser, org } }
}

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    const text = await request.text()
    return (text ? JSON.parse(text) : {}) as T
  } catch {
    return {} as T
  }
}

/**
 * Maps `APIError`s (ours and Payload's) to JSON, with `apiError(…)` messages in the request
 * locale; anything else becomes a 500.
 */
export function errorResponse(error: unknown, request: Request): Response {
  if (error instanceof APIError) {
    const data = (error as APIError & { data?: unknown }).data
    return jsonError(errorMessageFor(request, error, 'unexpected'), error.status ?? 500, data)
  }
  return jsonError(errorMessageFor(request, error, 'unexpected'), 500)
}
