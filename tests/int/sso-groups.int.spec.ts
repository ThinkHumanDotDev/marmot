import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The issuer and the group settings must be in `process.env` before `env`/`@payload-config` are
// first imported (the env is parsed once and cached), hence `vi.hoisted`. Tests that flip a
// variable call `resetEnvCache()`.
const setup = await vi.hoisted(async () => {
  const { startMockIssuer } = await import('../helpers/oidc-issuer')
  const issuer = await startMockIssuer()
  const run = Date.now().toString(36)
  const slugs = { acme: `grp-acme-${run}`, ops: `grp-ops-${run}`, solo: `grp-solo-${run}` }
  process.env.OIDC_ISSUER_URL = issuer.issuer
  process.env.OIDC_CLIENT_ID = issuer.clientId
  process.env.OIDC_CLIENT_SECRET = issuer.clientSecret
  process.env.OIDC_AUTO_PROVISION = 'true'
  process.env.DISABLE_SIGNUP = 'false'
  const mapping = JSON.stringify({
    sre: { org: slugs.acme, role: 'member' },
    'Platform-Admins': [
      { org: slugs.acme, role: 'admin' },
      { org: slugs.ops, role: 'viewer' },
    ],
    'solo-owners': { org: slugs.solo, role: 'owner' },
    'solo-members': { org: slugs.solo, role: 'member' },
    'marmot-admins': { role: 'superadmin' },
  })
  const defaults = {
    OIDC_GROUP_CLAIM: 'groups',
    OIDC_ALLOWED_GROUPS:
      'Marmot-Users, sre, platform-admins, solo-owners, solo-members, marmot-admins',
    OIDC_ROLE_MAPPING: mapping,
    OIDC_ROLE_MAPPING_REMOVE: 'false',
    OIDC_DISABLE_LOCAL_LOGIN: 'false',
    OIDC_BREAK_GLASS: 'false',
  }
  Object.assign(process.env, defaults)
  return { issuer, run, slugs, defaults }
})

import config from '@payload-config'

import { getUserRole } from '@/access/permissions'
import { POST as restPost } from '@/app/(payload)/api/[...slug]/route'
import { handleProviders, handleSsoCallback, handleSsoLogin } from '@/auth/sso/handlers'
import { handlePasswordLogin } from '@/auth/two-factor/handlers'
import { verifyPassword } from '@/auth/password'
import { env, resetEnvCache } from '@/env'
import type { AuditLog, Organization, User } from '@/payload-types'
import { closeRateLimitStore } from '@/server/security/rate-limit'
import { isSignupAllowed } from '@/server/settings'
import { createSetupSession } from '@/server/setup'
import { refusePasswordReset } from '@/server/sso/local-login'

import type { MockIssuerUser } from '../helpers/oidc-issuer'

const { issuer, run, slugs } = setup
const ORIGIN = 'http://localhost:3000'
const PASSWORD = 'password-123'
const email = (name: string) => `${name}+grp-${run}@groups.marmot.test`
const sub = (name: string) => `${name}-grp-${run}`

let payload: Payload
let acme: Organization
let ops: Organization
let solo: Organization
let unmanaged: Organization
let otherSuperadmin: User

function setEnv(values: Record<string, string>) {
  Object.assign(process.env, values)
  resetEnvCache()
}

const identity = (name: string, claims: Partial<MockIssuerUser> = {}): MockIssuerUser => ({
  sub: sub(name),
  email: email(name),
  email_verified: true,
  name,
  ...claims,
})

