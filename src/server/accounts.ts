import { listAccounts, unlinkAccount } from '@thinkhuman/payload-plugin-auth'
import { APIError, type Payload } from 'payload'

import { getInstanceProviders } from '@/auth/sso/providers'
import { AUTH_ACCOUNTS_SLUG } from '@/collections/AuthAccounts'
import { hasPassword } from '@/collections/Users'
import type { User } from '@/payload-types'

/** One linked identity as the account settings page shows it. */
export interface ConnectedAccount {
  id: string | number
  provider: string
  /** Display name of the provider, or the raw id for connections that no longer exist. */
  providerName: string
  providerAccountId: string
  email: string | null
  lastLoginAt: string | null
}

export interface ConnectedAccounts {
  accounts: ConnectedAccount[]
  /** Providers the user can still link (enabled on this instance and not linked yet). */
  linkable: { id: string; name: string; loginPath: string }[]
  /** Whether the user has a password of their own (an SSO-only account cannot unlink its last identity). */
  hasPassword: boolean
}

const client = (payload: Payload) => ({
  payload,
  usersSlug: 'users',
  accountsSlug: AUTH_ACCOUNTS_SLUG,
})

export async function listConnectedAccounts(
  payload: Payload,
  user: User,
): Promise<ConnectedAccounts> {
  const providers = getInstanceProviders()
  const rows = await listAccounts(client(payload), user.id)
  const linked = new Set(rows.map((row) => row.provider))
  return {
    accounts: rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      providerName: providers.find((p) => p.id === row.provider)?.name ?? row.provider,
      providerAccountId: row.providerAccountId,
      email: row.email ?? null,
      lastLoginAt: row.lastLoginAt ?? null,
    })),
    linkable: providers
      .filter((provider) => !linked.has(provider.id))
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        loginPath: `/api/auth/sso/${provider.id}/login`,
      })),
    hasPassword: hasPassword(user),
  }
}

/**
 * Unlinks one of the user's identities. Refused when it is their last way in: an account created
 * through single sign-on has no password of its own, so it must keep at least one linked identity.
 */
export async function unlinkConnectedAccount(
  payload: Payload,
  user: User,
  accountId: string | number,
): Promise<void> {
  const rows = await listAccounts(client(payload), user.id)
  const target = rows.find((row) => String(row.id) === String(accountId))
  if (!target) throw new APIError('Linked account not found.', 404)
  if (!hasPassword(user) && rows.length <= 1) {
    throw new APIError(
      'This is the only way to sign in to your account. Set a password or link another account first.',
      409,
    )
  }
  await unlinkAccount(client(payload), user.id, target.id)
}
