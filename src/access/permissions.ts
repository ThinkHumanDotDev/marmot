/**
 * Organization-scoped RBAC (kan.bn pattern).
 *
 * Every user carries an `organizations` array of memberships `{ organization, role }`. A permission
 * is a `resource:action` string mapped to the *minimum* role that may perform it; roles are ordered
 * `owner > admin > member > viewer`, so a role satisfies a permission when it ranks at or above the
 * minimum. Instance `superadmin` users bypass every check.
 */

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const
export type Role = (typeof ROLES)[number]

/** Higher is more powerful. */
export const ROLE_RANK: Record<Role, number> = {
  owner: 400,
  admin: 300,
  member: 200,
  viewer: 100,
}

export const PERMISSIONS = {
  'organization:read': 'viewer',
  'organization:update': 'admin',
  'organization:delete': 'owner',

  'member:read': 'viewer',
  'member:invite': 'admin',
  'member:remove': 'admin',
  'member:update-role': 'admin',

  'monitor:read': 'viewer',
  'monitor:create': 'member',
  'monitor:update': 'member',
  'monitor:delete': 'member',

  'notification:read': 'member',
  'notification:create': 'admin',
  'notification:update': 'admin',
  'notification:delete': 'admin',

  'status-page:read': 'viewer',
  'status-page:create': 'member',
  'status-page:update': 'member',
  'status-page:delete': 'member',

  'maintenance:read': 'viewer',
  'maintenance:create': 'member',
  'maintenance:update': 'member',
  'maintenance:delete': 'member',

  'api-key:read': 'admin',
  'api-key:create': 'admin',
  'api-key:delete': 'admin',
} as const satisfies Record<string, Role>

export type Permission = keyof typeof PERMISSIONS

export type OrgId = string | number

/** Minimal structural view of a user document; `User` from `payload-types` satisfies it. */
export type OrgMembership = {
  organization: OrgId | { id: OrgId } | null | undefined
  role: Role | string | null | undefined
}

export type UserLike = {
  id: OrgId
  superadmin?: boolean | null
  organizations?: OrgMembership[] | null
}

type MaybeUser = UserLike | null | undefined

const extractId = (value: OrgId | { id: OrgId }): OrgId =>
  typeof value === 'object' ? value.id : value

export const isRole = (value: unknown): value is Role =>
  typeof value === 'string' && (ROLES as readonly string[]).includes(value)

export const isSuperadmin = (user: MaybeUser): boolean => user?.superadmin === true

/** `true` when `role` ranks at or above `minRole`. */
export const roleSatisfies = (role: Role, minRole: Role): boolean =>
  ROLE_RANK[role] >= ROLE_RANK[minRole]

/** IDs of every organization the user is a member of (any role). */
export function getUserOrgIds(user: MaybeUser): OrgId[] {
  if (!user || !Array.isArray(user.organizations)) return []
  const ids: OrgId[] = []
  for (const row of user.organizations) {
    if (row?.organization === null || row?.organization === undefined) continue
    ids.push(extractId(row.organization))
  }
  return ids
}

/** The user's role in `orgId`, or `null` when they are not a member. */
export function getUserRole(user: MaybeUser, orgId: OrgId): Role | null {
  if (!user || !Array.isArray(user.organizations)) return null
  const target = String(orgId)
  for (const row of user.organizations) {
    if (row?.organization === null || row?.organization === undefined) continue
    if (String(extractId(row.organization)) === target) {
      return isRole(row.role) ? row.role : null
    }
  }
  return null
}

/** `true` when the user holds at least `minRole` in `orgId` (superadmins always pass). */
export function hasOrgRole(user: MaybeUser, orgId: OrgId, minRole: Role): boolean {
  if (isSuperadmin(user)) return true
  const role = getUserRole(user, orgId)
  return role !== null && roleSatisfies(role, minRole)
}

/** `true` when the user may perform `permission` inside `orgId` (superadmins always pass). */
export function can(user: MaybeUser, orgId: OrgId, permission: Permission): boolean {
  return hasOrgRole(user, orgId, PERMISSIONS[permission])
}

/** Organizations in which the user may perform `permission`. Empty for superadmins: use `isSuperadmin` first. */
export function getOrgIdsWithPermission(user: MaybeUser, permission: Permission): OrgId[] {
  if (!user || !Array.isArray(user.organizations)) return []
  const minRole = PERMISSIONS[permission]
  const ids: OrgId[] = []
  for (const row of user.organizations) {
    if (row?.organization === null || row?.organization === undefined) continue
    if (isRole(row.role) && roleSatisfies(row.role, minRole)) {
      ids.push(extractId(row.organization))
    }
  }
  return ids
}

/** `true` when `managerRole` may assign or remove `targetRole` (no promoting above yourself). */
export const canManageRole = (managerRole: Role, targetRole: Role): boolean =>
  ROLE_RANK[managerRole] >= ROLE_RANK[targetRole]
