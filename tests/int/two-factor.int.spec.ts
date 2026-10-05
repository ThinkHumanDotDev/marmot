import { generateSync } from 'otplib'
import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'

import { addOrgMembership } from '@/access/memberships'
import { canInOrg } from '@/access/overrides'
import { verifyPassword } from '@/auth/password'
import { TWO_FACTOR_CHALLENGE_COOKIE } from '@/auth/two-factor/challenge'
import { handlePasswordLogin, handleTwoFactorLogin } from '@/auth/two-factor/handlers'
import { getTwoFactorStatus, loadTwoFactorUser } from '@/auth/two-factor/service'
import { POST as regenerateBackupCodes } from '@/app/api/account/2fa/backup-codes/route'
import { POST as disableTwoFactorRoute } from '@/app/api/account/2fa/disable/route'
import { POST as setupTwoFactor } from '@/app/api/account/2fa/setup/route'
import { POST as verifyTwoFactor } from '@/app/api/account/2fa/verify/route'
import { POST as smtpTest } from '@/app/api/instance/smtp-test/route'
import {
  GET as getPermissions,
  PUT as putPermissions,
} from '@/app/api/orgs/[orgId]/permissions/route'
import { GET as listNotifications } from '@/app/api/orgs/[orgId]/notifications/route'
import type { Organization, User } from '@/payload-types'

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+${run}@twofactor.test`
const PASSWORD = 'password-123'
const ORIGIN = 'http://localhost:3000'

type RequestUser = User & { collection: 'users' }

const createUser = (name: string, extra: Partial<User> = {}) =>
  payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name, ...extra },
  })

async function as(user: { id: User['id'] }): Promise<RequestUser> {
  const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
  return { ...fresh, collection: 'users' }
}

/** `Request` carrying a Payload JWT for `user` (works regardless of the 2FA gate). */
async function authedRequest(
  user: User,
  method: string,
  body?: unknown,
  url = 'http://localhost/api/test',
): Promise<Request> {
  const { token } = await payload.login({
    collection: 'users',
    data: { email: user.email, password: PASSWORD },
    context: { twoFactorGate: true },
  })
  return new Request(url, {
    method,
    headers: {
      Authorization: `JWT ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

const jsonRequest = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

const params = <T extends Record<string, string | number>>(values: T) => ({
  params: Promise.resolve(
    Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)])) as {
      [K in keyof T]: string
    },
  ),
})

const cookieOf = (res: Response, name: string) => {
  const set = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))
  return set ? set.split(';')[0] : undefined
}

const payloadCookieName = () => `${payload.config.cookiePrefix}-token`

const code = (secret: string, offsetMs = 0) =>
  generateSync({ secret, epoch: Math.floor((Date.now() + offsetMs) / 1000) })

async function authenticate(cookie: string | undefined): Promise<User | null> {
  const { user } = await payload.auth({
    headers: new Headers({ cookie: cookie ?? '', origin: ORIGIN }),
  })
  return (user as User | null) ?? null
}

async function sessionCount(userId: User['id']): Promise<number> {
  const user = await loadTwoFactorUser(payload, userId)
  return user.sessions?.length ?? 0
}

/**
 * Tests run well within one 30 s TOTP step, so a code accepted by an earlier test would count as a
 * replay of the same step. Forget the last accepted step instead of waiting for the clock.
 */
async function forgetLastUsedStep(userId: User['id']): Promise<void> {
  await payload.update({
    collection: 'users',
    id: userId,
    data: { twoFactorLastUsedStep: null } as Partial<User>,
    depth: 0,
    overrideAccess: true,
  })
}

