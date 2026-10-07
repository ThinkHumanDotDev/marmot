import {
  AuthError,
  type ProviderInfo,
  type UserResolutionOptions,
} from '@thinkhuman/payload-plugin-auth'
import type { Payload } from 'payload'

import { addOrgMembership } from '@/access/memberships'
import { getUserRole } from '@/access/permissions'
import { acceptInvitation } from '@/collections/Invitations'
import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import type { Invitation, User } from '@/payload-types'
import { recordUserAuditEvent } from '@/server/security/audit'
import { isConnectionMeta } from '@/server/sso/connections'
import { isVerifiedDomainOf } from '@/server/sso/domains'

import { OIDC_PROVIDER_ID } from './providers'

const log = childLogger('sso')

async function findPendingInvitation(
  payload: Payload,
  email: string,
): Promise<Invitation | undefined> {
  const { docs } = await payload.find({
    collection: 'invitations',
    where: {
      and: [
        { email: { equals: email } },
        { status: { equals: 'pending' } },
        { expiresAt: { greater_than: new Date().toISOString() } },
      ],
    },
    sort: '-createdAt',
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  return docs[0]
}

/** `saml` for SAML connections, `oidc` for OpenID Connect providers, `oauth` for plain OAuth (GitHub). */
const authProviderFor = (provider: ProviderInfo): User['authProvider'] => {
  if (provider.type === 'saml') return 'saml'
  return provider.type === 'oidc' ? 'oidc' : 'oauth'
}

/**
 * How identities become Marmot users, shared by the OAuth/OIDC and SAML integrations:
 *
 * - **Instance-wide providers** (`OIDC_*`, GitHub, Google): provisioning honours the provider's
 *   `autoProvision` flag and, with `DISABLE_SIGNUP`, requires a pending invitation that is
 *   accepted after the account is created.
 * - **Organization connections** (`sso-connections`): the organization's identity provider vouches
 *   for the user, so no invitation is needed; new users are created when the connection's
 *   `autoProvision` is on, and every user who signs in through the connection joins the
 *   organization with its `defaultRole` (just-in-time membership) unless they are a member already.
 * - Installs from before the `auth-accounts` collection stored the OIDC identity on the user:
 *   `findUser` matches those columns so they keep signing in.
 */
export const userResolution: UserResolutionOptions = {
  autoProvision: ({ provider }) =>
    isConnectionMeta(provider.meta)
      ? provider.meta.autoProvision
      : provider.meta?.autoProvision !== false,

  findUser: async ({ payload, identity, provider }) => {
    if (provider.id !== OIDC_PROVIDER_ID) return null
    const { docs } = await payload.find({
      collection: 'users',
      where: {
        and: [
          { oidcIssuer: { equals: env.OIDC_ISSUER_URL } },
          { oidcSubject: { equals: identity.providerAccountId } },
        ],
      },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    return docs[0] ?? null
  },

  beforeProvision: async ({ payload, identity, provider }) => {
    if (isConnectionMeta(provider.meta) || !env.DISABLE_SIGNUP) return
    const email = identity.email?.trim().toLowerCase()
    if (!email || !(await findPendingInvitation(payload, email))) {
      throw new AuthError('signup_disabled')
    }
  },

  /**
   * Linking an identity to an existing user by email needs the provider to assert the email as
   * verified (OIDC `email_verified`; SAML connections always assert it). An organization connection
   * may also link when the organization has verified that email's domain.
   */
  linkByVerifiedEmail: async ({ payload, identity, provider, user }) => {
    if (identity.emailVerified) return true
    if (!isConnectionMeta(provider.meta)) return false
    const trusted = await isVerifiedDomainOf(payload, provider.meta.organization, identity.email)
    if (trusted) {
      log.info({ user: user.id, provider: provider.id }, 'linking by organization-verified domain')
    }
    return trusted
  },

  mapNewUser: ({ provider }) => ({ authProvider: authProviderFor(provider) }),

  afterProvision: async ({ payload, user, identity, provider }) => {
    if (isConnectionMeta(provider.meta) || !env.DISABLE_SIGNUP) return
    const email = identity.email?.trim().toLowerCase()
    const invitation = email ? await findPendingInvitation(payload, email) : undefined
    if (!invitation?.token) return
    try {
      await acceptInvitation({ payload, token: invitation.token, user: user as unknown as User })
    } catch (error) {
      // The account exists either way; the invitation link can still be used afterwards.
      log.warn({ err: error, user: user.id }, 'could not accept invitation during provisioning')
    }
  },

  afterLogin: async ({ payload, user, provider, request, created, linked }) => {
    await recordUserAuditEvent(payload, request, user, 'auth.sso_login', {
      organization: isConnectionMeta(provider.meta) ? provider.meta.organization : null,
      metadata: { provider: provider.id, created, linked },
    })
    if (!isConnectionMeta(provider.meta)) return
    const { organization, defaultRole } = provider.meta
    const current = await payload.findByID({
      collection: 'users',
      id: user.id,
      depth: 0,
      overrideAccess: true,
    })
    if (getUserRole(current, organization)) return
    await addOrgMembership({ payload, userId: user.id, orgId: organization, role: defaultRole })
    log.info({ user: user.id, organization, role: defaultRole }, 'joined organization through SSO')
  },
}
