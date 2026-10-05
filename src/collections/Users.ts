import type { CollectionConfig, FieldAccess } from 'payload'

import { authenticated, selfOrSuperadmin, superadminOnly } from '@/access/org-scoped'
import { isSuperadmin, type UserLike } from '@/access/permissions'
import { auditAuthFailure, auditLogin, rateLimitAuthOperations } from '@/server/security/auth-hooks'
import { isSignupAllowed } from '@/server/settings'

const superadminField: FieldAccess = ({ req }) => isSuperadmin(req.user)

export const AUTH_PROVIDERS = ['local', 'oidc'] as const
export type AuthProvider = (typeof AUTH_PROVIDERS)[number]

/**
 * Who may create a user. Superadmins always can; anyone (including anonymous visitors on the
 * signup page, which posts to `POST /api/users`) can while signup is allowed: the
 * `instance-settings` global's `allowSignup`, which defaults to `!DISABLE_SIGNUP`. Invitation
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
    create: async ({ req }) => canSignUp(req.user, !(await isSignupAllowed(req.payload))),
    read: authenticated, // the multi-tenant plugin narrows this to users who share an organization
    update: selfOrSuperadmin,
    delete: superadminOnly,
  },
  hooks: {
    // Rate limits `login` / `forgot-password` (REST only) and records the attempts in `audit-logs`.
    beforeOperation: [rateLimitAuthOperations],
    afterLogin: [auditLogin],
    afterError: [auditAuthFailure],
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
    // Single sign-on (src/auth/oidc). Set server-side by the OIDC callback with `overrideAccess`;
    // clients can never write them, so a signup POST cannot claim somebody else's identity.
    {
      name: 'authProvider',
      type: 'select',
      defaultValue: 'local',
      options: AUTH_PROVIDERS.map((provider) => ({ label: provider, value: provider })),
      access: {
        create: superadminField,
        update: superadminField,
      },
      admin: {
        position: 'sidebar',
        description: 'How the account was created: password signup or single sign-on.',
      },
    },
    {
      name: 'oidcIssuer',
      type: 'text',
      access: {
        create: superadminField,
        update: superadminField,
      },
      admin: { position: 'sidebar', readOnly: true },
    },
    {
      name: 'oidcSubject',
      type: 'text',
      unique: true,
      index: true,
      access: {
        create: superadminField,
        update: superadminField,
      },
      admin: {
        position: 'sidebar',
        readOnly: true,
        description: 'Stable `sub` claim of the linked single sign-on identity.',
      },
    },
  ],
}
