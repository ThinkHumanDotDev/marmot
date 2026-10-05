import crypto from 'node:crypto'

import type {
  CollectionAfterChangeHook,
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
import { validateOrganizationSlug } from '@/lib/reserved-slugs'

import type { Organization, User } from '@/payload-types'

export const PLANS = ['free', 'team', 'pro', 'enterprise'] as const
export type Plan = (typeof PLANS)[number]

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
    afterChange: [grantOwnerMembership],
    beforeDelete: [removeInvitations, removeMemberships],
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
        description: 'Lowercase letters, numbers and hyphens. Used in URLs.',
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
        description: 'Self-hosted installs are unlimited regardless of plan.',
      },
    },
    {
      name: 'inviteLinkToken',
      type: 'text',
      index: true,
      admin: {
        readOnly: true,
        description: 'Secret of the shareable invite link. Regenerate from the members page.',
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
      admin: { description: 'Role granted to people who join through the invite link.' },
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
        description:
          'Per-organization minimum roles, e.g. { "monitor:create": "admin" }. Unset permissions use the defaults in src/access/permissions.ts.',
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
          admin: { description: 'IANA time zone, e.g. Europe/London.' },
        },
        {
          name: 'weekStart',
          type: 'select',
          defaultValue: 'monday',
          options: [
            { label: 'Monday', value: 'monday' },
            { label: 'Sunday', value: 'sunday' },
          ],
        },
      ],
    },
  ],
  timestamps: true,
}
