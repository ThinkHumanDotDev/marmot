import type { Payload, PayloadRequest } from 'payload'

import { toMembershipData } from '@/access/memberships'
import { canInOrg } from '@/access/overrides'
import {
  canManageRole,
  getUserRole,
  isRole,
  isSuperadmin,
  type OrgId,
  type Role,
  type UserLike,
} from '@/access/permissions'

import type { Media, User } from '@/payload-types'
import { apiError } from '@/server/errors'
import { defaultLocale, type Locale } from '@/i18n/locales'

/**
 * Organization membership management shared by the `/api/orgs/:orgId/members` route handlers and
 * the settings pages. Memberships are rows of `users.organizations`, which only superadmins may
 * edit through the API, so every function here authorises the actor itself and then writes with
 * `overrideAccess: true`.
 *
 * Invariant: an organization always keeps at least one owner. Nobody can demote or remove the
 * last owner (including themselves); they have to transfer ownership first.
 */

export interface MemberSummary {
  id: OrgId
  email: string
  name: string | null
  avatarUrl: string | null
  role: Role
}

type Actor = UserLike & { email?: string }

const same = (a: OrgId, b: OrgId) => String(a) === String(b)

const avatarUrl = (avatar: User['avatar']): string | null =>
  avatar && typeof avatar === 'object' ? ((avatar as Media).url ?? null) : null

/** Every user holding a membership in `orgId`, owners first. */
export async function listOrgMembers(
  payload: Payload,
  orgId: OrgId,
  options: {
    req?: PayloadRequest
    user?: Actor
    overrideAccess?: boolean
    /** Locale for ordering e-mail addresses within a role (the viewer's language). */
    locale?: Locale
  } = {},
): Promise<MemberSummary[]> {
  const collator = new Intl.Collator(options.locale ?? defaultLocale)
  const { docs } = await payload.find({
    collection: 'users',
    where: { 'organizations.organization': { equals: orgId } },
    depth: 1,
    limit: 0,
    pagination: false,
    sort: 'createdAt',
    req: options.req,
    user: options.user,
    overrideAccess: options.overrideAccess ?? true,
  })

  const rank: Record<Role, number> = { owner: 0, admin: 1, member: 2, viewer: 3 }
  return docs
    .flatMap((user): MemberSummary[] => {
      const role = getUserRole(user, orgId)
      if (!role) return []
      return [
        {
          id: user.id,
          email: user.email,
          name: user.name ?? null,
          avatarUrl: avatarUrl(user.avatar),
          role,
        },
      ]
    })
    .sort((a, b) => rank[a.role] - rank[b.role] || collator.compare(a.email, b.email))
}

export const countOwners = (members: Pick<MemberSummary, 'role'>[]): number =>
  members.filter((m) => m.role === 'owner').length

/** The actor's effective role for management decisions: superadmins act as owners everywhere. */
function actorRole(actor: Actor, orgId: OrgId): Role | null {
  if (isSuperadmin(actor)) return 'owner'
  return getUserRole(actor, orgId)
}

async function loadMember(payload: Payload, orgId: OrgId, userId: OrgId, req?: PayloadRequest) {
  let user: User
  try {
    user = await payload.findByID({
      collection: 'users',
      id: userId,
      depth: 0,
      req,
      overrideAccess: true,
    })
  } catch {
    throw apiError('memberNotFound', 404)
  }
  const role = getUserRole(user, orgId)
  if (!role) throw apiError('memberNotFound', 404)
  return { user, role }
}

async function writeMemberships(
  payload: Payload,
  user: User,
  rows: ReturnType<typeof toMembershipData>,
  req?: PayloadRequest,
) {
  await payload.update({
    collection: 'users',
    id: user.id,
    data: { organizations: rows as User['organizations'] },
    depth: 0,
    req,
    overrideAccess: true,
    context: { ...(req?.context ?? {}), skipOwnerMembership: true },
  })
}

interface MemberArgs {
  payload: Payload
  actor: Actor
  orgId: OrgId
  userId: OrgId
  req?: PayloadRequest
}

/**
 * Change a member's role. Requires `member:update-role`; the actor may neither touch a member
 * ranked above them nor assign a role above their own. The last owner cannot be demoted.
 */
