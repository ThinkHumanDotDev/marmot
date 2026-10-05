import type { CollectionConfig, FieldAccess } from 'payload'

import { authenticated, selfOrSuperadmin, superadminOnly } from '@/access/org-scoped'
import { isSuperadmin } from '@/access/permissions'

const superadminField: FieldAccess = ({ req }) => isSuperadmin(req.user)

/**
 * Payload-native auth users. Organization memberships (`organizations[]` with `organization` and
 * `role`) are added by `@payloadcms/plugin-multi-tenant` in `src/plugins/index.ts`; only
 * superadmins may edit that array directly, everyone else joins through invitations.
 */
export const Users: CollectionConfig = {
  slug: 'users',
  admin: {
    useAsTitle: 'email',
    group: 'Access',
    defaultColumns: ['email', 'name', 'superadmin'],
  },
  auth: true,
  access: {
    // Only instance administrators get the Payload admin panel; everyone else uses the Marmot UI.
    admin: ({ req }) => Boolean(req.user?.superadmin),
    read: authenticated, // the multi-tenant plugin narrows this to users who share an organization
    update: selfOrSuperadmin,
    delete: superadminOnly,
  },
  fields: [
    // email + password are added by `auth: true`
    {
      name: 'name',
      type: 'text',
    },
    {
      name: 'avatar',
      type: 'upload',
      relationTo: 'media',
    },
    {
      name: 'superadmin',
      type: 'checkbox',
      defaultValue: false,
      saveToJWT: true,
      access: {
        create: superadminField,
        update: superadminField,
      },
      admin: {
        description:
          'Instance administrator: can access the Payload admin panel and every organization.',
      },
    },
  ],
}
