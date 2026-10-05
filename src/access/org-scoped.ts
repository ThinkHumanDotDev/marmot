import type { Access, Where } from 'payload'

import {
  can,
  getOrgIdsWithPermission,
  isSuperadmin,
  type OrgId,
  type Permission,
  type UserLike,
} from './permissions'

type OrgScopedOptions = {
  /**
   * Name of the relationship field that points at the organization. Defaults to `organization`,
   * the name the multi-tenant plugin is configured to add. Use `id` for the organizations
   * collection itself.
   */
  field?: string
}

const extractId = (value: unknown): OrgId | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

/**
 * Collection access that scopes an operation to the organizations in which the request user
 * holds `permission`.
 *
 * - no user → `false`
 * - superadmin → `true`
 * - when the incoming `data` names an organization (create, or update that moves the document),
 *   the user must hold the permission in that organization or the result is `false`
 * - otherwise → `{ [field]: { in: <org ids where the role satisfies the permission> } }`,
 *   or `false` when there are none
 *
 * The organization field of every org-scoped collection must be `required`, otherwise a create
 * without an organization would only be caught by validation.
 */
export function orgScoped(permission: Permission, options: OrgScopedOptions = {}): Access {
  const field = options.field ?? 'organization'

  return ({ req, data }) => {
    const user = req.user as UserLike | null | undefined
    if (!user) return false
    if (isSuperadmin(user)) return true

    const orgIds = getOrgIdsWithPermission(user, permission)
    if (orgIds.length === 0) return false

    if (data && typeof data === 'object' && field in data && data[field] != null) {
      const target = extractId(data[field])
      if (target === null || !can(user, target, permission)) return false
    }

    const where: Where = { [field]: { in: orgIds } }
    return where
  }
}

/** Only instance superadmins. */
export const superadminOnly: Access = ({ req }) => isSuperadmin(req.user as UserLike | null)

/** Any logged-in user. */
export const authenticated: Access = ({ req }) => Boolean(req.user)

/** The user themself, or a superadmin. For auth collections. */
export const selfOrSuperadmin: Access = ({ req, id }) => {
  const user = req.user as UserLike | null | undefined
  if (!user) return false
  if (isSuperadmin(user)) return true
  if (id !== undefined && id !== null) return String(id) === String(user.id)
  return { id: { equals: user.id } }
}
