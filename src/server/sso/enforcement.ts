import type { CollectionBeforeLoginHook, Payload } from 'payload'

import { getUserRole } from '@/access/permissions'
import { SSO_DOMAINS_SLUG } from '@/collections/SsoDomains'
import { childLogger } from '@/lib/logger'
import type { Organization, User } from '@/payload-types'
import { recordRequestAuditEvent } from '@/server/security/audit'

import { emailDomain } from './domains'
import { apiError } from '@/server/errors'

const log = childLogger('sso')

export const SSO_ENFORCED_MESSAGE =
  "Your organization requires single sign-on. Use “Sign in with your organization's SSO” on the login page."

/**
 * The organization that enforces single sign-on for `email`'s domain, or `null`: the domain must be
 * verified by an organization whose `enforceSso` is on.
 */
export async function enforcingOrganizationFor(
  payload: Payload,
  email: string | null | undefined,
): Promise<Organization | null> {
  const domain = email ? emailDomain(email) : null
  if (!domain) return null
  const { docs } = await payload.find({
    collection: SSO_DOMAINS_SLUG,
    where: { and: [{ domain: { equals: domain } }, { verifiedAt: { exists: true } }] },
    limit: 1,
    depth: 1,
    overrideAccess: true,
  })
  const verified = docs[0]
  if (!verified) return null
  const org =
    typeof verified.organization === 'object'
      ? verified.organization
      : await payload.findByID({
          collection: 'organizations',
          id: verified.organization,
          depth: 0,
          overrideAccess: true,
        })
  return org?.enforceSso ? org : null
}

/**
 * `users.beforeLogin`: with `enforceSso` on, password logins for users on the organization's
 * verified domains are refused (`POST /api/users/login`, `payload.login` and therefore Marmot's own
 * `POST /api/auth/login` all pass through here). Owners of the organization keep a break-glass
 * password login so a misconfigured identity provider cannot lock everyone out; each one is written
 * to the audit log as `auth.break_glass`. Single sign-on logins never call `login`, so they are
 * unaffected.
 */
export const enforceSsoOnPasswordLogin: CollectionBeforeLoginHook = async ({ user, req }) => {
  const account = user as User | null | undefined
  if (!account?.email) return user
  const org = await enforcingOrganizationFor(req.payload, account.email)
  if (!org) return user

  if (getUserRole(account, org.id) === 'owner' || account.superadmin === true) {
    log.warn(
      { user: account.id, organization: org.id },
      'break-glass password login under SSO enforcement',
    )
    await recordRequestAuditEvent(req.payload, req, {
      action: 'auth.break_glass',
      actor: account.id,
      organization: org.id,
      target: `users:${String(account.id)}`,
      metadata: { reason: 'password login while single sign-on is enforced' },
      req,
    })
    return user
  }

  log.info({ user: account.id, organization: org.id }, 'password login refused: SSO enforced')
  throw apiError('ssoEnforced', 403)
}
