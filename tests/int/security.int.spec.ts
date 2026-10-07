import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'

import { addOrgMembership } from '@/access/memberships'
import { POST as restPost } from '@/app/(payload)/api/[...slug]/route'
import { PATCH as patchMember } from '@/app/api/orgs/[orgId]/members/[userId]/route'
import { acceptInvitation } from '@/collections/Invitations'
import { Users } from '@/collections/Users'
import { env } from '@/env'
import type { AuditLog, Organization, User } from '@/payload-types'
import { AUDIT_LOG_KEEP_DAYS, runRetention } from '@/server/jobs/retention'
import { recordAuditEvent } from '@/server/security/audit'
import { LOGIN_RATE_LIMIT } from '@/server/security/auth-hooks'
import { closeRateLimitStore } from '@/server/security/rate-limit'

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+${run}@security.test`
const PASSWORD = 'password-123'

type RequestUser = User & { collection: 'users' }

async function as(user: { id: User['id'] }): Promise<RequestUser> {
  const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
  return { ...fresh, collection: 'users' }
}

const createUser = (name: string, superadmin = false) =>
  payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name, superadmin },
  })

async function auditRows(where: Record<string, unknown>, user?: RequestUser): Promise<AuditLog[]> {
  const { docs } = await payload.find({
    collection: 'audit-logs',
    where: where as never,
    sort: '-createdAt',
    depth: 0,
    limit: 100,
    ...(user ? { user, overrideAccess: false, disableErrors: true } : {}),
  })
  return docs
}

/** `POST /api/users/<path>` through Payload's REST handler, as a browser on the app origin would. */
async function restLogin(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const request = new Request(`${env.NEXT_PUBLIC_SERVER_URL}/api/users/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: env.NEXT_PUBLIC_SERVER_URL,
      ...headers,
    },
    body: JSON.stringify(body),
  })
  return restPost(request, { params: Promise.resolve({ slug: ['users', 'login'] }) })
}

let superadmin: User
let owner: User
let admin: User
let member: User
let org: Organization

