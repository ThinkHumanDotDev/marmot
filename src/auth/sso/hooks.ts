import {
  AuthError,
  type IdentityContext,
  type ProviderInfo,
  type UserResolutionOptions,
} from '@thinkhuman/payload-plugin-auth'
import type { Payload } from 'payload'

import { addOrgMembership } from '@/access/memberships'
import { getUserRole } from '@/access/permissions'
import { acceptInvitation } from '@/collections/Invitations'
import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import { checkGroupAccess, extractGroups, parseGroupList } from '@/lib/sso-groups'
import type { Invitation, User } from '@/payload-types'
import { recordRequestAuditEvent, recordUserAuditEvent } from '@/server/security/audit'
import { isConnectionMeta } from '@/server/sso/connections'
import { applyGroupMapping, type GroupPolicy } from '@/server/sso/group-mapping'
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
 * Group settings of a sign-in method: the instance-wide OIDC provider reads the `OIDC_*` group
 * variables, an organization connection its own fields (rules for its organization only, never
 * removal or superadmin). GitHub and Google assert no groups and have none.
 */
export function groupPolicyFor(provider: ProviderInfo): GroupPolicy | null {
  if (isConnectionMeta(provider.meta)) {
    const meta = provider.meta
    return {
      claim: meta.groupClaim || 'groups',
      allowed: meta.allowedGroups ?? [],
      rules: (meta.groupRoles ?? []).map((rule) => ({
        group: rule.group,
        org: { id: meta.organization },
        role: rule.role,
      })),
      remove: false,
    }
  }
  if (provider.id !== OIDC_PROVIDER_ID) return null
  return {
    claim: env.OIDC_GROUP_CLAIM,
    allowed: parseGroupList(env.OIDC_ALLOWED_GROUPS),
    rules: env.OIDC_ROLE_MAPPING,
    remove: env.OIDC_ROLE_MAPPING_REMOVE,
  }
}

/**
 * The group allow-list. Runs before an account is provisioned or linked and again on every login,
 * so nobody outside the allowed groups gets an account, a linked identity or a session. Refusals
 * are audited as `auth.sso_group_denied` and end the flow with `group_not_allowed` (or
 * `groups_missing` when the provider sent no group claim at all).
 */
async function assertGroupAccess({ payload, request, identity, provider }: IdentityContext) {
  const policy = groupPolicyFor(provider)
  if (!policy || policy.allowed.length === 0) return
  const groups = extractGroups(identity.raw, policy.claim)
  const decision = checkGroupAccess(policy.allowed, groups)
  if (decision.ok) return
  log.info(
    { provider: provider.id, email: identity.email, reason: decision.code },
    'single sign-on refused by the group allow-list',
  )
  await recordRequestAuditEvent(payload, request, {
    action: 'auth.sso_group_denied',
    organization: isConnectionMeta(provider.meta) ? provider.meta.organization : null,
    metadata: {
      provider: provider.id,
      email: identity.email ?? null,
      reason: decision.code,
      claim: policy.claim,
      groups: groups?.slice(0, 50) ?? null,
    },
  })
  throw new AuthError(decision.code)
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
 * - Groups (`groupPolicyFor`): the allow-list is checked before provisioning, before linking and on
 *   every login; the group → role mapping (`applyGroupMapping`) runs on every login. A connection
 *   whose mapping assigned a role in its organization skips the default-role membership.
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

  beforeProvision: async (ctx) => {
    await assertGroupAccess(ctx)
    const { payload, identity, provider } = ctx
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

  beforeLink: assertGroupAccess,

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

  afterLogin: async (ctx) => {
    const { payload, user, provider, request, created, linked } = ctx
    await assertGroupAccess(ctx)
    const mapped = await mapGroups(ctx)
    await recordUserAuditEvent(payload, request, user, 'auth.sso_login', {
      organization: isConnectionMeta(provider.meta) ? provider.meta.organization : null,
      metadata: { provider: provider.id, created, linked },
    })
    if (!isConnectionMeta(provider.meta)) return
    const { organization, defaultRole } = provider.meta
    if (mapped.has(String(organization))) return
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

/**
 * Applies the provider's group → role mapping for the user who just signed in. An identity
 * without the group claim leaves memberships as they are (a provider that stopped releasing the
 * claim must not strip everybody's access); with an allow-list such a login never gets here.
 */
async function mapGroups({
  payload,
  request,
  identity,
  provider,
  user,
}: IdentityContext & { user: { id: string | number } }): Promise<Map<string, string>> {
  const policy = groupPolicyFor(provider)
  if (!policy || policy.rules.length === 0) return new Map()
  const groups = extractGroups(identity.raw, policy.claim)
  if (groups === null) {
    log.warn(
      { provider: provider.id, user: user.id, claim: policy.claim },
      'no group claim in the identity; role mapping skipped',
    )
    return new Map()
  }
  const { roles } = await applyGroupMapping({
    payload,
    request,
    userId: user.id,
    provider: { id: provider.id, name: provider.name },
    policy,
    groups,
  })
  return roles
}
