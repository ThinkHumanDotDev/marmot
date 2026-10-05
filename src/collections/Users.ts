import type { CollectionConfig, FieldAccess } from 'payload'

import { authenticated, selfOrSuperadmin, superadminOnly } from '@/access/org-scoped'
import { isSuperadmin, type UserLike } from '@/access/permissions'
import { env } from '@/env'

const superadminField: FieldAccess = ({ req }) => isSuperadmin(req.user)

/**
 * Who may create a user. Superadmins always can; anyone (including anonymous visitors on the
 * signup page, which posts to `POST /api/users`) can while `DISABLE_SIGNUP` is false. Invitation
 * acceptance for an existing account does not create users; a future invite-signup flow creates
 * them server-side with `overrideAccess: true`.
 */
export const canSignUp = (user: UserLike | null | undefined, disableSignup: boolean): boolean =>
  isSuperadmin(user) || !disableSignup

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
    // Anonymous creation is allowed for signup; field-level access below (and the multi-tenant
    // plugin's access on `organizations`) strips `superadmin` and memberships from such requests.
    create: ({ req }) => canSignUp(req.user, env.DISABLE_SIGNUP),
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
