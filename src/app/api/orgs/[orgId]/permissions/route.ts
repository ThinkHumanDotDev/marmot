import { loadOrgPermissionOverrides } from '@/access/overrides'
import {
  effectivePermissions,
  getUserRole,
  isSuperadmin,
  LOCKED_PERMISSIONS,
  normalizePermissionOverrides,
  PERMISSIONS,
} from '@/access/permissions'
import { permissionOverridesProblem } from '@/collections/Organizations'
import {
  forbidden,
  getRequestContext,
  localizedError,
  parseId,
  readJson,
  unauthorized,
  withErrors,
} from '@/server/http'
import { apiError } from '@/server/errors'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string }> }

/**
 * GET /api/orgs/:orgId/permissions → `{ defaults, overrides, effective, locked, canEdit }`
 * Any member may read (`organization:read`), only owners and superadmins may change.
 */
export const GET = withErrors(async (request: Request, { params }: RouteContext) => {
  const { payload, user, response } = await getRequestContext(request)
  if (response) return response
  if (!user) return unauthorized(request)
  const orgId = parseId(payload, (await params).orgId)
  const role = getUserRole(user, orgId)
  if (!role && !isSuperadmin(user)) return forbidden(request)

  const overrides = await loadOrgPermissionOverrides(payload, orgId)
  return Response.json({
    defaults: PERMISSIONS,
    overrides,
    effective: effectivePermissions(overrides),
    locked: LOCKED_PERMISSIONS,
    canEdit: isSuperadmin(user) || role === 'owner',
  })
})

/**
 * PUT /api/orgs/:orgId/permissions `{ overrides: { [permission]: role } }` → same shape as GET.
 * The body replaces the overrides; `{}` resets every permission to its default.
 */
export const PUT = withErrors(async (request: Request, { params }: RouteContext) => {
  const { payload, user, response } = await getRequestContext(request)
  if (response) return response
  if (!user) return unauthorized(request)
  const orgId = parseId(payload, (await params).orgId)
  if (!isSuperadmin(user) && getUserRole(user, orgId) !== 'owner') {
    return localizedError(request, 'onlyOwnersChangePermissions', 403)
  }

  const body = await readJson<{ overrides?: unknown }>(request)
  const problem = permissionOverridesProblem(body.overrides ?? {})
  if (problem) throw apiError(problem.key, 400, problem.values)
  const overrides = normalizePermissionOverrides(body.overrides)

  await payload.update({
    collection: 'organizations',
    id: orgId,
    data: { permissionOverrides: overrides },
    depth: 0,
    overrideAccess: true,
  })
  return Response.json({
    defaults: PERMISSIONS,
    overrides,
    effective: effectivePermissions(overrides),
    locked: LOCKED_PERMISSIONS,
    canEdit: true,
  })
})
