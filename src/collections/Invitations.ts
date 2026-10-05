import crypto from 'node:crypto'

import {
  APIError,
  ValidationError,
  type CollectionAfterChangeHook,
  type CollectionBeforeChangeHook,
  type CollectionConfig,
  type Payload,
  type PayloadRequest,
} from 'payload'

import { addOrgMembership } from '@/access/memberships'
import { orgScoped } from '@/access/org-scoped'
import {
  canManageRole,
  getUserRole,
  isRole,
  isSuperadmin,
  ROLES,
  type OrgId,
  type Role,
} from '@/access/permissions'
import { env } from '@/env'
import { childLogger } from '@/lib/logger'

import type { Invitation } from '@/payload-types'

const log = childLogger('invitations')

export const INVITATION_STATUSES = ['pending', 'accepted', 'revoked', 'expired'] as const
export type InvitationStatus = (typeof INVITATION_STATUSES)[number]

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export const generateInvitationToken = (): string => crypto.randomBytes(24).toString('base64url')

export const invitationUrl = (token: string): string =>
  `${env.NEXT_PUBLIC_SERVER_URL.replace(/\/$/, '')}/invite/${token}`

const extractId = (value: OrgId | { id: OrgId }): OrgId =>
  typeof value === 'object' ? value.id : value

/**
 * On create: mint the token, default expiry/status, record the inviter and refuse roles above the
 * inviter's own (an admin cannot invite an owner). Superadmins may invite any role.
 */
const prepareInvitation: CollectionBeforeChangeHook<Invitation> = ({ data, operation, req }) => {
  if (operation !== 'create') return data

  data.token = generateInvitationToken()
  data.status = 'pending'
  data.expiresAt ??= new Date(Date.now() + INVITATION_TTL_MS).toISOString()
  if (typeof data.email === 'string') data.email = data.email.trim().toLowerCase()

  const user = req.user
  if (user && user.collection === 'users') {
    data.invitedBy ??= user.id

    if (!isSuperadmin(user) && data.organization != null && isRole(data.role)) {
      const inviterRole = getUserRole(user, extractId(data.organization))
      if (!inviterRole || !canManageRole(inviterRole, data.role)) {
        throw new ValidationError({
          collection: 'invitations',
          errors: [{ message: 'You cannot invite a role above your own.', path: 'role' }],
        })
      }
    }
  }

  return data
}

const expiry = (doc: Invitation) =>
  doc.expiresAt ? new Date(doc.expiresAt).toUTCString() : 'in 7 days'

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )

/** Email the invite link. Uses the configured Payload email adapter (console in dev/tests). */
const sendInvitationEmail: CollectionAfterChangeHook<Invitation> = async ({
  doc,
  operation,
  req,
}) => {
  if (operation !== 'create' || req.context?.skipInvitationEmail || !doc.token) return doc

  try {
    const organization = await req.payload.findByID({
      collection: 'organizations',
      id: extractId(doc.organization),
      depth: 0,
      req,
      overrideAccess: true,
    })
    const url = invitationUrl(doc.token)
    const orgName = organization?.name ?? 'an organization'

    await req.payload.sendEmail({
      to: doc.email,
      subject: `You have been invited to ${orgName} on Marmot`,
      text: `You have been invited to join ${orgName} as ${doc.role}.\n\nAccept the invitation: ${url}\n\nThis link expires on ${expiry(doc)}.`,
      html: `<p>You have been invited to join <strong>${escapeHtml(orgName)}</strong> as <strong>${doc.role}</strong>.</p><p><a href="${url}">Accept the invitation</a></p><p>This link expires on ${expiry(doc)}.</p>`,
    })
  } catch (error) {
    // Never fail the create because mail could not be delivered; the token can be resent.
    log.error({ err: error, invitation: doc.id }, 'failed to send invitation email')
  }

  return doc
}

type AcceptInvitationArgs = {
  payload: Payload
  token: string
  /** The authenticated user accepting the invitation. */
  user: { id: OrgId }
  /** Pass the current request so the writes join its transaction. */
  req?: PayloadRequest
}

export type AcceptInvitationResult = {
  invitation: OrgId
  organization: OrgId
  role: Role
}