describe('two-factor authentication', () => {
  let alice: User
  let secret: string
  let backupCodes: string[]

  beforeAll(async () => {
    payload = await getPayload({ config })
    alice = await createUser('alice')
  })

  afterAll(async () => {
    await payload.delete({
      collection: 'organizations',
      where: { slug: { like: `-${run}` } },
      overrideAccess: true,
    })
    await payload.delete({
      collection: 'users',
      where: { email: { like: `+${run}@twofactor.test` } },
    })
  })

  it('hides the secret material from the API but exposes the flag', async () => {
    const fields = payload.collections.users.config.flattenedFields.map((f) => f.name)
    const user = await payload.findByID({ collection: 'users', id: alice.id, depth: 0 })
    expect(user.twoFactorEnabled).toBe(false)
    expect(user).not.toHaveProperty('twoFactorSecret')
    expect(user).not.toHaveProperty('twoFactorBackupCodes')
    expect(fields).toEqual(expect.arrayContaining(['twoFactorSecret', 'twoFactorPendingSecret']))

    // Even the user themself cannot write the protected fields.
    await payload.update({
      collection: 'users',
      id: alice.id,
      data: { twoFactorEnabled: true, twoFactorSecret: 'x' } as Partial<User>,
      user: await as(alice),
      overrideAccess: false,
    })
    expect((await loadTwoFactorUser(payload, alice.id)).twoFactorEnabled).toBe(false)
    expect((await loadTwoFactorUser(payload, alice.id)).twoFactorSecret ?? null).toBeNull()
  })

  it('enrols: setup needs the password, verify needs a valid code, backup codes come once', async () => {
    const noPassword = await setupTwoFactor(await authedRequest(alice, 'POST', {}))
    expect(noPassword.status).toBe(400)
    const wrongPassword = await setupTwoFactor(
      await authedRequest(alice, 'POST', { password: 'nope' }),
    )
    expect(wrongPassword.status).toBe(401)

    const setup = await setupTwoFactor(await authedRequest(alice, 'POST', { password: PASSWORD }))
    expect(setup.status).toBe(200)
    const body = (await setup.json()) as { secret: string; otpauthUrl: string; qrDataUrl: string }
    expect(body.otpauthUrl).toContain(`secret=${body.secret}`)
    expect(body.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true)
    secret = body.secret

    // Pending: login still works without a code, the stored copy is encrypted.
    const stored = await loadTwoFactorUser(payload, alice.id)
    expect(stored.twoFactorEnabled).toBe(false)
    expect(stored.twoFactorPendingSecret).toMatch(/^v1\./)
    expect(stored.twoFactorPendingSecret).not.toContain(secret)

    const bad = await verifyTwoFactor(await authedRequest(alice, 'POST', { code: '000000' }))
    expect(bad.status).toBe(400)

    const ok = await verifyTwoFactor(await authedRequest(alice, 'POST', { code: code(secret) }))
    expect(ok.status).toBe(200)
    const verified = (await ok.json()) as { enabled: true; backupCodes: string[] }
    expect(verified.enabled).toBe(true)
    expect(verified.backupCodes).toHaveLength(10)
    backupCodes = verified.backupCodes

    const status = await getTwoFactorStatus(payload, alice.id)
    expect(status).toMatchObject({ enabled: true, backupCodesRemaining: 10 })
    expect(status.verifiedAt).toBeTruthy()
    const after = await loadTwoFactorUser(payload, alice.id)
    expect(after.twoFactorPendingSecret ?? null).toBeNull()
    expect(after.twoFactorSecret).toMatch(/^v1\./)

    const again = await setupTwoFactor(await authedRequest(alice, 'POST', { password: PASSWORD }))
    expect(again.status).toBe(409)
  })

  it("closes Payload's own login for protected accounts", async () => {
    await expect(
      payload.login({ collection: 'users', data: { email: alice.email, password: PASSWORD } }),
    ).rejects.toThrow(/two-factor/i)
    // Re-authentication for settings keeps working and leaves no session behind.
    const before = await sessionCount(alice.id)
    expect(await verifyPassword(payload, alice.email, PASSWORD)).toBe(true)
    expect(await verifyPassword(payload, alice.email, 'wrong')).toBe(false)
    expect(await sessionCount(alice.id)).toBe(before)
  })

  it('signs in in two steps: password → challenge → code → session cookie', async () => {
    await forgetLastUsedStep(alice.id)
    const sessionsBefore = await sessionCount(alice.id)

    const wrong = await handlePasswordLogin(jsonRequest({ email: alice.email, password: 'nope' }))
    expect(wrong.status).toBe(401)

    const first = await handlePasswordLogin(jsonRequest({ email: alice.email, password: PASSWORD }))
    expect(first.status).toBe(200)
    const step1 = (await first.json()) as { requiresTwoFactor?: boolean; challenge?: string }
    expect(step1.requiresTwoFactor).toBe(true)
    expect(typeof step1.challenge).toBe('string')
    expect(cookieOf(first, payloadCookieName())).toBeUndefined()
    const challengeCookie = cookieOf(first, TWO_FACTOR_CHALLENGE_COOKIE)
    expect(challengeCookie).toBeDefined()
    // The session Payload created for the password check was revoked again.
    expect(await sessionCount(alice.id)).toBe(sessionsBefore)

    // No challenge → 401.
    const noChallenge = await handleTwoFactorLogin(jsonRequest({ code: code(secret) }))
    expect(noChallenge.status).toBe(401)

    // Wrong code → 401, challenge stays alive (re-issued with the attempt counter).
    const bad = await handleTwoFactorLogin(
      jsonRequest({ code: '000000' }, { cookie: challengeCookie as string }),
    )
    expect(bad.status).toBe(401)
    expect(cookieOf(bad, TWO_FACTOR_CHALLENGE_COOKIE)).toBeDefined()
    expect(cookieOf(bad, payloadCookieName())).toBeUndefined()

    // Right code (challenge from the body this time) → session cookie, challenge cleared.
    const totp = code(secret)
    const ok = await handleTwoFactorLogin(jsonRequest({ code: totp, challenge: step1.challenge }))
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { user: { email: string }; method: string }
    expect(body.user.email).toBe(alice.email)
    expect(body.method).toBe('totp')
    const session = cookieOf(ok, payloadCookieName())
    expect(session).toBeDefined()
    expect(cookieOf(ok, TWO_FACTOR_CHALLENGE_COOKIE)).toBe(`${TWO_FACTOR_CHALLENGE_COOKIE}=`)
    expect((await authenticate(session))?.email).toBe(alice.email)
    expect(await sessionCount(alice.id)).toBe(sessionsBefore + 1)

    // Replay of the same code within the window is refused.
    const replay = await handleTwoFactorLogin(
      jsonRequest({ code: totp, challenge: step1.challenge }),
    )
    expect(replay.status).toBe(401)
  })

  it('exhausts the challenge after too many wrong codes', async () => {
    const first = await handlePasswordLogin(jsonRequest({ email: alice.email, password: PASSWORD }))
    let cookie = cookieOf(first, TWO_FACTOR_CHALLENGE_COOKIE) as string
    for (let attempt = 1; attempt < 5; attempt += 1) {
      const res = await handleTwoFactorLogin(jsonRequest({ code: '000000' }, { cookie }))
      expect(res.status).toBe(401)
      cookie = cookieOf(res, TWO_FACTOR_CHALLENGE_COOKIE) as string
    }
    const last = await handleTwoFactorLogin(jsonRequest({ code: '000000' }, { cookie }))
    expect(last.status).toBe(429)
    expect(cookieOf(last, TWO_FACTOR_CHALLENGE_COOKIE)).toBe(`${TWO_FACTOR_CHALLENGE_COOKIE}=`)
  })

  it('accepts each backup code once', async () => {
    const start = await handlePasswordLogin(jsonRequest({ email: alice.email, password: PASSWORD }))
    const { challenge } = (await start.json()) as { challenge: string }

    const ok = await handleTwoFactorLogin(jsonRequest({ code: backupCodes[0], challenge }))
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { method: string }).method).toBe('backup')
    expect((await getTwoFactorStatus(payload, alice.id)).backupCodesRemaining).toBe(9)

    const start2 = await handlePasswordLogin(
      jsonRequest({ email: alice.email, password: PASSWORD }),
    )
    const second = (await start2.json()) as { challenge: string }
    const reused = await handleTwoFactorLogin(
      jsonRequest({ code: backupCodes[0], challenge: second.challenge }),
    )
    expect(reused.status).toBe(401)
    const other = await handleTwoFactorLogin(
      jsonRequest({ code: backupCodes[1].toUpperCase(), challenge: second.challenge }),
    )
    expect(other.status).toBe(200)
    expect((await getTwoFactorStatus(payload, alice.id)).backupCodesRemaining).toBe(8)
  })

  it('regenerates backup codes with an authenticator code only', async () => {
    const withBackup = await regenerateBackupCodes(
      await authedRequest(alice, 'POST', { code: backupCodes[2] }),
    )
    expect(withBackup.status).toBe(400)
    // The backup code was consumed by the attempt above (single use), as with a login.
    await forgetLastUsedStep(alice.id)
    const res = await regenerateBackupCodes(
      await authedRequest(alice, 'POST', { code: code(secret) }),
    )
    expect(res.status).toBe(200)
    const { backupCodes: fresh } = (await res.json()) as { backupCodes: string[] }
    expect(fresh).toHaveLength(10)
    expect(fresh).not.toEqual(backupCodes)
    backupCodes = fresh
    expect((await getTwoFactorStatus(payload, alice.id)).backupCodesRemaining).toBe(10)
  })

  it('disables with password and a current code, then plain login works again', async () => {
    const missing = await disableTwoFactorRoute(
      await authedRequest(alice, 'POST', { password: PASSWORD }),
    )
    expect(missing.status).toBe(400)
    const wrongPassword = await disableTwoFactorRoute(
      await authedRequest(alice, 'POST', { password: 'nope', code: backupCodes[0] }),
    )
    expect(wrongPassword.status).toBe(401)

    const ok = await disableTwoFactorRoute(
      await authedRequest(alice, 'POST', { password: PASSWORD, code: backupCodes[0] }),
    )
    expect(ok.status).toBe(200)
    const after = await loadTwoFactorUser(payload, alice.id)
    expect(after.twoFactorEnabled).toBe(false)
    expect(after.twoFactorSecret ?? null).toBeNull()
    expect(after.twoFactorBackupCodes ?? null).toBeNull()

    const login = await handlePasswordLogin(jsonRequest({ email: alice.email, password: PASSWORD }))
    expect(login.status).toBe(200)
    const body = (await login.json()) as { user?: { email: string }; requiresTwoFactor?: boolean }
    expect(body.requiresTwoFactor).toBeUndefined()
    expect(body.user?.email).toBe(alice.email)
    expect((await authenticate(cookieOf(login, payloadCookieName())))?.email).toBe(alice.email)
  })
})