const locationOf = (res: Response) => res.headers.get('location') ?? ''
const sessionCookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${payload.config.cookiePrefix}-token=`))
    ?.split(';')[0]

/** Full OIDC login against the mock issuer as `user`. */
async function login(user: MockIssuerUser) {
  issuer.setUser(user)
  const start = await handleSsoLogin(new Request(`${ORIGIN}/api/auth/sso/oidc/login`), 'oidc')
  expect(start.status).toBe(302)
  const cookie = (
    start.headers.getSetCookie().find((c) => c.startsWith('marmot-sso=')) ?? ''
  ).split(';')[0]
  const authorized = await fetch(locationOf(start), { redirect: 'manual' })
  const callbackUrl = new URL(authorized.headers.get('location') ?? '')
  return handleSsoCallback(new Request(callbackUrl, { headers: { cookie } }), 'oidc')
}

async function userByEmail(address: string): Promise<User | null> {
  const { docs } = await payload.find({
    collection: 'users',
    where: { email: { equals: address } },
    depth: 0,
    overrideAccess: true,
  })
  return docs[0] ?? null
}

async function auditFor(action: string, entityId: string | number): Promise<AuditLog[]> {
  const { docs } = await payload.find({
    collection: 'audit-logs',
    where: { and: [{ action: { equals: action } }, { entityId: { equals: String(entityId) } }] },
    sort: '-createdAt',
    depth: 0,
    limit: 50,
    overrideAccess: true,
  })
  return docs
}

const createOrg = async (name: string, slug: string) =>
  (await payload.create({
    collection: 'organizations',
    data: { name, slug },
    overrideAccess: true,
    context: { skipOwnerMembership: true },
  })) as Organization

async function setRole(userId: User['id'], org: Organization, role: string | null) {
  const user = await payload.findByID({ collection: 'users', id: userId, overrideAccess: true })
  const rows = (user.organizations ?? [])
    .map((row) => ({
      organization: typeof row.organization === 'object' ? row.organization.id : row.organization,
      role: row.role,
    }))
    .filter((row) => String(row.organization) !== String(org.id))
  if (role) rows.push({ organization: org.id, role: role as never })
  await payload.update({
    collection: 'users',
    id: userId,
    data: { organizations: rows as never },
    overrideAccess: true,
    context: { skipOwnerMembership: true },
  })
}

const restRequest = (path: string, body: unknown, query = '') =>
  restPost(
    new Request(`${env.NEXT_PUBLIC_SERVER_URL}/api/users/${path}${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: env.NEXT_PUBLIC_SERVER_URL },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug: ['users', path] }) },
  )

