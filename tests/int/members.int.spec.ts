import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'

import { addOrgMembership } from '@/access/memberships'
import { getUserRole } from '@/access/permissions'
import { DELETE as deleteAccount } from '@/app/api/account/route'
import { POST as changePassword } from '@/app/api/account/password/route'
import { POST as acceptInvite } from '@/app/api/invite/[code]/accept/route'
import {
  DELETE as deleteMember,
  PATCH as patchMember,
} from '@/app/api/orgs/[orgId]/members/[userId]/route'
import { POST as resendInvitation } from '@/app/api/orgs/[orgId]/invitations/[invitationId]/resend/route'
import { GET as slugAvailable } from '@/app/api/orgs/slug-available/route'
import type { Organization, User } from '@/payload-types'
import {
  acceptInviteCode,
  disableInviteLink,
  regenerateInviteLink,
  resolveInviteCode,
} from '@/server/invites'
import {
  changeMemberRole,
  countOwners,
  listOrgMembers,
  removeMember,
  soleOwnerships,
  transferOwnership,
} from '@/server/members'

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+${run}@members.test`
const PASSWORD = 'password-123'

type RequestUser = User & { collection: 'users' }

/** Fresh copy of the user (memberships included), tagged as a request user. */
async function as(user: { id: User['id'] }): Promise<RequestUser> {
  const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
  return { ...fresh, collection: 'users' }
}

const createUser = (name: string) =>
  payload.create({ collection: 'users', data: { email: email(name), password: PASSWORD, name } })

const createOrg = async (slug: string, creator: User) =>
  payload.create({
    collection: 'organizations',
    data: { name: slug, slug: `${slug}-${run}` },
    user: await as(creator),
    overrideAccess: false,
  })

const roleOf = async (user: User, org: Organization) => getUserRole(await as(user), org.id)

/** Builds a `Request` authenticated as `user` through a Payload JWT. */
async function authedRequest(user: User, method: string, body?: unknown): Promise<Request> {
  const { token } = await payload.login({
    collection: 'users',
    data: { email: user.email, password: PASSWORD },
  })
  return new Request('http://localhost/api/test', {
    method,
    headers: {
      Authorization: `JWT ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

const params = <T extends Record<string, string | number>>(values: T) => ({
  params: Promise.resolve(
    Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)])) as {
      [K in keyof T]: string
    },
  ),
})

let owner: User
let admin: User
let member: User
let viewer: User
let outsider: User
let org: Organization

