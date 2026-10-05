/**
 * Shared plumbing for the monitor mutation route handlers under `src/app/api/orgs/[orgId]/monitors`.
 * Every handler authenticates the Payload session, checks the org permission with `can()` and then
 * goes through the Local API with the request user and `overrideAccess: false`, so collection access
 * (`orgScoped`) applies on top of the explicit permission check.
 */
import type { Payload } from 'payload'
import type { ZodError } from 'zod'

import { canInOrg } from '@/access/overrides'
import type { Permission } from '@/access/permissions'
import type { Monitor, User } from '@/payload-types'

export type RequestUser = User & { collection: 'users' }
export type RouteId = string | number

/** Postgres/SQLite use numeric ids, MongoDB uses strings. */
export function parseId(payload: Payload, raw: string): RouteId {
  return payload.db.defaultIDType === 'number' && /^\d+$/.test(raw) ? Number(raw) : raw
}

export function jsonError(status: number, message: string, details?: unknown): Response {
  return Response.json(
    { errors: [{ message, ...(details !== undefined ? { data: details } : {}) }] },
    { status },
  )
}

export type AuthResult =
  { user: RequestUser; response?: undefined } | { user?: undefined; response: Response }

/** Resolves the Payload user from cookie / Authorization header, or a 401 response. */
export async function authenticate(payload: Payload, request: Request): Promise<AuthResult> {
  const { user } = await payload.auth({ headers: request.headers })
  if (!user) return { response: jsonError(401, 'Unauthorized') }
  return { user: user as RequestUser }
}

/** 403 unless the user holds `permission` in `orgId` (honouring the organization's overrides). */
export async function authorize(
  payload: Payload,
  user: RequestUser,
  orgId: RouteId,
  permission: Permission,
): Promise<Response | null> {
  return (await canInOrg(payload, user, orgId, permission)) ? null : jsonError(403, 'Forbidden')
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

export function validationError(error: ZodError): Response {
  return jsonError(400, 'Validation failed', {
    issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  })
}

/** Collapses a relationship value (id or populated document) to its id. */
export const relationId = (value: unknown): RouteId | null =>
  value && typeof value === 'object' && 'id' in value
    ? ((value as { id: RouteId }).id ?? null)
    : ((value as RouteId | null | undefined) ?? null)

/**
 * Loads a monitor as the user, and only when it belongs to `orgId`. Returns `null` for missing,
 * foreign and forbidden monitors alike so callers answer 404 without leaking existence.
 */
export async function loadOrgMonitor(
  payload: Payload,
  user: RequestUser,
  orgId: RouteId,
  id: RouteId,
): Promise<Monitor | null> {
  try {
    const monitor = await payload.findByID({
      collection: 'monitors',
      id,
      user,
      overrideAccess: false,
      depth: 0,
    })
    const owner = relationId(monitor.organization)
    return owner !== null && String(owner) === String(orgId) ? monitor : null
  } catch {
    return null
  }
}

/** Fields that are never copied from the request body or a cloned document. */
export const PROTECTED_MONITOR_FIELDS = [
  'id',
  'organization',
  'status',
  'certInfo',
  'domainExpiry',
  'pushToken',
  'createdAt',
  'updatedAt',
] as const

/** Unwraps a Payload/Local API error into an HTTP response (validation → 400, access → 403). */
export function payloadError(error: unknown): Response {
  const status =
    error && typeof error === 'object' && 'status' in error
      ? Number((error as { status: unknown }).status)
      : 500
  const message = error instanceof Error ? error.message : 'Unexpected error'
  const data =
    error && typeof error === 'object' && 'data' in error
      ? (error as { data: unknown }).data
      : undefined
  return jsonError(Number.isFinite(status) && status >= 400 ? status : 500, message, data)
}
