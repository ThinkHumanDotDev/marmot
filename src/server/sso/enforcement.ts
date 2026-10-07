import type { Payload } from 'payload'

import { getUserRole, type OrgId } from '@/access/permissions'
import { SSO_DOMAINS_SLUG } from '@/collections/SsoDomains'
import { childLogger } from '@/lib/logger'
import type { Organization, User } from '@/payload-types'

import { emailDomain } from './domains'

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
 * The organization-enforcement half of the password policy (`./local-login.ts` combines it with
 * the instance-wide SSO-only mode): with `enforceSso` on, password logins are refused for users on
 * the organization's verified domains. Owners of the organization (and superadmins) keep a
 * break-glass password login so a misconfigured identity provider cannot lock everyone out.
 *
 * Returns `null` when no organization enforces single sign-on for the user, the enforcing
 * organization's id when the user may still use the password (break-glass), `false` otherwise.
 */
export async function passwordAllowedUnderEnforcement(
  payload: Payload,
  account: Pick<User, 'id' | 'email' | 'superadmin' | 'organizations'>,
): Promise<OrgId | false | null> {
  if (!account.email) return null
  const org = await enforcingOrganizationFor(payload, account.email)
  if (!org) return null
  if (getUserRole(account, org.id) === 'owner' || account.superadmin === true) return org.id
  log.info({ user: account.id, organization: org.id }, 'password refused: SSO enforced')
  return false
}