describe('organization members', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    owner = await createUser('owner')
    admin = await createUser('admin')
    member = await createUser('member')
    viewer = await createUser('viewer')
    outsider = await createUser('outsider')
    org = await createOrg('members', owner)
    await addOrgMembership({ payload, userId: admin.id, orgId: org.id, role: 'admin' })
    await addOrgMembership({ payload, userId: member.id, orgId: org.id, role: 'member' })
    await addOrgMembership({ payload, userId: viewer.id, orgId: org.id, role: 'viewer' })
  })

  afterAll(async () => {
    await payload.delete({
      collection: 'organizations',
      where: { slug: { like: `-${run}` } },
      overrideAccess: true,
    })
    await payload.delete({
      collection: 'users',
      where: { email: { like: `+${run}@members.test` } },
    })
  })

  describe('listing', () => {
    it('finds members through users.organizations.organization, owners first', async () => {
      const members = await listOrgMembers(payload, org.id)
      expect(members.map((m) => m.email)).toEqual([
        owner.email,
        admin.email,
        member.email,
        viewer.email,
      ])
      expect(members[0].role).toBe('owner')
      expect(countOwners(members)).toBe(1)
    })

    it('works with the viewer’s own access control', async () => {
      const members = await listOrgMembers(payload, org.id, {
        user: await as(viewer),
        overrideAccess: false,
      })
      expect(members).toHaveLength(4)
    })
  })

  describe('changeMemberRole', () => {
    it('lets an admin manage members and viewers but not owners', async () => {
      const actor = await as(admin)
      const updated = await changeMemberRole({
        payload,
        actor,
        orgId: org.id,
        userId: viewer.id,
        role: 'member',
      })
      expect(updated.role).toBe('member')
      expect(await roleOf(viewer, org)).toBe('member')

      // back to viewer for later tests
      await changeMemberRole({ payload, actor, orgId: org.id, userId: viewer.id, role: 'viewer' })

      await expect(
        changeMemberRole({ payload, actor, orgId: org.id, userId: owner.id, role: 'admin' }),
      ).rejects.toMatchObject({ status: 403 })
      await expect(
        changeMemberRole({ payload, actor, orgId: org.id, userId: member.id, role: 'owner' }),
      ).rejects.toMatchObject({ status: 403 })
    })

    it('rejects members, viewers, outsiders and invalid roles', async () => {
      for (const u of [member, viewer, outsider]) {
        await expect(
          changeMemberRole({
            payload,
            actor: await as(u),
            orgId: org.id,
            userId: viewer.id,
            role: 'admin',
          }),
        ).rejects.toMatchObject({ status: 403 })
      }
      await expect(
        changeMemberRole({
          payload,
          actor: await as(owner),
          orgId: org.id,
          userId: viewer.id,
          role: 'king',
        }),
      ).rejects.toMatchObject({ status: 400 })
      await expect(
        changeMemberRole({
          payload,
          actor: await as(owner),
          orgId: org.id,
          userId: outsider.id,
          role: 'viewer',
        }),
      ).rejects.toMatchObject({ status: 404 })
    })

    it('protects the last owner, even from themselves', async () => {
      await expect(
        changeMemberRole({
          payload,
          actor: await as(owner),
          orgId: org.id,
          userId: owner.id,
          role: 'admin',
        }),
      ).rejects.toMatchObject({ status: 409 })
      expect(await roleOf(owner, org)).toBe('owner')
    })

    it('allows demoting an owner once another owner exists', async () => {
      const actor = await as(owner)
      await changeMemberRole({ payload, actor, orgId: org.id, userId: admin.id, role: 'owner' })
      expect(await roleOf(admin, org)).toBe('owner')

      await changeMemberRole({ payload, actor, orgId: org.id, userId: owner.id, role: 'admin' })
      expect(await roleOf(owner, org)).toBe('admin')

      // restore: admin (now sole owner) gives ownership back and becomes admin again
      const newOwner = await as(admin)
      await changeMemberRole({
        payload,
        actor: newOwner,
        orgId: org.id,
        userId: owner.id,
        role: 'owner',
      })
      await changeMemberRole({
        payload,
        actor: await as(owner),
        orgId: org.id,
        userId: admin.id,
        role: 'admin',
      })
      expect(await roleOf(owner, org)).toBe('owner')
      expect(await roleOf(admin, org)).toBe('admin')
    })
  })

  describe('removeMember', () => {
    it('refuses members removing others but lets anyone leave', async () => {
      await expect(
        removeMember({ payload, actor: await as(member), orgId: org.id, userId: viewer.id }),
      ).rejects.toMatchObject({ status: 403 })

      const leaver = await createUser('leaver')
      await addOrgMembership({ payload, userId: leaver.id, orgId: org.id, role: 'member' })
      const result = await removeMember({
        payload,
        actor: await as(leaver),
        orgId: org.id,
        userId: leaver.id,
      })
      expect(result).toEqual({ removed: leaver.id, self: true })
      expect(await roleOf(leaver, org)).toBeNull()
    })

    it('never removes the last owner', async () => {
      await expect(
        removeMember({ payload, actor: await as(owner), orgId: org.id, userId: owner.id }),
      ).rejects.toMatchObject({ status: 409 })
      await expect(
        removeMember({ payload, actor: await as(admin), orgId: org.id, userId: owner.id }),
      ).rejects.toMatchObject({ status: 403 })
      expect(await roleOf(owner, org)).toBe('owner')
    })

    it('lets admins remove lower ranked members', async () => {
      const victim = await createUser('victim')
      await addOrgMembership({ payload, userId: victim.id, orgId: org.id, role: 'viewer' })
      await removeMember({ payload, actor: await as(admin), orgId: org.id, userId: victim.id })
      expect(await roleOf(victim, org)).toBeNull()
    })
  })

  describe('transferOwnership', () => {
    it('is owner-only and demotes the previous owner to admin', async () => {
      await expect(
        transferOwnership({ payload, actor: await as(admin), orgId: org.id, userId: member.id }),
      ).rejects.toMatchObject({ status: 403 })

      await transferOwnership({ payload, actor: await as(owner), orgId: org.id, userId: admin.id })
      expect(await roleOf(admin, org)).toBe('owner')
      expect(await roleOf(owner, org)).toBe('admin')

      await transferOwnership({ payload, actor: await as(admin), orgId: org.id, userId: owner.id })
      expect(await roleOf(owner, org)).toBe('owner')
      expect(await roleOf(admin, org)).toBe('admin')
    })

    it('reports organizations a user solely owns', async () => {
      const solo = await soleOwnerships(payload, await as(owner))
      expect(solo.map((o) => o.slug)).toContain(org.slug)
      expect(await soleOwnerships(payload, await as(admin))).toEqual([])
    })
  })

  describe('invite links', () => {
    it('hides the token from members without member:invite', async () => {
      await regenerateInviteLink({ payload, actor: await as(owner), orgId: org.id, role: 'viewer' })
      const asViewer = await payload.findByID({
        collection: 'organizations',
        id: org.id,
        user: await as(viewer),
        overrideAccess: false,
        depth: 0,
      })
      expect(asViewer.inviteLinkToken).toBeUndefined()
      const asAdmin = await payload.findByID({
        collection: 'organizations',
        id: org.id,
        user: await as(admin),
        overrideAccess: false,
        depth: 0,
      })
      expect(asAdmin.inviteLinkToken).toHaveLength(32)
      expect(asAdmin.inviteLinkRole).toBe('viewer')
    })

    it('refuses roles above the actor and non-inviters', async () => {
      await expect(
        regenerateInviteLink({ payload, actor: await as(admin), orgId: org.id, role: 'owner' }),
      ).rejects.toMatchObject({ status: 403 })
      await expect(
        regenerateInviteLink({ payload, actor: await as(member), orgId: org.id }),
      ).rejects.toMatchObject({ status: 403 })
    })

    it('resolves, accepts and can be disabled', async () => {
      const { url, role } = await regenerateInviteLink({
        payload,
        actor: await as(admin),
        orgId: org.id,
        role: 'member',
      })
      expect(role).toBe('member')
      const code = url.split('/invite/')[1]
      const resolved = await resolveInviteCode(payload, code)
      expect(resolved).toMatchObject({ kind: 'link', role: 'member', organization: { id: org.id } })

      const joiner = await createUser('link-joiner')
      const result = await acceptInviteCode({ payload, code, user: joiner })
      expect(result).toEqual({
        organization: { id: org.id, slug: org.slug, name: org.name },
        role: 'member',
      })
      expect(await roleOf(joiner, org)).toBe('member')

      await disableInviteLink({ payload, actor: await as(admin), orgId: org.id })
      expect(await resolveInviteCode(payload, code)).toBeNull()
      expect(await resolveInviteCode(payload, 'nope')).toBeNull()
    })

    it('resolves personal invitation tokens too', async () => {
      const invitee = await createUser('invitee')
      const invitation = await payload.create({
        collection: 'invitations',
        data: { organization: org.id, email: invitee.email, role: 'viewer' },
        user: await as(owner),
        overrideAccess: false,
        depth: 0,
      })
      const resolved = await resolveInviteCode(payload, invitation.token!)
      expect(resolved).toMatchObject({
        kind: 'invitation',
        status: 'pending',
        email: invitee.email,
        role: 'viewer',
      })
      const result = await acceptInviteCode({ payload, code: invitation.token!, user: invitee })
      expect(result.role).toBe('viewer')
      expect(await resolveInviteCode(payload, invitation.token!)).toMatchObject({
        status: 'accepted',
      })
    })
  })

  describe('route handlers', () => {
    it('require authentication', async () => {
      const res = await patchMember(
        new Request('http://localhost/x', { method: 'PATCH', body: '{}' }),
        params({ orgId: org.id, userId: viewer.id }),
      )
      expect(res.status).toBe(401)
    })

    it('PATCH /api/orgs/:orgId/members/:userId changes the role with the caller’s rights', async () => {
      const ok = await patchMember(
        await authedRequest(admin, 'PATCH', { role: 'member' }),
        params({ orgId: org.id, userId: viewer.id }),
      )
      expect(ok.status).toBe(200)
      expect(await ok.json()).toMatchObject({ member: { id: viewer.id, role: 'member' } })

      const forbidden = await patchMember(
        await authedRequest(member, 'PATCH', { role: 'viewer' }),
        params({ orgId: org.id, userId: viewer.id }),
      )
      expect(forbidden.status).toBe(403)

      const lastOwner = await patchMember(
        await authedRequest(owner, 'PATCH', { role: 'admin' }),
        params({ orgId: org.id, userId: owner.id }),
      )
      expect(lastOwner.status).toBe(409)
    })

    it('DELETE /api/orgs/:orgId/members/:userId removes and protects', async () => {
      const temp = await createUser('temp')
      await addOrgMembership({ payload, userId: temp.id, orgId: org.id, role: 'viewer' })
      const res = await deleteMember(
        await authedRequest(admin, 'DELETE'),
        params({ orgId: org.id, userId: temp.id }),
      )
      expect(res.status).toBe(200)
      expect(await roleOf(temp, org)).toBeNull()

      const res2 = await deleteMember(
        await authedRequest(owner, 'DELETE'),
        params({ orgId: org.id, userId: owner.id }),
      )
      expect(res2.status).toBe(409)
    })

    it('GET /api/orgs/slug-available validates reserved, taken and free slugs', async () => {
      const check = async (slug: string) =>
        (await slugAvailable(
          new Request(`http://localhost/api/orgs/slug-available?slug=${slug}`),
        ).then((r) => r.json())) as { available: boolean; reason?: string }

      expect(await check('admin')).toMatchObject({ available: false })
      expect(await check(org.slug)).toMatchObject({ available: false, reason: /taken/i })
      expect(await check(`free-${run}`)).toEqual({ available: true, slug: `free-${run}` })
      expect(await check('Has Spaces')).toMatchObject({ available: false })
    })

    it('POST /api/invite/:code/accept joins through a link token', async () => {
      const { url } = await regenerateInviteLink({ payload, actor: await as(owner), orgId: org.id })
      const code = url.split('/invite/')[1]
      const res = await acceptInvite(await authedRequest(outsider, 'POST'), params({ code }))
      expect(res.status).toBe(200)
      expect(await roleOf(outsider, org)).toBe('member')
      // Leave again so later assertions about outsiders hold.
      await removeMember({ payload, actor: await as(outsider), orgId: org.id, userId: outsider.id })

      const bad = await acceptInvite(
        await authedRequest(outsider, 'POST'),
        params({ code: 'definitely-not-a-token' }),
      )
      expect(bad.status).toBe(404)
    })

    it('POST …/invitations/:id/resend extends pending invitations only', async () => {
      const invitation = await payload.create({
        collection: 'invitations',
        data: { organization: org.id, email: email('resend'), role: 'member' },
        user: await as(owner),
        overrideAccess: false,
        depth: 0,
      })
      const before = new Date(invitation.expiresAt!).getTime()
      await new Promise((r) => setTimeout(r, 5))
      const res = await resendInvitation(
        await authedRequest(admin, 'POST'),
        params({ orgId: org.id, invitationId: invitation.id }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { expiresAt: string }
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(before)

      await payload.update({
        collection: 'invitations',
        id: invitation.id,
        data: { status: 'revoked' },
        user: await as(admin),
        overrideAccess: false,
      })
      const gone = await resendInvitation(
        await authedRequest(admin, 'POST'),
        params({ orgId: org.id, invitationId: invitation.id }),
      )
      expect(gone.status).toBe(409)

      const forbidden = await resendInvitation(
        await authedRequest(member, 'POST'),
        params({ orgId: org.id, invitationId: invitation.id }),
      )
      expect([403, 404]).toContain(forbidden.status)
    })

    it('POST /api/account/password re-authenticates before changing', async () => {
      const wrong = await changePassword(
        await authedRequest(member, 'POST', {
          currentPassword: 'nope',
          password: 'new-password-1',
        }),
      )
      expect(wrong.status).toBe(401)

      const short = await changePassword(
        await authedRequest(member, 'POST', { currentPassword: PASSWORD, password: 'short' }),
      )
      expect(short.status).toBe(400)

      const ok = await changePassword(
        await authedRequest(member, 'POST', {
          currentPassword: PASSWORD,
          password: 'new-password-1',
        }),
      )
      expect(ok.status).toBe(200)
      await expect(
        payload.login({
          collection: 'users',
          data: { email: member.email, password: 'new-password-1' },
        }),
      ).resolves.toMatchObject({ user: { id: member.id } })
      // restore for the remaining tests
      await payload.update({
        collection: 'users',
        id: member.id,
        data: { password: PASSWORD },
        overrideAccess: true,
      })
    })

    it('DELETE /api/account refuses sole owners and otherwise deletes the user', async () => {
      const blocked = await deleteAccount(
        await authedRequest(owner, 'DELETE', { confirm: owner.email }),
      )
      expect(blocked.status).toBe(409)

      const doomed = await createUser('doomed')
      const typo = await deleteAccount(await authedRequest(doomed, 'DELETE', { confirm: 'x' }))
      expect(typo.status).toBe(400)
      const res = await deleteAccount(
        await authedRequest(doomed, 'DELETE', { confirm: doomed.email }),
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('set-cookie')).toMatch(/payload-token=;/)
      await expect(payload.findByID({ collection: 'users', id: doomed.id })).rejects.toThrow()
    })
  })

  describe('deleting an organization', () => {
    it('removes pending invitations and memberships first', async () => {
      const throwaway = await createOrg('throwaway', owner)
      await addOrgMembership({ payload, userId: viewer.id, orgId: throwaway.id, role: 'viewer' })
      const invitation = await payload.create({
        collection: 'invitations',
        data: { organization: throwaway.id, email: email('pending'), role: 'member' },
        user: await as(owner),
        overrideAccess: false,
        depth: 0,
      })

      await payload.delete({
        collection: 'organizations',
        id: throwaway.id,
        user: await as(owner),
        overrideAccess: false,
      })

      await expect(
        payload.findByID({ collection: 'invitations', id: invitation.id }),
      ).rejects.toThrow()
      expect(await roleOf(viewer, throwaway)).toBeNull()
      expect(await roleOf(owner, throwaway)).toBeNull()
    })
  })
})
