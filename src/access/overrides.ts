import type { Payload, PayloadRequest } from 'payload'

import {
  getUserOrgIds,
  hasOrgRole,
  isSuperadmin,
  minRoleFor,
  normalizePermissionOverrides,
  type OrgId,
  type OverridesByOrg,
  type Permission,
  type PermissionOverrides,
  type UserLike,
} from './permissions'

/**
 * Loading `organizations.permissionOverrides` for permission checks that only know ids.
 *
 * The overrides live on the organization document, while roles live on the user. Collection
 * access (`orgScoped`) and route handlers therefore need one lookup per request to resolve the
 * effective minimum roles; `getRequestOverrides` memoises it in `req.context` so nested Local API
 * calls within one request share it.
 */

const CONTEXT_KEY = 'marmotPermissionOverrides'

type OverridesDoc = { id: OrgId; permissionOverrides?: unknown }

/** Overrides of the given organizations, keyed by stringified id (missing orgs → `{}`). */
export async function loadPermissionOverrides(
  payload: Payload,
  orgIds: OrgId[],
  req?: PayloadRequest,
): Promise<OverridesByOrg> {
  const result: OverridesByOrg = {}
  if (orgIds.length === 0) return result
  const { docs } = await payload.find({
    collection: 'organizations',
    where: { id: { in: orgIds } },
    select: { permissionOverrides: true },
    limit: orgIds.length,
    pagination: false,
    depth: 0,
    req,
    overrideAccess: true,
  })
  for (const doc of docs as OverridesDoc[]) {
    result[String(doc.id)] = normalizePermissionOverrides(doc.permissionOverrides)
  }
  return result
}

/** Overrides of one organization (`{}` when it has none or does not exist). */
export async function loadOrgPermissionOverrides(
  payload: Payload,
  orgId: OrgId,
): Promise<PermissionOverrides> {
  const byOrg = await loadPermissionOverrides(payload, [orgId])
  return byOrg[String(orgId)] ?? {}
}

/**
 * Overrides of every organization the request user belongs to, loaded once per request
 * (`req.context`). Superadmins and users without memberships need no lookup.
 */
export async function getRequestOverrides(
  req: PayloadRequest,
  user: UserLike,
): Promise<OverridesByOrg> {
  const orgIds = getUserOrgIds(user)
  if (orgIds.length === 0) return {}

  const context = req.context as Record<string, unknown> | undefined
  const cached = context?.[CONTEXT_KEY] as Promise<OverridesByOrg> | undefined
  if (cached) return cached

  const pending = loadPermissionOverrides(req.payload, orgIds, req)
  if (context) context[CONTEXT_KEY] = pending
  return pending
}

/**
 * `can()` for route handlers that know the organization id only: loads the organization's
 * overrides and checks the effective minimum role. Superadmins pass without a lookup.
 */
export async function canInOrg(
  payload: Payload,
  user: UserLike | null | undefined,
  orgId: OrgId,
  permission: Permission,
): Promise<boolean> {
  if (!user) return false
  if (isSuperadmin(user)) return true
  const overrides = await loadOrgPermissionOverrides(payload, orgId)
  return hasOrgRole(user, orgId, minRoleFor(permission, overrides))
}