/**
 * Shared implementation of `POST /api/invitations/:token/accept`. Validates the token, status and
 * expiry, attaches the user to the organization with the invited role (an existing membership keeps
 * its role) and marks the invitation accepted. Throws `APIError` with a meaningful status.
 */
export async function acceptInvitation({
  payload,
  token,
  user,
  req,
}: AcceptInvitationArgs): Promise<AcceptInvitationResult> {
  if (!token) throw new APIError('Invitation token is required.', 400)

  const { docs } = await payload.find({
    collection: 'invitations',
    where: { token: { equals: token } },
    depth: 0,
    limit: 1,
    req,
    overrideAccess: true,
  })
  const invitation = docs[0]
  if (!invitation) throw new APIError('Invitation not found.', 404)

  const context = { ...(req?.context ?? {}), skipInvitationEmail: true }

  const expiresAt = invitation.expiresAt ? new Date(invitation.expiresAt).getTime() : 0
  if (invitation.status === 'pending' && expiresAt < Date.now()) {
    await payload.update({
      collection: 'invitations',
      id: invitation.id,
      data: { status: 'expired' },
      depth: 0,
      req,
      overrideAccess: true,
      context,
    })
    throw new APIError('This invitation has expired.', 410)
  }

  if (invitation.status !== 'pending') {
    throw new APIError(`This invitation is ${invitation.status ?? 'no longer valid'}.`, 410)
  }

  const orgId = extractId(invitation.organization)
  const role = await addOrgMembership({
    payload,
    userId: user.id,
    orgId,
    role: invitation.role,
    req,
  })

  await payload.update({
    collection: 'invitations',
    id: invitation.id,
    data: { status: 'accepted' },
    depth: 0,
    req,
    overrideAccess: true,
    context,
  })

  return { invitation: invitation.id, organization: orgId, role }
}

/**
 * Pending invitations to join an organization. Readable and manageable by members holding
 * `member:invite` in that organization; the invitee accepts through the custom endpoint using the
 * secret token from the email, so they never need read access to the document.
 */
export const Invitations: CollectionConfig = {
  slug: 'invitations',
  admin: {
    useAsTitle: 'email',
    group: 'Access',
    defaultColumns: ['email', 'organization', 'role', 'status', 'expiresAt'],
  },
  access: {
    create: orgScoped('member:invite'),
    read: orgScoped('member:invite'),
    update: orgScoped('member:invite'),
    delete: orgScoped('member:invite'),
  },
  hooks: {
    beforeChange: [prepareInvitation],
    afterChange: [sendInvitationEmail],
  },
  endpoints: [
    {
      path: '/:token/accept',
      method: 'post',
      handler: async (req) => {
        if (!req.user) throw new APIError('You must be logged in to accept an invitation.', 401)
        const token = typeof req.routeParams?.token === 'string' ? req.routeParams.token : ''
        const result = await acceptInvitation({ payload: req.payload, token, user: req.user, req })
        return Response.json(result)
      },
    },
  ],
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      access: {
        update: () => false,
      },
    },
    {
      name: 'email',
      type: 'email',
      required: true,
      index: true,
    },
    {
      name: 'role',
      type: 'select',
      required: true,
      defaultValue: 'member',
      options: ROLES.map((role) => ({ label: role, value: role })),
    },
    {
      name: 'token',
      type: 'text',
      unique: true,
      index: true,
      admin: { readOnly: true, description: 'Generated on create.' },
      access: {
        // Field access runs in beforeValidate, so a client-supplied token is dropped before
        // `prepareInvitation` mints the real one; it is never changed afterwards.
        create: () => false,
        update: () => false,
      },
    },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'pending',
      options: INVITATION_STATUSES.map((status) => ({ label: status, value: status })),
      index: true,
    },
    {
      name: 'expiresAt',
      type: 'date',
      admin: { date: { pickerAppearance: 'dayAndTime' } },
    },
    {
      name: 'invitedBy',
      type: 'relationship',
      relationTo: 'users',
      admin: { readOnly: true },
      access: {
        update: () => false,
      },
    },
  ],
  timestamps: true,
}
