import type {
  CollectionAfterChangeHook,
  CollectionBeforeDeleteHook,
  CollectionBeforeValidateHook,
  CollectionConfig,
} from 'payload'

import { authenticated, orgScoped } from '@/access/org-scoped'
import { addOrgMembership, toMembershipData } from '@/access/memberships'
import { validateOrganizationSlug } from '@/lib/reserved-slugs'

import type { Organization, User } from '@/payload-types'

export const PLANS = ['free', 'team', 'pro', 'enterprise'] as const
export type Plan = (typeof PLANS)[number]

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
    beforeDelete: [removeMemberships],
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
