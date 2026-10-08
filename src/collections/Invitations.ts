import crypto from 'node:crypto'

import {
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
import {
  getOrganizationI18n,
  organizationFormatter,
  serverTranslator,
  type OrganizationI18n,
} from '@/server/i18n'
import { childLogger } from '@/lib/logger'
import { apiError } from '@/server/errors'
import { AUDIT_SKIP_CONTEXT } from '@/server/audit/context'
import { auditTarget, recordRequestAuditEvent } from '@/server/security/audit'
import { enforceEntitlementOnCreate } from '@/server/billing/entitlements'

import type { Invitation } from '@/payload-types'
import { adminGroup, adminT } from '@/i18n/admin'
import { userErrorText } from '@/server/request-locale'
import { markEmailVerified, requireVerifiedEmail } from '@/server/auth/email-verification'

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
          errors: [{ message: userErrorText(req, 'cannotInviteHigherRole'), path: 'role' }],
        })
      }
    }
  }

  return data
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )

/**
 * Subject and bodies of the invitation email, in the inviting organization's language. The expiry
 * is formatted in the organization's time zone (named `zoned` format, so the zone is spelled out).
 */
export function renderInvitationEmail({
  email,
  role,
  url,
  expiresAt,
  organizationName,
  i18n,
}: {
  email: string
  role: string
  url: string
  expiresAt?: string | null
  organizationName?: string | null
  i18n: OrganizationI18n
}): { to: string; subject: string; text: string; html: string } {
  const t = serverTranslator(i18n.locale)
  const orgName = organizationName ?? t('email.invitation.unknownOrganization')
  const expires = expiresAt
    ? t('email.invitation.expiresOn', {
        date: organizationFormatter(i18n).dateTime(new Date(expiresAt), 'zoned'),
      })
    : t('email.invitation.expiresSoon')
  // `role` is the stable identifier (`admin`, `member`, …), as in the UI's role picker values.
  const intro = (strong: (chunks: string) => string, organization: string) =>
    t.markup('email.invitation.intro', { organization, role, strong })

  return {
    to: email,
    subject: t('email.invitation.subject', { organization: orgName }),
    text: `${intro((chunks) => chunks, orgName)}\n\n${t('email.invitation.acceptLink', { url })}\n\n${expires}`,
    html: `<p>${intro((chunks) => `<strong>${chunks}</strong>`, escapeHtml(orgName))}</p><p><a href="${url}">${escapeHtml(t('email.invitation.accept'))}</a></p><p>${escapeHtml(expires)}</p>`,
  }
}

/**
 * Email the invite link. Uses the configured Payload email adapter (console in dev/tests). Runs on
 * create and again on any update made with `context.resendInvitation` (the "Resend" action).
 */
const sendInvitationEmail: CollectionAfterChangeHook<Invitation> = async ({
  doc,
  operation,
  req,
}) => {
  const resend = operation === 'update' && req.context?.resendInvitation === true
  if ((operation !== 'create' && !resend) || req.context?.skipInvitationEmail || !doc.token) {
    return doc
  }

  try {
    const organization = await req.payload.findByID({
      collection: 'organizations',
      id: extractId(doc.organization),
      depth: 0,
      req,
      overrideAccess: true,
    })
    await req.payload.sendEmail(
      renderInvitationEmail({
        email: doc.email,
        role: doc.role,
        url: invitationUrl(doc.token),
        expiresAt: doc.expiresAt,
        organizationName: organization?.name,
        i18n: await getOrganizationI18n(req.payload, organization),
      }),
    )
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
  user: { id: OrgId; email?: string | null }
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
  if (!token) throw apiError('invitationTokenRequired', 400)

  const { docs } = await payload.find({
    collection: 'invitations',
    where: { token: { equals: token } },
    depth: 0,
    limit: 1,
    req,
    overrideAccess: true,
  })
  const invitation = docs[0]
  if (!invitation) throw apiError('invitationNotFound', 404)

  // The status flips are bookkeeping; acceptance is audited once below as `invitation.accepted`.
  const context = {
    ...(req?.context ?? {}),
    skipInvitationEmail: true,
    [AUDIT_SKIP_CONTEXT]: true,
  }

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
    throw apiError('invitationExpired', 410)
  }

  if (invitation.status !== 'pending') {
    throw apiError('invitationNotValid', 410, { status: invitation.status ?? 'unknown' })
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

  // The invitation reached this address, which proves the user owns it (#177).
  await markEmailVerified(payload, {
    userId: user.id,
    email: invitation.email,
    method: 'invitation',
    req,
  })

  await recordRequestAuditEvent(payload, req ?? { headers: new Headers() }, {
    action: 'invitation.accepted',
    actor: user.id,
    actorLabel: user.email ?? null,
    organization: orgId,
    target: auditTarget('invitations', invitation.id),
    entityType: 'invitation',
    entityId: invitation.id,
    entityLabel: invitation.email,
    metadata: { email: invitation.email, role },
    req,
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
    group: adminGroup('access'),
    defaultColumns: ['email', 'organization', 'role', 'status', 'expiresAt'],
  },
  access: {
    create: orgScoped('member:invite'),
    read: orgScoped('member:invite'),
    update: orgScoped('member:invite'),
    delete: orgScoped('member:invite'),
  },
  hooks: {
    // Unconfirmed self-service accounts cannot invite people (#177).
    beforeOperation: [requireVerifiedEmail],
    // Seats: members + pending invitations must fit the plan (no-op unless BILLING_ENABLED).
    beforeChange: [prepareInvitation, enforceEntitlementOnCreate('members')],
    afterChange: [sendInvitationEmail],
  },
  endpoints: [
    {
      path: '/:token/accept',
      method: 'post',
      handler: async (req) => {
        if (!req.user) throw apiError('signInToAcceptInvitation', 401)
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
      admin: { readOnly: true, description: adminT('marmot:invitations:tokenDescription') },
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