describe('security hardening', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    superadmin = await createUser('superadmin', true)
    owner = await createUser('owner')
    admin = await createUser('admin')
    member = await createUser('member')
    org = await payload.create({
      collection: 'organizations',
      data: { name: 'Sec', slug: `sec-${run}` },
      user: await as(owner),
      overrideAccess: false,
    })
    await addOrgMembership({ payload, userId: admin.id, orgId: org.id, role: 'admin' })
    await addOrgMembership({ payload, userId: member.id, orgId: org.id, role: 'member' })
  })

  afterAll(async () => {
    await closeRateLimitStore()
    await payload.delete({ collection: 'organizations', where: { id: { equals: org.id } } })
    await payload.delete({
      collection: 'users',
      where: { email: { in: [superadmin, owner, admin, member].map((u) => u.email) } },
    })
    await payload.delete({ collection: 'audit-logs', where: { ip: { equals: `test-${run}` } } })
  })

  describe('admin panel access', () => {
    const adminAccess = Users.access!.admin!

    it('is granted to superadmins only', async () => {
      expect(await adminAccess({ req: { user: await as(superadmin) } } as never)).toBe(true)
      expect(await adminAccess({ req: { user: await as(owner) } } as never)).toBe(false)
      expect(await adminAccess({ req: { user: null } } as never)).toBe(false)
    })
  })

  describe('audit log', () => {
    it('records events and scopes reads to organization admins', async () => {
      await recordAuditEvent(payload, {
        action: 'member.role_changed',
        actor: owner.id,
        organization: org.id,
        target: `users:${String(member.id)}`,
        ip: `test-${run}`,
        metadata: { role: 'viewer' },
      })
      await recordAuditEvent(payload, {
        action: 'auth.login_failed',
        organization: null,
        ip: `test-${run}`,
        metadata: { email: 'nobody@example.test' },
      })

      const where = { ip: { equals: `test-${run}` } }
      expect((await auditRows(where)).map((r) => r.action).sort()).toEqual([
        'auth.login_failed',
        'member.role_changed',
      ])

      // Org admins see their organization's rows but not instance-level ones.
      const asAdmin = (await auditRows(where, await as(admin))).map((r) => r.action)
      expect(asAdmin).toEqual(['member.role_changed'])
      expect((await auditRows(where, await as(owner))).map((r) => r.action)).toEqual([
        'member.role_changed',
      ])
      // Members see nothing; superadmins see everything.
      expect(await auditRows(where, await as(member))).toEqual([])
      expect((await auditRows(where, await as(superadmin))).length).toBe(2)
    })

    it('refuses client writes', async () => {
      await expect(
        payload.create({
          collection: 'audit-logs',
          data: { action: 'auth.login', organization: org.id },
          user: await as(owner),
          overrideAccess: false,
        }),
      ).rejects.toThrow()
      const [row] = await auditRows({ ip: { equals: `test-${run}` } })
      await expect(
        payload.delete({
          collection: 'audit-logs',
          id: row!.id,
          user: await as(superadmin),
          overrideAccess: false,
        }),
      ).rejects.toThrow()
    })

    it('is written by membership, invitation and organization changes', async () => {
      const token = await payload.login({
        collection: 'users',
        data: { email: owner.email, password: PASSWORD },
      })
      const request = new Request(`${env.NEXT_PUBLIC_SERVER_URL}/api/test`, {
        method: 'PATCH',
        headers: {
          Authorization: `JWT ${token.token}`,
          'Content-Type': 'application/json',
          'User-Agent': `vitest/${run}`,
        },
        body: JSON.stringify({ role: 'viewer' }),
      })
      const res = await patchMember(request, {
        params: Promise.resolve({ orgId: String(org.id), userId: String(member.id) }),
      })
      expect(res.status).toBe(200)

      const invitation = await payload.create({
        collection: 'invitations',
        data: { organization: org.id, email: email('invitee'), role: 'member' },
        user: await as(owner),
        overrideAccess: false,
        context: { skipInvitationEmail: true },
      })
      const invitee = await createUser('invitee')
      await acceptInvitation({ payload, token: invitation.token!, user: invitee })

      await payload.update({
        collection: 'organizations',
        id: org.id,
        data: { name: 'Sec renamed' },
        user: await as(owner),
        overrideAccess: false,
      })

      // Logins are instance-level rows (no organization) tied to the actor.
      const logins = await auditRows({
        and: [{ action: { equals: 'auth.login' } }, { actor: { equals: owner.id } }],
      })
      expect(logins.length).toBeGreaterThanOrEqual(1)
      expect(logins[0]).toMatchObject({ target: `users:${String(owner.id)}`, organization: null })

      const rows = await auditRows({ organization: { equals: org.id } })
      const actions = rows.map((r) => r.action)
      expect(actions).toContain('member.role_changed')
      expect(actions).toContain('invitation.created')
      expect(actions).toContain('invitation.accepted')
      expect(actions).toContain('organization.updated')

      const roleChange = rows.find((r) => r.action === 'member.role_changed' && r.userAgent)
      expect(roleChange).toMatchObject({
        actor: owner.id,
        target: `users:${String(member.id)}`,
        userAgent: `vitest/${run}`,
        metadata: { role: 'viewer' },
      })
      expect(rows.find((r) => r.action === 'organization.updated')).toMatchObject({
        changedFields: ['name'],
        before: { name: expect.any(String) },
        after: { name: 'Sec renamed' },
        actorType: 'user',
        actorLabel: owner.email,
      })

      await payload.delete({ collection: 'users', id: invitee.id })
    })

    it('is pruned by the retention job after AUDIT_LOG_KEEP_DAYS', async () => {
      await recordAuditEvent(payload, { action: 'auth.login', ip: `test-${run}` })
      const [fresh] = await auditRows({ ip: { equals: `test-${run}` } })
      const old = await payload.create({
        collection: 'audit-logs',
        data: { action: 'auth.login', ip: `test-${run}` },
        depth: 0,
      })
      const ancient = new Date(Date.now() - (AUDIT_LOG_KEEP_DAYS + 2) * 86_400_000)
      await payload.db.updateOne({
        collection: 'audit-logs',
        id: old.id,
        data: { createdAt: ancient.toISOString() },
      })

      const result = await runRetention(payload)
      expect(result.auditLogs).toBeGreaterThanOrEqual(1)

      const remaining = (await auditRows({ ip: { equals: `test-${run}` } })).map((r) => r.id)
      expect(remaining).not.toContain(old.id)
      expect(remaining).toContain(fresh!.id)
    })
  })

  describe('login rate limit', () => {
    it('returns 429 with Retry-After after repeated bad passwords and audits the attempts', async () => {
      const target = email('victim')
      let last: Response | undefined
      for (let i = 0; i < LOGIN_RATE_LIMIT.points; i += 1) {
        last = await restLogin({ email: target, password: 'wrong-password' })
        expect(last.status).toBe(401)
      }

      const blocked = await restLogin({ email: target, password: 'wrong-password' })
      expect(blocked.status).toBe(429)
      expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0)
      expect(blocked.headers.get('X-RateLimit-Limit')).toBe(String(LOGIN_RATE_LIMIT.points))
      expect(blocked.headers.get('X-RateLimit-Remaining')).toBe('0')
      await expect(blocked.json()).resolves.toMatchObject({
        errors: [{ message: expect.stringContaining('Too many') }],
      })

      // Another account is not affected (the bucket is per e-mail without a trusted proxy address).
      const other = await restLogin({ email: email('someone-else'), password: 'wrong-password' })
      expect(other.status).toBe(401)

      const failures = await auditRows({
        and: [
          { action: { equals: 'auth.login_failed' } },
          { 'metadata.email': { equals: target } },
        ],
      })
      expect(failures.length).toBe(LOGIN_RATE_LIMIT.points)
      const limited = await auditRows({
        and: [
          { action: { equals: 'auth.rate_limited' } },
          { 'metadata.email': { equals: target } },
        ],
      })
      expect(limited.length).toBe(1)
    })
  })
})
