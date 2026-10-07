import crypto from 'node:crypto'

import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionBeforeDeleteHook,
  CollectionBeforeValidateHook,
  CollectionConfig,
  FieldAccess,
} from 'payload'

import { authenticated, orgScoped } from '@/access/org-scoped'
import { addOrgMembership, toMembershipData } from '@/access/memberships'
import {
  can,
  getUserRole,
  isPermission,
  isRole,
  isSuperadmin,
  LOCKED_PERMISSIONS,
  ROLES,
} from '@/access/permissions'
import { adminT } from '@/i18n/admin'
import { defaultLocale, localeNames, locales } from '@/i18n/locales'
import { PLANS, SUBSCRIPTION_STATUSES } from '@/lib/entitlements'
import { validateOrganizationSlug } from '@/lib/reserved-slugs'
import { auditTarget, recordRequestAuditEvent } from '@/server/security/audit'
import { captureServerEvent, hashAnalyticsId } from '@/server/analytics'

import type { Organization, User } from '@/payload-types'

export { PLANS, type Plan } from '@/lib/entitlements'

/**
 * Plan and Stripe fields are written by superadmins (admin panel) and by the billing code through
 * the Local API with `overrideAccess: true`; members cannot grant themselves a plan.
 */
const superadminWrite: FieldAccess = ({ req }) => isSuperadmin(req.user)

/** Secret for the shareable invite link (`/invite/<token>`). */
export const generateInviteLinkToken = (): string => crypto.randomBytes(24).toString('base64url')

/**
 * The invite link token is a credential: only members who may invite (`member:invite`) and
 * superadmins can read it. Writes go through `POST /api/orgs/:orgId/invite-link`, never the client.
 */
const inviteLinkRead: FieldAccess = ({ req, doc }) => {
  if (isSuperadmin(req.user)) return true
  const id = doc && typeof doc === 'object' ? (doc as { id?: string | number }).id : undefined
  return id !== undefined && can(req.user, id, 'member:invite')
}

/** Only owners (and superadmins) may change who can do what; `PUT /api/orgs/:orgId/permissions`. */
const ownerField: FieldAccess = ({ req, doc }) => {
  if (isSuperadmin(req.user)) return true
  const id = doc && typeof doc === 'object' ? (doc as { id?: string | number }).id : undefined
  return id !== undefined && getUserRole(req.user, id) === 'owner'
}

/** `{ [permission]: minRole }` with known permissions and roles only; locked permissions refused. */
export function validatePermissionOverrides(value: unknown): true | string {
  if (value === undefined || value === null) return true
  if (typeof value !== 'object' || Array.isArray(value)) {
    return 'Permission overrides must be an object of permission → role.'
  }
  for (const [permission, role] of Object.entries(value as Record<string, unknown>)) {
    if (!isPermission(permission)) return `Unknown permission "${permission}".`
    if (LOCKED_PERMISSIONS.includes(permission)) {
      return `"${permission}" cannot be overridden.`
    }
    if (!isRole(role)) return `Invalid role for "${permission}".`
  }
  return true
}

/** Lowercase and trim the slug before validation so `My-Org ` becomes `my-org`. */
const normalizeSlug: CollectionBeforeValidateHook<Organization> = ({ data }) => {
  if (data && typeof data.slug === 'string') {
    data.slug = data.slug.trim().toLowerCase()
  }
  return data
}

/**
 * The user who creates an organization becomes its owner. Membership rows live on the user, so
 * this hook appends `{ organization, role: 'owner' }` to the creator's `organizations` array.
 * `req.context.skipOwnerMembership` lets seeds and the invitation flow opt out.
 */
const grantOwnerMembership: CollectionAfterChangeHook<Organization> = async ({
  doc,
  operation,
  req,
}) => {
  if (operation !== 'create' || req.context?.skipOwnerMembership) return doc
  const user = req.user
  if (!user || user.collection !== 'users') return doc

  await addOrgMembership({
    payload: req.payload,
    userId: user.id,
    orgId: doc.id,
    role: 'owner',
    req,
  })

  return doc
}

/**
 * Keeps the Stripe customer's name in sync with the organization. Only runs when Stripe is
 * configured and the organization already has a customer; `context.skipStripeSync` guards writes
 * made by the webhook handlers themselves.
 */
