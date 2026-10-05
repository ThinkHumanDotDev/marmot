import type { Payload, PayloadRequest } from 'payload'

import type { User } from '@/payload-types'

import { getUserRole, type OrgId, type Role } from './permissions'

type MembershipRow = NonNullable<User['organizations']>[number]

const extractId = (value: MembershipRow['organization']): OrgId =>
  typeof value === 'object' ? value.id : value

/** Serialises a user's memberships into the shape `payload.update` expects (IDs, not populated docs). */
export const toMembershipData = (rows: User['organizations']) =>
  (rows ?? []).map((row) => ({
    id: row.id ?? undefined,
    organization: extractId(row.organization),
    role: row.role,
  }))

type AddMembershipArgs = {
  payload: Payload
  userId: OrgId
  orgId: OrgId
  role: Role
  /** Pass the current request so the write joins its transaction. */
  req?: PayloadRequest
}

/**
 * Adds `{ organization: orgId, role }` to the user's `organizations` array unless a membership for
 * that organization already exists (the existing role is kept). Runs with `overrideAccess: true`
 * because the array is only writable by superadmins through the API; callers are responsible for
 * authorising the change. Returns the user's role in the organization after the call.
 */
export async function addOrgMembership({
  payload,
  userId,
  orgId,
  role,
  req,
}: AddMembershipArgs): Promise<Role> {
  const user = await payload.findByID({
    collection: 'users',
    id: userId,
    depth: 0,
    req,
    overrideAccess: true,
  })

  const existing = getUserRole(user, orgId)
  if (existing) return existing

  await payload.update({
    collection: 'users',
    id: userId,
    data: {
      // Generated types use the configured adapter's ID type (number on Postgres, string on
      // MongoDB); memberships are typed `string | number` to stay portable, hence the cast.
      organizations: [
        ...toMembershipData(user.organizations),
        { organization: orgId, role },
      ] as User['organizations'],
    },
    depth: 0,
    req,
    overrideAccess: true,
    context: { ...(req?.context ?? {}), skipOwnerMembership: true },
  })

  return role
}
