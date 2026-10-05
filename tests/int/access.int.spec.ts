import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'

import { can, getUserOrgIds, getUserRole, type Role } from '@/access/permissions'
import { acceptInvitation } from '@/collections/Invitations'
import { canSignUp } from '@/collections/Users'
import { env } from '@/env'
import type { Invitation, Organization, User } from '@/payload-types'

let payload: Payload

/** Unique per run so tests can share a database with other runs. */
const run = Date.now().toString(36)
const email = (name: string) => `${name}+${run}@marmot.test`

type RequestUser = User & { collection: 'users' }

/** Re-reads the user so memberships written by hooks are visible, and tags it as a request user. */
async function as(user: { id: User['id'] }): Promise<RequestUser> {
  const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
  return { ...fresh, collection: 'users' }
}

async function createUser(name: string, superadmin = false): Promise<User> {
  return payload.create({
    collection: 'users',
    data: { email: email(name), password: 'password-123', name, superadmin },
  })
}

async function addMembership(user: User, org: Organization, role: Role): Promise<void> {
  const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
  const rows = (fresh.organizations ?? []).map((row) => ({
    id: row.id,
    organization: typeof row.organization === 'object' ? row.organization.id : row.organization,
    role: row.role,
  }))
  await payload.update({
    collection: 'users',
    id: user.id,
    data: { organizations: [...rows, { organization: org.id, role }] },
    depth: 0,
  })
}

/** `payload.find` with the user's own access. */
async function findAs<T extends 'organizations' | 'invitations'>(
  collection: T,
  user: RequestUser,
  where: Record<string, unknown> = {},
) {
  const result = await payload.find({
    collection,
    where: where as never,
    user,
    overrideAccess: false,
    disableErrors: true, // return no documents instead of throwing Forbidden
    depth: 0,
    limit: 100,
  })
  return result.docs
}

let superadmin: User
let owner: User
let admin: User
let member: User
let viewer: User
let outsider: User
let newbie: User
let org: Organization
let otherOrg: Organization