const syncStripeCustomer: CollectionAfterChangeHook<Organization> = async ({
  doc,
  operation,
  previousDoc,
  req,
}) => {
  if (operation !== 'update' || req.context?.skipStripeSync) return doc
  if (!doc.stripeCustomerId || doc.name === previousDoc?.name) return doc
  try {
    const { syncStripeCustomerName } = await import('@/server/billing/stripe')
    await syncStripeCustomerName(doc)
  } catch {
    // Logged inside; never fail the organization update over Stripe.
  }
  return doc
}

/**
 * Opt-in telemetry (docs/Telemetry.md): counts new organizations. The only identifier is a keyed
 * hash of the organization id; a no-op unless `NEXT_PUBLIC_POSTHOG_KEY` is set.
 */
const trackOrgCreated: CollectionAfterChangeHook<Organization> = ({ doc, operation }) => {
  if (operation === 'create') {
    captureServerEvent('org_created', { orgId: hashAnalyticsId(doc.id) })
  }
  return doc
}

/**
 * Remove the organization from every member before the row is deleted. The multi-tenant plugin does
 * the same in `afterDelete`, but on Postgres the membership relationship is a NOT NULL column whose
 * foreign key would otherwise fail (`ON DELETE SET NULL`) before that hook runs.
 */
const removeMemberships: CollectionBeforeDeleteHook = async ({ id, req }) => {
  const { docs } = await req.payload.find({
    collection: 'users',
    where: { 'organizations.organization': { in: [id] } },
    depth: 0,
    limit: 0,
    pagination: false,
    req,
    overrideAccess: true,
  })

  for (const user of docs) {
    await req.payload.update({
      collection: 'users',
      id: user.id,
      data: {
        organizations: toMembershipData(user.organizations).filter(
          (row) => String(row.organization) !== String(id),
        ) as User['organizations'],
      },
      depth: 0,
      req,
      overrideAccess: true,
    })
  }
}

/**
 * Pending invitations reference the organization with a NOT NULL foreign key on Postgres, so they
 * have to go before the organization row does.
 */
const removeInvitations: CollectionBeforeDeleteHook = async ({ id, req }) => {
  await req.payload.delete({
    collection: 'invitations',
    where: { organization: { equals: id } },
    depth: 0,
    req,
    overrideAccess: true,
  })
}

/** SSO connections and verified domains carry a NOT NULL `organization` on Postgres too. */
const removeSso: CollectionBeforeDeleteHook = async ({ id, req }) => {
  for (const collection of ['sso-connections', 'sso-domains'] as const) {
    await req.payload.delete({
      collection,
      where: { organization: { equals: id } },
      depth: 0,
      req,
      overrideAccess: true,
    })
  }
}

/** API keys carry a NOT NULL `organization` on Postgres; revoke them before the row goes. */
const removeApiKeys: CollectionBeforeDeleteHook = async ({ id, req }) => {
  await req.payload.delete({
    collection: 'api-keys',
    where: { organization: { equals: id } },
    depth: 0,
    req,
    overrideAccess: true,
  })
}

const actorId = (req: { user?: { id: string | number; collection?: string } | null }) =>
  req.user && req.user.collection === 'users' ? req.user.id : null

/** Audit `organization.updated` with the list of changed top-level fields (never their values). */
const auditOrganizationUpdated: CollectionAfterChangeHook<Organization> = async ({
  doc,
  previousDoc,
  operation,
  req,
}) => {
  if (operation !== 'update' || req.context?.skipOrganizationAudit) return doc
  const current = doc as unknown as Record<string, unknown>
  const previous = (previousDoc ?? {}) as unknown as Record<string, unknown>
  const changed = Object.keys(current).filter(
    (key) =>
      !['updatedAt', 'createdAt'].includes(key) &&
      JSON.stringify(current[key]) !== JSON.stringify(previous[key]),
  )
  if (changed.length === 0) return doc
  await recordRequestAuditEvent(req.payload, req, {
    action: 'organization.updated',
    actor: actorId(req),
    organization: doc.id,
    target: auditTarget('organizations', doc.id),
    metadata: { changed },
    req,
  })
  return doc
}

/**
 * Audit `organization.deleted`. The row cannot point at the deleted organization (the relationship
 * would dangle), so it is instance-level (superadmins) and names the organization in `metadata`.
 */
const auditOrganizationDeleted: CollectionAfterDeleteHook<Organization> = async ({ doc, req }) => {
  await recordRequestAuditEvent(req.payload, req, {
    action: 'organization.deleted',
    actor: actorId(req),
    organization: null,
    target: auditTarget('organizations', doc.id),
    metadata: { name: doc.name, slug: doc.slug },
    req,
  })
}

