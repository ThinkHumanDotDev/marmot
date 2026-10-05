import { APIError } from 'payload'

import { INVITATION_TTL_MS } from '@/collections/Invitations'
import { getRequestContext, parseId, unauthorized, withErrors } from '@/server/http'

export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ orgId: string; invitationId: string }> }

/**
 * POST /api/orgs/:orgId/invitations/:invitationId/resend
 *
 * Extends a pending invitation by another week and re-sends the email. The update runs with the
 * caller's access (`member:invite`), and `context.resendInvitation` tells the collection's
 * `afterChange` hook to mail the link again.
 */
export const POST = withErrors(async (request: Request, { params }: RouteContext) => {
  const { payload, user } = await getRequestContext(request)
  if (!user) return unauthorized()
  const { orgId, invitationId } = await params

  const invitation = await payload.findByID({
    collection: 'invitations',
    id: parseId(payload, invitationId),
    depth: 0,
    user,
    overrideAccess: false,
  })
  const invitationOrg =
    typeof invitation.organization === 'object'
      ? invitation.organization.id
      : invitation.organization
  if (String(invitationOrg) !== String(parseId(payload, orgId))) {
    throw new APIError('Invitation not found.', 404)
  }
  if (invitation.status !== 'pending') {
    throw new APIError(`This invitation is ${invitation.status ?? 'no longer pending'}.`, 409)
  }

  const updated = await payload.update({
    collection: 'invitations',
    id: invitation.id,
    data: { expiresAt: new Date(Date.now() + INVITATION_TTL_MS).toISOString() },
    depth: 0,
    user,
    overrideAccess: false,
    context: { resendInvitation: true },
  })
  return Response.json({ id: updated.id, expiresAt: updated.expiresAt })
})