const passwordLogin = (address: string, local = false) =>
  handlePasswordLogin(
    new Request(`${ORIGIN}/api/auth/login${local ? '?local=1' : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email: address, password: PASSWORD }),
    }),
  )

describe('single sign-on groups', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    acme = await createOrg('Acme', slugs.acme)
    ops = await createOrg('Ops', slugs.ops)
    solo = await createOrg('Solo', slugs.solo)
    unmanaged = await createOrg('Unmanaged', `grp-unmanaged-${run}`)
    // A second superadmin, so revoking superadmin from a mapped user never hits the last one.
    otherSuperadmin = await payload.create({
      collection: 'users',
      data: { email: email('root'), password: PASSWORD, superadmin: true },
      overrideAccess: true,
    })
  })

  beforeEach(() => setEnv(setup.defaults))

  afterAll(async () => {
    setEnv(setup.defaults)
    await closeRateLimitStore()
    const { docs } = await payload.find({
      collection: 'users',
      where: { email: { like: `+grp-${run}@groups.marmot.test` } },
      limit: 100,
      overrideAccess: true,
    })
    for (const user of docs) {
      await payload.delete({
        collection: 'auth-accounts',
        where: { user: { equals: user.id } },
        overrideAccess: true,
      })
      await payload.delete({ collection: 'users', id: user.id, overrideAccess: true })
    }
    for (const org of [acme, ops, solo, unmanaged]) {
      await payload.delete({ collection: 'organizations', id: org.id, overrideAccess: true })
    }
    await issuer.close()
  })

  describe('allow-list', () => {
    it('refuses and does not provision a user outside the allowed groups', async () => {
      const res = await login(identity('outsider', { groups: ['contractors'] }))
      expect(res.status).toBe(303)
      expect(locationOf(res)).toBe('/login?error=group_not_allowed')
      expect(sessionCookieOf(res)).toBeUndefined()
      expect(await userByEmail(email('outsider'))).toBeNull()

      const { docs } = await payload.find({
        collection: 'audit-logs',
        where: { action: { equals: 'auth.sso_group_denied' } },
        sort: '-createdAt',
        limit: 1,
        overrideAccess: true,
      })
      expect(docs[0]?.metadata).toMatchObject({
        provider: 'oidc',
        email: email('outsider'),
        reason: 'group_not_allowed',
        groups: ['contractors'],
      })
    })

    it('refuses a token without the groups claim with its own error', async () => {
      const res = await login(identity('no-claim'))
      expect(locationOf(res)).toBe('/login?error=groups_missing')
      expect(await userByEmail(email('no-claim'))).toBeNull()
    })

    it('matches groups case-insensitively and lets allowed users in', async () => {
      const res = await login(identity('allowed', { groups: ['MARMOT-USERS'] }))
      expect(locationOf(res)).toBe('/')
      expect(sessionCookieOf(res)).toBeDefined()
      const user = await userByEmail(email('allowed'))
      expect(user).not.toBeNull()
      // Not in any mapped group: no membership.
      expect(user?.organizations ?? []).toHaveLength(0)
    })

    it('locks out an existing user who left the allowed groups', async () => {
      expect(locationOf(await login(identity('leaver', { groups: ['marmot-users'] })))).toBe('/')
      const res = await login(identity('leaver', { groups: ['alumni'] }))
      expect(locationOf(res)).toBe('/login?error=group_not_allowed')
      expect(sessionCookieOf(res)).toBeUndefined()
    })

    it('does not link an existing password account to a disallowed identity', async () => {
      const existing = await payload.create({
        collection: 'users',
        data: { email: email('linkme'), password: PASSWORD },
        overrideAccess: true,
      })
      const res = await login(identity('linkme', { groups: [] }))
      expect(locationOf(res)).toBe('/login?error=group_not_allowed')
      const { totalDocs } = await payload.count({
        collection: 'auth-accounts',
        where: { user: { equals: existing.id } },
        overrideAccess: true,
      })
      expect(totalDocs).toBe(0)
    })

    it('reads nested claims such as Keycloak realm roles', async () => {
      setEnv({ OIDC_GROUP_CLAIM: 'realm_access.roles' })
      const res = await login(
        identity('keycloak', { realm_access: { roles: ['offline_access', 'sre'] } }),
      )
      expect(locationOf(res)).toBe('/')
      expect(getUserRole(await userByEmail(email('keycloak')), acme.id)).toBe('member')
    })
  })

  describe('group to role mapping', () => {
    it('adds a new user to the mapped organization and promotes them on their next login', async () => {
      expect(locationOf(await login(identity('sre', { groups: ['sre'] })))).toBe('/')
      let user = await userByEmail(email('sre'))
      expect(getUserRole(user, acme.id)).toBe('member')
      expect(getUserRole(user, ops.id)).toBeNull()
      const added = await auditFor('member.added', user!.id)
      expect(added[0]).toMatchObject({
        actorType: 'system',
        actorRef: 'sso:oidc',
        after: { role: 'member' },
      })
      expect(String(added[0]?.organization)).toBe(String(acme.id))

      // Moved to platform-admins at the IdP: promoted in acme, added to ops.
      expect(locationOf(await login(identity('sre', { groups: ['platform-admins'] })))).toBe('/')
      user = await userByEmail(email('sre'))
      expect(getUserRole(user, acme.id)).toBe('admin')
      expect(getUserRole(user, ops.id)).toBe('viewer')
      const changed = await auditFor('member.role_changed', user!.id)
      expect(changed[0]).toMatchObject({
        before: { role: 'member' },
        after: { role: 'admin' },
        changedFields: ['role'],
      })
    })

    it('gives the highest role when several groups map to one organization', async () => {
      await login(identity('both', { groups: ['sre', 'Platform-Admins'] }))
      expect(getUserRole(await userByEmail(email('both')), acme.id)).toBe('admin')
    })

    it('demotes on login and keeps unmapped organizations untouched', async () => {
      await login(identity('demote', { groups: ['platform-admins'] }))
      const user = await userByEmail(email('demote'))
      await setRole(user!.id, unmanaged, 'admin')
      await login(identity('demote', { groups: ['sre'] }))
      const after = await userByEmail(email('demote'))
      expect(getUserRole(after, acme.id)).toBe('member')
      // Without OIDC_ROLE_MAPPING_REMOVE the ops membership stays.
      expect(getUserRole(after, ops.id)).toBe('viewer')
      expect(getUserRole(after, unmanaged.id)).toBe('admin')
    })

    it('removes memberships no group grants any more with OIDC_ROLE_MAPPING_REMOVE', async () => {
      await login(identity('remove', { groups: ['platform-admins'] }))
      const user = await userByEmail(email('remove'))
      await setRole(user!.id, unmanaged, 'member')

      setEnv({ OIDC_ROLE_MAPPING_REMOVE: 'true' })
      await login(identity('remove', { groups: ['sre'] }))
      const after = await userByEmail(email('remove'))
      expect(getUserRole(after, acme.id)).toBe('member')
      expect(getUserRole(after, ops.id)).toBeNull()
      expect(getUserRole(after, unmanaged.id)).toBe('member')
      const removed = await auditFor('member.removed', user!.id)
      expect(String(removed[0]?.organization)).toBe(String(ops.id))
      expect(removed[0]?.before).toEqual({ role: 'viewer' })
    })

    it('never demotes or removes the last owner, and audits the skipped change', async () => {
      setEnv({ OIDC_ROLE_MAPPING_REMOVE: 'true' })
      await login(identity('owner', { groups: ['solo-owners'] }))
      const owner = await userByEmail(email('owner'))
      expect(getUserRole(owner, solo.id)).toBe('owner')

      // Mapped down to member while being the only owner: kept.
      await login(identity('owner', { groups: ['solo-members'] }))
      expect(getUserRole(await userByEmail(email('owner')), solo.id)).toBe('owner')
      const skipped = await auditFor('member.sync_skipped', owner!.id)
      expect(skipped[0]).toMatchObject({
        before: { role: 'owner' },
        after: { role: 'member' },
        metadata: expect.objectContaining({ reason: 'last_owner' }),
      })

      // No group for the organization at all, with removal on: still kept.
      await login(identity('owner', { groups: ['marmot-users'] }))
      expect(getUserRole(await userByEmail(email('owner')), solo.id)).toBe('owner')
      expect((await auditFor('member.sync_skipped', owner!.id))[0]?.after).toEqual({ role: null })

      // Once somebody else owns the organization too, the mapping applies.
      await login(identity('co-owner', { groups: ['solo-owners'] }))
      expect(getUserRole(await userByEmail(email('co-owner')), solo.id)).toBe('owner')
      await login(identity('owner', { groups: ['solo-members'] }))
      expect(getUserRole(await userByEmail(email('owner')), solo.id)).toBe('member')
    })

    it('grants superadmin from a group and revokes it only with removal on', async () => {
      await login(identity('root-sso', { groups: ['marmot-admins'] }))
      const user = await userByEmail(email('root-sso'))
      expect(user?.superadmin).toBe(true)
      expect((await auditFor('user.superadmin_granted', user!.id)).length).toBe(1)

      await login(identity('root-sso', { groups: ['marmot-users'] }))
      expect((await userByEmail(email('root-sso')))?.superadmin).toBe(true)

      setEnv({ OIDC_ROLE_MAPPING_REMOVE: 'true' })
      await login(identity('root-sso', { groups: ['marmot-users'] }))
      expect((await userByEmail(email('root-sso')))?.superadmin).toBe(false)
      expect((await auditFor('user.superadmin_revoked', user!.id))[0]?.before).toEqual({
        superadmin: true,
      })
      expect(otherSuperadmin.superadmin).toBe(true)
    })

    it('leaves memberships alone when the provider sends no group claim', async () => {
      setEnv({ OIDC_ALLOWED_GROUPS: '', OIDC_ROLE_MAPPING_REMOVE: 'true' })
      await login(identity('quiet', { groups: ['sre'] }))
      expect(getUserRole(await userByEmail(email('quiet')), acme.id)).toBe('member')
      const res = await login(identity('quiet'))
      expect(locationOf(res)).toBe('/')
      expect(getUserRole(await userByEmail(email('quiet')), acme.id)).toBe('member')
    })
  })

  describe('SSO-only mode', () => {
    let member: User
    let root: User

    beforeAll(async () => {
      member = await payload.create({
        collection: 'users',
        data: { email: email('pw-member'), password: PASSWORD },
        overrideAccess: true,
      })
      root = await payload.create({
        collection: 'users',
        data: { email: email('pw-root'), password: PASSWORD, superadmin: true },
        overrideAccess: true,
      })
    })

    it('refuses password logins, sign-ups and the password form', async () => {
      setEnv({ OIDC_DISABLE_LOCAL_LOGIN: 'true' })
      const res = await passwordLogin(member.email)
      expect(res.status).toBe(403)
      expect(((await res.json()) as { errors: { message: string }[] }).errors[0].message).toMatch(
        /Password sign-in is turned off/,
      )
      expect((await passwordLogin(root.email)).status).toBe(403)
      expect((await passwordLogin(root.email, true)).status).toBe(403) // no break-glass configured
      expect((await restRequest('login', { email: member.email, password: PASSWORD })).status).toBe(
        403,
      )
      await expect(
        payload.login({ collection: 'users', data: { email: member.email, password: PASSWORD } }),
      ).rejects.toThrow(/turned off/)
      expect(await verifyPassword(payload, root.email, PASSWORD)).toBe(false)
      expect(await isSignupAllowed(payload)).toBe(false)
      expect(((await handleProviders().json()) as { local: boolean }).local).toBe(false)

      // Single sign-on is unaffected.
      expect(locationOf(await login(identity('sso-only', { groups: ['sre'] })))).toBe('/')
    })

    it('still signs in the administrator the setup wizard just created', async () => {
      setEnv({ OIDC_DISABLE_LOCAL_LOGIN: 'true' })
      const session = await createSetupSession(payload, { email: root.email, password: PASSWORD })
      expect(session.token).toBeTruthy()
    })

    it('refuses password resets', async () => {
      setEnv({ OIDC_DISABLE_LOCAL_LOGIN: 'true' })
      expect((await restRequest('forgot-password', { email: member.email })).status).toBe(403)
      expect((await restRequest('forgot-password', { email: root.email }, '?local=1')).status).toBe(
        403,
      )
      const token = await payload.forgotPassword({
        collection: 'users',
        data: { email: root.email },
        disableEmail: true,
      })
      const reset = await restRequest('reset-password', { token, password: 'new-password-1' })
      expect(reset.status).toBe(403)
    })

    it('lets a superadmin through with ?local=1 when break-glass is on, and audits it', async () => {
      setEnv({ OIDC_DISABLE_LOCAL_LOGIN: 'true', OIDC_BREAK_GLASS: 'true' })
      expect((await passwordLogin(root.email)).status).toBe(403)
      expect((await passwordLogin(member.email, true)).status).toBe(403)
      const res = await passwordLogin(root.email, true)
      expect(res.status).toBe(200)
      const events = await auditFor('auth.break_glass', root.id)
      expect(events[0]?.metadata).toMatchObject({ scope: 'instance' })
      expect(
        (await restRequest('login', { email: root.email, password: PASSWORD }, '?local=1')).status,
      ).toBe(200)
      expect(await verifyPassword(payload, root.email, PASSWORD)).toBe(true)
      expect(await verifyPassword(payload, member.email, PASSWORD)).toBe(false)
    })

    it('only resets superadmin passwords on the break-glass path, without revealing who they are', async () => {
      setEnv({ OIDC_DISABLE_LOCAL_LOGIN: 'true', OIDC_BREAK_GLASS: 'true' })
      expect((await restRequest('forgot-password', { email: member.email })).status).toBe(403)
      expect(
        (await restRequest('forgot-password', { email: member.email }, '?local=1')).status,
      ).toBe(200)

      const hook = (address: string) =>
        refusePasswordReset({
          args: { data: { email: address } },
          operation: 'forgotPassword',
          req: { payload, payloadAPI: 'REST', searchParams: new URLSearchParams('local=1') },
          context: {},
        } as never) as Promise<{ disableEmail?: boolean }>
      expect((await hook(member.email)).disableEmail).toBe(true)
      expect((await hook(root.email)).disableEmail).toBeUndefined()

      const memberToken = await payload.forgotPassword({
        collection: 'users',
        data: { email: member.email },
        disableEmail: true,
      })
      expect(
        (await restRequest('reset-password', { token: memberToken, password: 'new-password-1' }))
          .status,
      ).toBe(403)
      const rootToken = await payload.forgotPassword({
        collection: 'users',
        data: { email: root.email },
        disableEmail: true,
      })
      const reset = await restRequest('reset-password', { token: rootToken, password: PASSWORD })
      expect(reset.status).toBe(200)
    })

    it('restores everything when the mode is turned off', async () => {
      expect((await passwordLogin(member.email)).status).toBe(200)
      expect(((await handleProviders().json()) as { local: boolean }).local).toBe(true)
    })
  })
})