export async function changeMemberRole({
  payload,
  actor,
  orgId,
  userId,
  role,
  req,
}: MemberArgs & { role: unknown }): Promise<MemberSummary> {
  if (!isRole(role)) throw apiError('invalidRole', 400)
  if (!(await canInOrg(payload, actor, orgId, 'member:update-role'))) {
    throw apiError('cannotChangeRoles', 403)
  }
  const manager = actorRole(actor, orgId) as Role
  const { user, role: current } = await loadMember(payload, orgId, userId, req)

  if (!canManageRole(manager, current) || !canManageRole(manager, role)) {
    throw apiError('cannotAssignHigherRole', 403)
  }
  if (current === role) return summarize(user, role)

  if (current === 'owner') {
    const owners = countOwners(await listOrgMembers(payload, orgId, { req }))
    if (owners <= 1) {
      throw apiError('onlyOwnerChangeRole', 409)
    }
  }

  const rows = toMembershipData(user.organizations).map((row) =>
    same(row.organization, orgId) ? { ...row, role } : row,
  )
  await writeMemberships(payload, user, rows, req)
  return summarize(user, role)
}

/**
 * Remove a member. Users may always remove themselves ("leave"); removing someone else requires
 * `member:remove` and a rank at or above theirs. The last owner cannot leave or be removed.
 */
export async function removeMember({ payload, actor, orgId, userId, req }: MemberArgs) {
  const self = same(actor.id, userId)
  const { user, role: current } = await loadMember(payload, orgId, userId, req)

  if (!self) {
    if (!(await canInOrg(payload, actor, orgId, 'member:remove'))) {
      throw apiError('cannotRemoveMembers', 403)
    }
    if (!canManageRole(actorRole(actor, orgId) as Role, current)) {
      throw apiError('cannotRemoveHigherRanked', 403)
    }
  }

  if (current === 'owner') {
    const owners = countOwners(await listOrgMembers(payload, orgId, { req }))
    if (owners <= 1) {
      throw apiError(self ? 'onlyOwnerLeave' : 'onlyOwnerRemove', 409)
    }
  }

  const rows = toMembershipData(user.organizations).filter((row) => !same(row.organization, orgId))
  await writeMemberships(payload, user, rows, req)
  return { removed: user.id, self }
}

/**
 * Make another member the owner. Only owners (and superadmins) may transfer; the previous owner
 * stays in the organization as an admin.
 */
export async function transferOwnership({ payload, actor, orgId, userId, req }: MemberArgs) {
  if (actorRole(actor, orgId) !== 'owner') {
    throw apiError('onlyOwnerTransfers', 403)
  }
  if (same(actor.id, userId)) throw apiError('alreadyOwner', 400)

  const target = await loadMember(payload, orgId, userId, req)
  if (target.role !== 'owner') {
    const rows = toMembershipData(target.user.organizations).map((row) =>
      same(row.organization, orgId) ? { ...row, role: 'owner' as Role } : row,
    )
    await writeMemberships(payload, target.user, rows, req)
  }

  // Superadmins acting from outside the organization have no membership to demote.
  if (getUserRole(actor, orgId) === 'owner') {
    const me = await payload.findByID({
      collection: 'users',
      id: actor.id,
      depth: 0,
      req,
      overrideAccess: true,
    })
    const rows = toMembershipData(me.organizations).map((row) =>
      same(row.organization, orgId) ? { ...row, role: 'admin' as Role } : row,
    )
    await writeMemberships(payload, me, rows, req)
  }

  return { owner: target.user.id }
}

/**
 * Organizations in which `user` is the only owner. Deleting such an account would orphan them,
 * so the account page asks for a transfer first.
 */
export async function soleOwnerships(
  payload: Payload,
  user: User,
  req?: PayloadRequest,
): Promise<{ id: OrgId; name: string; slug: string }[]> {
  const result: { id: OrgId; name: string; slug: string }[] = []
  for (const row of user.organizations ?? []) {
    if (row.role !== 'owner') continue
    const orgId = typeof row.organization === 'object' ? row.organization.id : row.organization
    const owners = countOwners(await listOrgMembers(payload, orgId, { req }))
    if (owners > 1) continue
    try {
      const org = await payload.findByID({
        collection: 'organizations',
        id: orgId,
        depth: 0,
        req,
        overrideAccess: true,
      })
      result.push({ id: org.id, name: org.name, slug: org.slug })
    } catch {
      // Dangling membership; nothing to protect.
    }
  }
  return result
}

function summarize(user: User, role: Role): MemberSummary {
  return {
    id: user.id,
    email: user.email,
    name: user.name ?? null,
    avatarUrl: avatarUrl(user.avatar),
    role,
  }
}
