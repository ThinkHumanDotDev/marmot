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

  'tag:read': 'viewer',
  'tag:create': 'member',
  'tag:update': 'member',
  'tag:delete': 'member',

  'proxy:read': 'member',
  'proxy:create': 'admin',
  'proxy:update': 'admin',
  'proxy:delete': 'admin',

  'docker-host:read': 'member',
  'docker-host:create': 'admin',
  'docker-host:update': 'admin',
  'docker-host:delete': 'admin',

  'api-key:read': 'admin',
  'api-key:create': 'admin',
  'api-key:delete': 'admin',
} as const satisfies Record<string, Role>

export type Permission = keyof typeof PERMISSIONS

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[]

/**
 * Permissions an organization may NOT override: deleting the organization stays owner-only so a
 * misconfigured override can never hand that to a lower role.
 */
export const LOCKED_PERMISSIONS: readonly Permission[] = ['organization:delete']

/** Per-organization overrides of the minimum role (`organizations.permissionOverrides`). */
export type PermissionOverrides = Partial<Record<Permission, Role>>

/** Organization slice `canWithOverrides` needs; `Organization` from `payload-types` satisfies it. */
export type OrgLike = {
  id: OrgId
  permissionOverrides?: unknown
}

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

export const isPermission = (value: unknown): value is Permission =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(PERMISSIONS, value)

/**
 * Validates a raw `permissionOverrides` value (JSON from the database or a request body). Unknown
 * permissions, invalid roles, locked permissions and entries equal to the default are dropped, so
 * the result is the minimal diff from `PERMISSIONS`.
 */
export function normalizePermissionOverrides(value: unknown): PermissionOverrides {
  const overrides: PermissionOverrides = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return overrides
  for (const [key, role] of Object.entries(value as Record<string, unknown>)) {
    if (!isPermission(key) || !isRole(role)) continue
    if (LOCKED_PERMISSIONS.includes(key)) continue
    if (PERMISSIONS[key] === role) continue
    overrides[key] = role
  }
  return overrides
}

/** Minimum role for `permission`, honouring the organization's overrides when given. */
export function minRoleFor(permission: Permission, overrides?: PermissionOverrides | null): Role {
  const override = overrides?.[permission]
  return override && !LOCKED_PERMISSIONS.includes(permission) ? override : PERMISSIONS[permission]
}

/** Every permission with its effective minimum role (defaults + overrides). */
export function effectivePermissions(
  overrides?: PermissionOverrides | null,
): Record<Permission, Role> {
  const result = {} as Record<Permission, Role>
  for (const permission of ALL_PERMISSIONS) result[permission] = minRoleFor(permission, overrides)
  return result
}

/**
 * `true` when the user may perform `permission` inside `orgId` (superadmins always pass).
 *
 * Uses the DEFAULT minimum roles only. Organizations can raise or lower minimums through
 * `organizations.permissionOverrides`; when the organization document (or its overrides) is at
 * hand use `canWithOverrides`, and in route handlers `canInOrg` from `src/access/overrides.ts`.
 * Code paths that only know an organization id and cannot afford a lookup keep the defaults.
 */
export function can(user: MaybeUser, orgId: OrgId, permission: Permission): boolean {
  return hasOrgRole(user, orgId, PERMISSIONS[permission])
}

/** `can()` that honours the organization's `permissionOverrides` (superadmins always pass). */
export function canWithOverrides(user: MaybeUser, org: OrgLike, permission: Permission): boolean {
  const overrides = normalizePermissionOverrides(org.permissionOverrides)
  return hasOrgRole(user, org.id, minRoleFor(permission, overrides))
}

/** Overrides per organization id (stringified), as loaded by `src/access/overrides.ts`. */
export type OverridesByOrg = Record<string, PermissionOverrides>

/**
 * Organizations in which the user may perform `permission`. Empty for superadmins: use
 * `isSuperadmin` first. `overridesByOrg` applies per-organization minimum roles when known.
 */
export function getOrgIdsWithPermission(
  user: MaybeUser,
  permission: Permission,
  overridesByOrg?: OverridesByOrg,
): OrgId[] {
  if (!user || !Array.isArray(user.organizations)) return []
  const ids: OrgId[] = []
  for (const row of user.organizations) {
    if (row?.organization === null || row?.organization === undefined) continue
    const orgId = extractId(row.organization)
    const minRole = minRoleFor(permission, overridesByOrg?.[String(orgId)])
    if (isRole(row.role) && roleSatisfies(row.role, minRole)) {
      ids.push(orgId)
    }
  }
  return ids
}

/** `true` when `managerRole` may assign or remove `targetRole` (no promoting above yourself). */
export const canManageRole = (managerRole: Role, targetRole: Role): boolean =>
  ROLE_RANK[managerRole] >= ROLE_RANK[targetRole]