describe('organization RBAC', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })

    superadmin = await createUser('superadmin', true)
    owner = await createUser('owner')
    admin = await createUser('admin')
    member = await createUser('member')
    viewer = await createUser('viewer')
    outsider = await createUser('outsider')
    newbie = await createUser('newbie')

    org = await payload.create({
      collection: 'organizations',
      data: { name: 'Acme', slug: `Acme-${run}` },
      user: await as(owner),
      overrideAccess: false,
    })
    otherOrg = await payload.create({
      collection: 'organizations',
      data: { name: 'Other', slug: `other-${run}` },
      user: await as(outsider),
      overrideAccess: false,
    })

    await addMembership(admin, org, 'admin')
    await addMembership(member, org, 'member')
    await addMembership(viewer, org, 'viewer')
  })

  afterAll(async () => {
    const orgIds = [org?.id, otherOrg?.id].filter(Boolean)
    if (orgIds.length) {
      await payload.delete({ collection: 'invitations', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
    }
    await payload.delete({ collection: 'users', where: { email: { like: `+${run}@marmot.test` } } })
  })

  describe('permissions helpers', () => {
    it('orders roles owner > admin > member > viewer', () => {
      const u = (role: Role) => ({ id: 1, organizations: [{ organization: 1, role }] })
      expect(can(u('owner'), 1, 'organization:delete')).toBe(true)
      expect(can(u('admin'), 1, 'organization:delete')).toBe(false)
      expect(can(u('admin'), 1, 'member:invite')).toBe(true)
      expect(can(u('member'), 1, 'member:invite')).toBe(false)
      expect(can(u('member'), 1, 'monitor:create')).toBe(true)
      expect(can(u('viewer'), 1, 'monitor:create')).toBe(false)
      expect(can(u('viewer'), 1, 'monitor:read')).toBe(true)
      expect(can(u('viewer'), 2, 'monitor:read')).toBe(false)
      expect(can({ id: 9, superadmin: true }, 2, 'organization:delete')).toBe(true)
      expect(getUserOrgIds(u('viewer'))).toEqual([1])
      expect(getUserRole(u('viewer'), 1)).toBe('viewer')
      expect(getUserRole(u('viewer'), 2)).toBeNull()
    })
  })

  describe('organizations', () => {
    it('makes the creator an owner and normalises the slug', async () => {
      expect(org.slug).toBe(`acme-${run}`)
      const fresh = await as(owner)
      expect(getUserRole(fresh, org.id)).toBe('owner')
      expect(getUserRole(await as(outsider), otherOrg.id)).toBe('owner')
      expect(getUserRole(fresh, otherOrg.id)).toBeNull()
    })

    it('rejects reserved and malformed slugs', async () => {
      const user = await as(owner)
      await expect(
        payload.create({
          collection: 'organizations',
          data: { name: 'Nope', slug: 'admin' },
          user,
          overrideAccess: false,
        }),
      ).rejects.toThrow()
      await expect(
        payload.create({
          collection: 'organizations',
          data: { name: 'Nope', slug: 'has spaces' },
          user,
          overrideAccess: false,
        }),
      ).rejects.toThrow()
    })

    it('is readable by every member and invisible to outsiders', async () => {
      for (const u of [owner, admin, member, viewer]) {
        const docs = await findAs('organizations', await as(u))
        expect(docs.map((d) => d.id)).toEqual([org.id])
      }
      const docs = await findAs('organizations', await as(outsider))
      expect(docs.map((d) => d.id)).toEqual([otherOrg.id])
      await expect(
        payload.findByID({
          collection: 'organizations',
          id: org.id,
          user: await as(outsider),
          overrideAccess: false,
        }),
      ).rejects.toThrow()
    })

    it('allows owner and admin to update, not member or viewer', async () => {
      for (const u of [owner, admin]) {
        const updated = await payload.update({
          collection: 'organizations',
          id: org.id,
          data: { name: `Acme by ${u.name}` },
          user: await as(u),
          overrideAccess: false,
        })
        expect(updated.name).toBe(`Acme by ${u.name}`)
      }
      for (const u of [member, viewer, outsider]) {
        await expect(
          payload.update({
            collection: 'organizations',
            id: org.id,
            data: { name: 'Hijacked' },
            user: await as(u),
            overrideAccess: false,
          }),
        ).rejects.toThrow()
      }
    })

    it('only lets owners delete', async () => {
      const throwaway = await payload.create({
        collection: 'organizations',
        data: { name: 'Throwaway', slug: `throwaway-${run}` },
        user: await as(owner),
        overrideAccess: false,
      })
      await addMembership(admin, throwaway, 'admin')

      await expect(
        payload.delete({
          collection: 'organizations',
          id: throwaway.id,
          user: await as(admin),
          overrideAccess: false,
        }),
      ).rejects.toThrow()

      const deleted = await payload.delete({
        collection: 'organizations',
        id: throwaway.id,
        user: await as(owner),
        overrideAccess: false,
      })
      expect(deleted.id).toBe(throwaway.id)
    })

    it('does not let members edit their own memberships or superadmin flag', async () => {
      const user = await as(member)
      await payload.update({
        collection: 'users',
        id: member.id,
        data: {
          name: 'Still a member',
          superadmin: true,
          organizations: [{ organization: org.id, role: 'owner' }],
        },
        user,
        overrideAccess: false,
      })
      const fresh = await as(member)
      expect(fresh.name).toBe('Still a member')
      expect(fresh.superadmin).toBe(false)
      expect(getUserRole(fresh, org.id)).toBe('member')
    })
  })

  describe('signup (anonymous user creation)', () => {
    it('lets anonymous visitors create an account while DISABLE_SIGNUP is false, without privileges', async () => {
      expect(env.DISABLE_SIGNUP).toBe(false)

      const created = await payload.create({
        collection: 'users',
        data: {
          email: email('signup'),
          password: 'password-123',
          name: 'Signup',
          superadmin: true,
          organizations: [{ organization: org.id, role: 'owner' }],
        },
        overrideAccess: false,
        depth: 0,
      })
      const fresh = await as(created)
      expect(fresh.superadmin).toBe(false)
      expect(getUserOrgIds(fresh)).toEqual([])
      expect(payload.collections.users.config.access.create).toBeDefined()
    })

    it('refuses anonymous and non-superadmin creation when DISABLE_SIGNUP is true', () => {
      expect(canSignUp(null, true)).toBe(false)
      expect(canSignUp({ id: 1, superadmin: false }, true)).toBe(false)
      expect(canSignUp({ id: 1, superadmin: true }, true)).toBe(true)
      expect(canSignUp(null, false)).toBe(true)
    })
  })

  describe('invitations (member:invite → admin)', () => {
    const invite = (u: RequestUser, data: Partial<Invitation> = {}) =>
      payload.create({
        collection: 'invitations',
        data: {
          organization: org.id,
          email: email(`invitee-${u.name}`),
          role: 'member',
          ...data,
        },
        user: u,
        overrideAccess: false,
        depth: 0,
      })

    it('lets owner and admin create, with a server-minted token and inviter', async () => {
      for (const u of [owner, admin]) {
        const created = await invite(await as(u), { token: 'client-supplied' })
        expect(created.token).not.toBe('client-supplied')
        expect(created.token).toHaveLength(32)
        expect(created.status).toBe('pending')
        expect(created.invitedBy).toBe(u.id)
        expect(new Date(created.expiresAt!).getTime()).toBeGreaterThan(Date.now())
      }
    })

    it('forbids member, viewer and outsiders', async () => {
      for (const u of [member, viewer, outsider]) {
        await expect(invite(await as(u))).rejects.toThrow()
      }
    })

    it('does not let an admin invite an owner', async () => {
      await expect(invite(await as(admin), { role: 'owner' })).rejects.toThrow()
      const byOwner = await invite(await as(owner), { role: 'owner' })
      expect(byOwner.role).toBe('owner')
    })

    it('is listable by owner and admin only', async () => {
      const seen = await findAs('invitations', await as(admin), {
        organization: { equals: org.id },
      })
      expect(seen.length).toBeGreaterThanOrEqual(3)
      expect(seen.every((i) => i.organization === org.id)).toBe(true)

      for (const u of [member, viewer, outsider]) {
        expect(await findAs('invitations', await as(u))).toEqual([])
      }
    })

    it('lets admins delete and forbids members', async () => {
      const created = await invite(await as(admin), { email: email('to-delete') })
      await expect(
        payload.delete({
          collection: 'invitations',
          id: created.id,
          user: await as(member),
          overrideAccess: false,
        }),
      ).rejects.toThrow()
      const deleted = await payload.delete({
        collection: 'invitations',
        id: created.id,
        user: await as(admin),
        overrideAccess: false,
      })
      expect(deleted.id).toBe(created.id)
    })
  })

  describe('superadmin bypass', () => {
    it('reads, updates and invites in organizations it is not a member of', async () => {
      const su = await as(superadmin)
      expect(getUserOrgIds(su)).toEqual([])

      const orgs = await findAs('organizations', su, { id: { in: [org.id, otherOrg.id] } })
      expect(orgs.map((o) => o.id).sort()).toEqual([org.id, otherOrg.id].sort())

      const updated = await payload.update({
        collection: 'organizations',
        id: otherOrg.id,
        data: { plan: 'team' },
        user: su,
        overrideAccess: false,
      })
      expect(updated.plan).toBe('team')

      const created = await payload.create({
        collection: 'invitations',
        data: { organization: otherOrg.id, email: email('su-invitee'), role: 'owner' },
        user: su,
        overrideAccess: false,
        depth: 0,
      })
      expect(created.status).toBe('pending')
      const seen = await findAs('invitations', su, { organization: { equals: otherOrg.id } })
      expect(seen.map((i) => i.id)).toContain(created.id)
    })
  })

  describe('accepting an invitation', () => {
    it('attaches the user with the invited role and marks it accepted', async () => {
      const invitation = await payload.create({
        collection: 'invitations',
        data: { organization: org.id, email: newbie.email, role: 'member' },
        user: await as(owner),
        overrideAccess: false,
        depth: 0,
      })
      expect(getUserRole(await as(newbie), org.id)).toBeNull()

      const result = await acceptInvitation({ payload, token: invitation.token!, user: newbie })
      expect(result).toEqual({ invitation: invitation.id, organization: org.id, role: 'member' })

      const fresh = await as(newbie)
      expect(getUserRole(fresh, org.id)).toBe('member')
      expect(can(fresh, org.id, 'monitor:create')).toBe(true)
      expect(can(fresh, org.id, 'member:invite')).toBe(false)

      const stored = await payload.findByID({ collection: 'invitations', id: invitation.id })
      expect(stored.status).toBe('accepted')

      await expect(
        acceptInvitation({ payload, token: invitation.token!, user: newbie }),
      ).rejects.toMatchObject({ status: 410 })
    })

    it('keeps an existing membership role when accepted again for the same organization', async () => {
      const invitation = await payload.create({
        collection: 'invitations',
        data: { organization: org.id, email: newbie.email, role: 'viewer' },
        user: await as(owner),
        overrideAccess: false,
        depth: 0,
      })
      const result = await acceptInvitation({ payload, token: invitation.token!, user: newbie })
      expect(result.role).toBe('member')
      expect(getUserRole(await as(newbie), org.id)).toBe('member')
    })

    it('rejects unknown and expired tokens', async () => {
      await expect(
        acceptInvitation({ payload, token: 'does-not-exist', user: newbie }),
      ).rejects.toMatchObject({ status: 404 })

      const invitation = await payload.create({
        collection: 'invitations',
        data: { organization: otherOrg.id, email: newbie.email, role: 'member' },
        user: await as(outsider),
        overrideAccess: false,
        depth: 0,
      })
      await payload.update({
        collection: 'invitations',
        id: invitation.id,
        data: { expiresAt: new Date(Date.now() - 1000).toISOString() },
      })
      await expect(
        acceptInvitation({ payload, token: invitation.token!, user: newbie }),
      ).rejects.toMatchObject({ status: 410 })
      const stored = await payload.findByID({ collection: 'invitations', id: invitation.id })
      expect(stored.status).toBe('expired')
      expect(getUserRole(await as(newbie), otherOrg.id)).toBeNull()
    })
  })
})