describe('instance settings and SMTP test', () => {
  let root: User
  let member: User

  beforeAll(async () => {
    payload = await getPayload({ config })
    root = await createUser('root', { superadmin: true })
    member = await createUser('plain')
  })

  it('is readable by members and writable by superadmins only', async () => {
    await expect(
      payload.findGlobal({
        slug: 'instance-settings',
        user: await as(member),
        overrideAccess: false,
      }),
    ).resolves.toBeDefined()
    await expect(
      payload.updateGlobal({
        slug: 'instance-settings',
        data: { trustProxy: true },
        user: await as(member),
        overrideAccess: false,
      }),
    ).rejects.toThrow()
    const updated = await payload.updateGlobal({
      slug: 'instance-settings',
      data: { entryPage: 'status-page' },
      user: await as(root),
      overrideAccess: false,
    })
    expect(updated.entryPage).toBe('status-page')
    await payload.updateGlobal({ slug: 'instance-settings', data: { entryPage: 'dashboard' } })
  })

  it('POST /api/instance/smtp-test: 401 anonymous, 403 member, 400 without SMTP_HOST', async () => {
    expect(process.env.SMTP_HOST ?? '').toBe('')
    const anonymous = await smtpTest(
      new Request('http://localhost/api/instance/smtp-test', { method: 'POST' }),
    )
    expect(anonymous.status).toBe(401)
    expect((await smtpTest(await authedRequest(member, 'POST', {}))).status).toBe(403)
    const unset = await smtpTest(await authedRequest(root, 'POST', {}))
    expect(unset.status).toBe(400)
    expect(((await unset.json()) as { errors: { message: string }[] }).errors[0].message).toMatch(
      /SMTP is not configured/,
    )
  })
})

