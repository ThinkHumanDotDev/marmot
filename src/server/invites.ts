import type { Payload, PayloadRequest } from 'payload'

import { addOrgMembership } from '@/access/memberships'
import { canInOrg } from '@/access/overrides'
import {
  can,
  canManageRole,
  getUserRole,
  isRole,
  isSuperadmin,
  type OrgId,
  type Role,
} from '@/access/permissions'
import { acceptInvitation } from '@/collections/Invitations'
import { generateInviteLinkToken } from '@/collections/Organizations'
import { env } from '@/env'
import { assertOrgEntitlement, isBillingEnabled } from '@/server/billing/entitlements'

import type { Organization } from '@/payload-types'
import { apiError } from '@/server/errors'

/**
 * `/invite/<code>` accepts two kinds of secrets: a personal invitation token (emailed, single use)
 * or an organization's shareable invite-link token (reusable until regenerated or disabled).
 */

export interface InviteOrganization {
  id: OrgId
  slug: string
  name: string
}

export type ResolvedInvite =
  | {
      kind: 'invitation'
      id: OrgId
      email: string
      role: Role
      status: 'pending' | 'accepted' | 'revoked' | 'expired'
      organization: InviteOrganization
    }
  | { kind: 'link'; role: Role; organization: InviteOrganization }

const orgSummary = (org: Organization): InviteOrganization => ({
  id: org.id,
  slug: org.slug,
  name: org.name,
})

const isCode = (code: string) => /^[A-Za-z0-9_-]{16,128}$/.test(code)

/** Looks the code up without touching anything. `null` when it matches nothing. */
export async function resolveInviteCode(
  payload: Payload,
  code: string,
  req?: PayloadRequest,
): Promise<ResolvedInvite | null> {
  if (!code || !isCode(code)) return null

  const invitations = await payload.find({
    collection: 'invitations',
    where: { token: { equals: code } },
    depth: 1,
    limit: 1,
    req,
    overrideAccess: true,
  })
  const invitation = invitations.docs[0]
  if (invitation) {
    if (typeof invitation.organization !== 'object') return null
    const expired =
      invitation.status === 'pending' &&
      !!invitation.expiresAt &&
      new Date(invitation.expiresAt).getTime() < Date.now()
    return {
      kind: 'invitation',
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: expired ? 'expired' : (invitation.status ?? 'pending'),
      organization: orgSummary(invitation.organization),
    }
  }

  const orgs = await payload.find({
    collection: 'organizations',
    where: { inviteLinkToken: { equals: code } },
    depth: 0,
    limit: 1,
    req,
    overrideAccess: true,
  })
  const org = orgs.docs[0]
  if (!org) return null
  return {
    kind: 'link',
    role: isRole(org.inviteLinkRole) ? org.inviteLinkRole : 'member',
    organization: orgSummary(org),
  }
}

/** Attaches `user` to the organization behind `code`. Throws `APIError` with a useful status. */
export async function acceptInviteCode({
  payload,
  code,
  user,
  req,
}: {
  payload: Payload
  code: string
  user: { id: OrgId }
  req?: PayloadRequest
}): Promise<{ organization: InviteOrganization; role: Role }> {
  const resolved = await resolveInviteCode(payload, code, req)
  if (!resolved) throw apiError('inviteLinkInvalid', 404)

  if (resolved.kind === 'invitation') {
    const result = await acceptInvitation({ payload, token: code, user, req })
    return { organization: resolved.organization, role: result.role }
  }

  // A join through the shareable link takes a seat: members plus pending invitations must stay
  // within the plan (#161, no-op without billing). Existing members keep their role as before.
  if (isBillingEnabled()) {
    const joiner = await payload.findByID({
      collection: 'users',
      id: user.id,
      depth: 0,
      req,
      overrideAccess: true,
    })
    if (!getUserRole(joiner, resolved.organization.id)) {
      await assertOrgEntitlement(payload, 'members', resolved.organization.id, { req })
    }
  }

  const role = await addOrgMembership({
    payload,
    userId: user.id,
    orgId: resolved.organization.id,
    role: resolved.role,
    req,
  })
  return { organization: resolved.organization, role }
}

export const inviteLinkUrl = (token: string): string =>
  `${env.NEXT_PUBLIC_SERVER_URL.replace(/\/$/, '')}/invite/${token}`

/**
 * Mint a new invite-link token (invalidating the previous one) and optionally change the role it
 * grants. Requires `member:invite`; the role may not exceed the actor's own.
 */
export async function regenerateInviteLink({
  payload,
  actor,
  orgId,
  role,
  req,
}: {
  payload: Payload
  actor: Parameters<typeof can>[0]
  orgId: OrgId
  role?: unknown
  req?: PayloadRequest
}): Promise<{ url: string; role: Role }> {
  if (!(await canInOrg(payload, actor, orgId, 'member:invite'))) {
    throw apiError('cannotManageInviteLinks', 403)
  }
  const nextRole = role === undefined ? undefined : isRole(role) ? role : null
  if (nextRole === null) throw apiError('invalidRole', 400)
  const actorRole = isSuperadmin(actor) ? 'owner' : getUserRole(actor, orgId)
  if (nextRole && (!actorRole || !canManageRole(actorRole, nextRole))) {
    throw apiError('cannotGrantHigherRole', 403)
  }

  const token = generateInviteLinkToken()
  const updated = await payload.update({
    collection: 'organizations',
    id: orgId,
    data: { inviteLinkToken: token, ...(nextRole ? { inviteLinkRole: nextRole } : {}) },
    depth: 0,
    req,
    overrideAccess: true,
  })
  return {
    url: inviteLinkUrl(token),
    role: isRole(updated.inviteLinkRole) ? updated.inviteLinkRole : 'member',
  }
}

/** Disable the shareable link. Existing personal invitations are unaffected. */
export async function disableInviteLink({
  payload,
  actor,
  orgId,
  req,
}: {
  payload: Payload
  actor: Parameters<typeof can>[0]
  orgId: OrgId
  req?: PayloadRequest
}): Promise<void> {
  if (!(await canInOrg(payload, actor, orgId, 'member:invite'))) {
    throw apiError('cannotManageInviteLinks', 403)
  }
  await payload.update({
    collection: 'organizations',
    id: orgId,
    data: { inviteLinkToken: null },
    depth: 0,
    req,
    overrideAccess: true,
  })
}