/**
 * Tenant collection for `@payloadcms/plugin-multi-tenant`. Access is implemented here (the plugin's
 * own tenant-collection access is disabled) so that any authenticated user can create their first
 * organization, members can read theirs, and `organization:update` / `organization:delete` gate
 * changes by role. Superadmins bypass everything.
 */
export const Organizations: CollectionConfig = {
  slug: 'organizations',
  admin: {
    useAsTitle: 'name',
    group: 'Access',
    defaultColumns: ['name', 'slug', 'plan', 'createdAt'],
  },
  access: {
    create: authenticated,
    read: orgScoped('organization:read', { field: 'id' }),
    update: orgScoped('organization:update', { field: 'id' }),
    delete: orgScoped('organization:delete', { field: 'id' }),
  },
  hooks: {
    beforeValidate: [normalizeSlug],
    afterChange: [
      grantOwnerMembership,
      syncStripeCustomer,
      trackOrgCreated,
      auditOrganizationUpdated,
    ],
    beforeDelete: [removeInvitations, removeApiKeys, removeSso, removeMemberships],
    afterDelete: [auditOrganizationDeleted],
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
    },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      validate: (value: unknown) => validateOrganizationSlug(value),
      admin: {
        description: adminT('marmot:organizations:slugDescription'),
      },
    },
    {
      name: 'logo',
      type: 'upload',
      relationTo: 'media',
    },
    {
      name: 'plan',
      type: 'select',
      defaultValue: 'free',
      options: PLANS.map((plan) => ({ label: plan, value: plan })),
      admin: {
        description: adminT('marmot:organizations:planDescription'),
      },
      access: { create: superadminWrite, update: superadminWrite },
    },
    {
      name: 'subscriptionStatus',
      type: 'select',
      defaultValue: 'none',
      options: SUBSCRIPTION_STATUSES.map((status) => ({ label: status, value: status })),
      admin: {
        position: 'sidebar',
        description: adminT('marmot:organizations:subscriptionStatusDescription'),
      },
      access: { create: superadminWrite, update: superadminWrite },
    },
    {
      name: 'stripeCustomerId',
      type: 'text',
      index: true,
      admin: { position: 'sidebar', readOnly: true },
      access: { create: superadminWrite, update: superadminWrite },
    },
    {
      name: 'stripeSubscriptionId',
      type: 'text',
      index: true,
      admin: { position: 'sidebar', readOnly: true },
      access: { create: superadminWrite, update: superadminWrite },
    },
    {
      name: 'inviteLinkToken',
      type: 'text',
      index: true,
      admin: {
        readOnly: true,
        description: adminT('marmot:organizations:inviteLinkTokenDescription'),
      },
      access: {
        read: inviteLinkRead,
        create: () => false,
        update: () => false,
      },
    },
    {
      name: 'inviteLinkRole',
      type: 'select',
      defaultValue: 'member',
      options: ROLES.map((role) => ({ label: role, value: role })),
      admin: { description: adminT('marmot:organizations:inviteLinkRoleDescription') },
      access: {
        create: () => false,
        update: () => false,
      },
    },
    {
      name: 'permissionOverrides',
      type: 'json',
      validate: (value: unknown) => validatePermissionOverrides(value),
      access: {
        update: ownerField,
      },
      admin: {
        description: adminT('marmot:organizations:permissionOverridesDescription'),
      },
    },
    {
      name: 'enforceSso',
      type: 'checkbox',
      defaultValue: false,
      access: { update: ownerField },
      admin: {
        position: 'sidebar',
        description: adminT('marmot:organizations:enforceSsoDescription'),
      },
    },
    {
      name: 'settings',
      type: 'group',
      fields: [
        {
          name: 'timezone',
          type: 'text',
          defaultValue: 'UTC',
          admin: { description: adminT('marmot:organizations:timezoneDescription') },
        },
        {
          name: 'weekStart',
          type: 'select',
          defaultValue: 'monday',
          options: [
            { label: adminT('marmot:organizations:weekStartMonday'), value: 'monday' },
            { label: adminT('marmot:organizations:weekStartSunday'), value: 'sunday' },
          ],
        },
        // Language of emails and notifications sent for this organization (src/i18n).
        {
          name: 'language',
          type: 'select',
          label: adminT('marmot:language'),
          defaultValue: defaultLocale,
          options: locales.map((locale) => ({ label: localeNames[locale], value: locale })),
          admin: { description: adminT('marmot:organizationLanguageDescription') },
        },
      ],
    },
  ],
  timestamps: true,
}
