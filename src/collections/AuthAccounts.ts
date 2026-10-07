import { linkedAccountsCollection } from '@thinkhuman/payload-plugin-auth'
import type { Access } from 'payload'

import { isSuperadmin, type UserLike } from '@/access/permissions'
import { adminGroup, adminT } from '@/i18n/admin'

export const AUTH_ACCOUNTS_SLUG = 'auth-accounts' as const

/** Superadmins see every linked account; everyone else only their own rows (for the account page). */
const ownOrSuperadmin: Access = ({ req }) => {
  const user = req.user as (UserLike & { collection?: string }) | null | undefined
  if (!user || user.collection !== 'users') return false
  if (isSuperadmin(user)) return true
  return { user: { equals: user.id } }
}

/**
 * External identities linked to users: `(provider, providerAccountId) → user`, one row per identity
 * so a user can sign in with the company IdP and GitHub at the same time. Rows are written by the
 * single sign-on flows (`src/auth/sso`, through `@thinkhuman/payload-plugin-auth`) with
 * `overrideAccess`; the API only lets users read and unlink their own.
 */
export const AuthAccounts = linkedAccountsCollection({
  slug: AUTH_ACCOUNTS_SLUG,
  usersSlug: 'users',
  access: { read: ownOrSuperadmin, delete: ownOrSuperadmin },
  admin: {
    group: adminGroup('access'),
    useAsTitle: 'providerAccountId',
    defaultColumns: ['provider', 'providerAccountId', 'user', 'email', 'lastLoginAt'],
    description: adminT('marmot:authAccounts:description'),
  },
})