describe('organization permission overrides', () => {
  let owner: User
  let admin: User
  let member: User
  let org: Organization

  beforeAll(async () => {
    payload = await getPayload({ config })
    owner = await createUser('owner')
    admin = await createUser('admin')
    member = await createUser('member')
    org = await payload.create({
      collection: 'organizations',
      data: { name: 'Overrides', slug: `overrides-${run}` },
      user: await as(owner),
      overrideAccess: false,
    })
    await addOrgMembership({ payload, userId: admin.id, orgId: org.id, role: 'admin' })
    await addOrgMembership({ payload, userId: member.id, orgId: org.id, role: 'member' })
  })

  it('only owners may change them; the response shows defaults, overrides and effective roles', async () => {
    const forbidden = await putPermissions(
      await authedRequest(admin, 'PUT', { overrides: { 'monitor:create': 'admin' } }),
      params({ orgId: org.id }),
    )
    expect(forbidden.status).toBe(403)

    const invalid = await putPermissions(
      await authedRequest(owner, 'PUT', { overrides: { 'organization:delete': 'viewer' } }),
      params({ orgId: org.id }),
    )
    expect(invalid.status).toBe(400)

    const ok = await putPermissions(
      await authedRequest(owner, 'PUT', {
        overrides: {
          'monitor:create': 'admin',
          'notification:create': 'member',
          'monitor:read': 'viewer',
        },
      }),
      params({ orgId: org.id }),
    )
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as {
      overrides: Record<string, string>
      effective: Record<string, string>
      canEdit: boolean
    }
    expect(body.overrides).toEqual({ 'monitor:create': 'admin', 'notification:create': 'member' })
    expect(body.effective['monitor:create']).toBe('admin')
    expect(body.effective['monitor:update']).toBe('member')

    const read = await getPermissions(await authedRequest(member, 'GET'), params({ orgId: org.id }))
    expect(read.status).toBe(200)
    expect(((await read.json()) as { canEdit: boolean }).canEdit).toBe(false)

    // Payload REST / Local API writes by non-owners are stripped by field access too.
    await payload.update({
      collection: 'organizations',
      id: org.id,
      data: { permissionOverrides: {} },
      user: await as(admin),
      overrideAccess: false,
    })
    const stored = await payload.findByID({ collection: 'organizations', id: org.id, depth: 0 })
    expect(stored.permissionOverrides).toEqual({
      'monitor:create': 'admin',
      'notification:create': 'member',
    })
  })

  it('route helpers and collection access honour the overrides', async () => {
    // Raised: members can no longer create monitors (route check and collection access agree).
    expect(await canInOrg(payload, await as(member), org.id, 'monitor:create')).toBe(false)
    expect(await canInOrg(payload, await as(admin), org.id, 'monitor:create')).toBe(true)
    await expect(
      payload.create({
        collection: 'monitors',
        data: {
          name: 'blocked',
          type: 'http',
          url: 'https://example.com',
          organization: org.id,
        } as never,
        user: await as(member),
        overrideAccess: false,
      }),
    ).rejects.toThrow()

    // Lowered: members may now create notification channels.
    expect(await canInOrg(payload, await as(member), org.id, 'notification:create')).toBe(true)
    const channel = await payload.create({
      collection: 'notifications',
      data: {
        name: 'members can',
        type: 'webhook',
        config: { url: 'https://example.com/hook' },
        organization: org.id,
      } as never,
      user: await as(member),
      overrideAccess: false,
    })
    expect(channel.id).toBeDefined()

    // `GET /api/orgs/:orgId/notifications` (notification:read, default member) still works.
    const list = await listNotifications(
      await authedRequest(member, 'GET'),
      params({ orgId: org.id }),
    )
    expect(list.status).toBe(200)

    // Reset to defaults restores the original rules.
    const reset = await putPermissions(
      await authedRequest(owner, 'PUT', { overrides: {} }),
      params({ orgId: org.id }),
    )
    expect(reset.status).toBe(200)
    expect(await canInOrg(payload, await as(member), org.id, 'monitor:create')).toBe(true)
    expect(await canInOrg(payload, await as(member), org.id, 'notification:create')).toBe(false)
  })
})
