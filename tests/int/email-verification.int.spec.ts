import { getPayload, type Payload, type SendEmailOptions } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest'

import config from '@payload-config'

import { addOrgMembership } from '@/access/memberships'
import { POST as restPost } from '@/app/(payload)/api/[...slug]/route'
import { POST as resendRoute } from '@/app/api/auth/verify-email/resend/route'
import { POST as verifyRoute } from '@/app/api/auth/verify-email/route'
import { POST as createNotificationRoute } from '@/app/api/orgs/[orgId]/notifications/route'
import { userResolution } from '@/auth/sso/hooks'
import { acceptInvitation } from '@/collections/Invitations'
import type { Organization, User } from '@/payload-types'
import {
  closeEmailTokenStore,
  consumeEmailToken,
  issueEmailToken,
} from '@/server/auth/email-tokens'
import {
  EMAIL_VERIFICATION_RATE_LIMIT,
  needsEmailVerification,
} from '@/server/auth/email-verification'
import { resetInstanceSettingsCache } from '@/server/settings'

let payload: Payload
let sendEmail: MockInstance<Payload['sendEmail']>
let owner: User
let org: Organization

const run = Date.now().toString(36)
const email = (name: string) => `${name}+${run}@verify.test`
const PASSWORD = 'password-123'
const ORIGIN = 'http://localhost:3000'

type RequestUser = User & { collection: 'users' }

async function as(user: { id: User['id'] }): Promise<RequestUser> {
  const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
  return { ...fresh, collection: 'users' }
}

async function setRequired(value: boolean | null) {
  await payload.updateGlobal({
    slug: 'instance-settings',
    data: { requireEmailVerification: value },
    overrideAccess: true,
  })
  resetInstanceSettingsCache()
}

/** Self-service sign-up as `/signup` does it: anonymous, access enforced. */
const signUp = (name: string) =>
  payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name },
    overrideAccess: false,
    depth: 0,
  })

/** Server-side creation (setup wizard, tests, provisioning). */
const createServerUser = (name: string, extra: Partial<User> = {}) =>
  payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name, ...extra },
    depth: 0,
  })

const mailsTo = (address: string): SendEmailOptions[] =>
  sendEmail.mock.calls
    .map(([message]) => message as SendEmailOptions)
    .filter((message) => message.to === address)

/** Token from the newest verification mail sent to `address`. */
function lastToken(address: string): string {
  const mails = mailsTo(address)
  const text = String(mails[mails.length - 1]?.text ?? '')
  const match = text.match(/verify-email\?token=([A-Za-z0-9_-]{43})/)
  if (!match?.[1]) throw new Error(`no verification link sent to ${address}`)
  return match[1]
}

async function authedRequest(user: { email: string }, url: string, body?: unknown) {
  const { token } = await payload.login({
    collection: 'users',
    data: { email: user.email, password: PASSWORD },
    context: { twoFactorGate: true },
  })
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: `JWT ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

const jsonPost = (url: string, body: unknown) =>
  new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin: ORIGIN },
    body: JSON.stringify(body),
  })

async function auditCount(user: { id: User['id'] }, action: string, method?: string) {
  const { docs } = await payload.find({
    collection: 'audit-logs',
    where: {
      and: [{ action: { equals: action } }, { entityId: { equals: String(user.id) } }],
    },
    limit: 50,
    depth: 0,
    overrideAccess: true,
  })
  return docs.filter(
    (doc) => !method || (doc.metadata as { method?: string } | null)?.method === method,
  ).length
}

const createOrg = (user: RequestUser, slug: string) =>
  payload.create({
    collection: 'organizations',
    data: { name: slug, slug },
    user,
    overrideAccess: false,
    depth: 0,
  })

describe('email verification (#177)', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    owner = await createServerUser('owner')
    org = await createOrg(await as(owner), `verify-${run}`)
  })

  beforeAll(() => {
    sendEmail = vi.spyOn(payload, 'sendEmail').mockResolvedValue(undefined as never)
  })

  afterEach(async () => {
    await setRequired(null)
  })

  afterAll(async () => {
    sendEmail.mockRestore()
    await payload.delete({
      collection: 'notifications',
      where: { organization: { equals: org.id } },
      overrideAccess: true,
    })
    await payload.delete({
      collection: 'organizations',
      where: { slug: { like: `-${run}` } },
      overrideAccess: true,
    })
    await payload.delete({
      collection: 'users',
      where: { email: { like: `+${run}@verify.test` } },
      overrideAccess: true,
    })
    await closeEmailTokenStore()
  })

  describe('setting off (default)', () => {
    it('signs up verified, sends no mail and lets the account create organizations', async () => {
      const user = await signUp('off')
      expect(user.emailVerified).toBe(true)
      expect(mailsTo(user.email)).toHaveLength(0)
      expect(await needsEmailVerification(payload, user)).toBe(false)
      const created = await createOrg(await as(user), `off-${run}`)
      expect(created.slug).toBe(`off-${run}`)
    })

    it('does not gate accounts left unverified once the setting is turned off', async () => {
      await setRequired(true)
      const user = await signUp('was-on')
      expect(user.emailVerified).toBe(false)
      await setRequired(false)
      expect(await needsEmailVerification(payload, user)).toBe(false)
      await expect(createOrg(await as(user), `was-on-${run}`)).resolves.toBeTruthy()
    })
  })

  describe('setting on', () => {
    it('keeps existing, server-created and superadmin accounts verified', async () => {
      await setRequired(true)
      const fresh = await as(owner)
      expect(fresh.emailVerified).toBe(true)
      expect(await needsEmailVerification(payload, fresh)).toBe(false)

      const server = await createServerUser('server')
      expect(server.emailVerified).toBe(true)

      // A superadmin flagged unverified (e.g. by hand) is never locked out.
      const admin = await createServerUser('admin', { superadmin: true, emailVerified: false })
      expect(await needsEmailVerification(payload, admin)).toBe(false)
    })

    it('creates a REST sign-up unverified, mails a link and ignores a client-supplied flag', async () => {
      await setRequired(true)
      const address = email('rest')
      const res = await restPost(
        jsonPost(`${ORIGIN}/api/users`, {
          email: address,
          password: PASSWORD,
          name: 'Rest',
          emailVerified: true,
        }),
        { params: Promise.resolve({ slug: ['users'] }) },
      )
      expect(res.status).toBe(201)
      const { docs } = await payload.find({
        collection: 'users',
        where: { email: { equals: address } },
        depth: 0,
      })
      expect(docs[0]?.emailVerified).toBe(false)
      expect(mailsTo(address)).toHaveLength(1)
      const mail = mailsTo(address)[0]!
      expect(mail.subject).toBe('Confirm your email address for Marmot')
      expect(String(mail.html)).toContain('/verify-email?token=')
      expect(await auditCount(docs[0]!, 'auth.email_verification_sent')).toBe(1)
    })

    it('answers 403 to organization, invitation and notification creation until verified', async () => {
      await setRequired(true)
      const user = await signUp('gated')
      expect(user.emailVerified).toBe(false)
      // Joined through an invite link (no address proof) with a role that may invite and add channels.
      await addOrgMembership({ payload, userId: user.id, orgId: org.id, role: 'admin' })
      const actor = await as(user)

      await expect(createOrg(actor, `gated-${run}`)).rejects.toMatchObject({
        status: 403,
        message: expect.stringMatching(/Confirm your email address/),
      })
      await expect(
        payload.create({
          collection: 'invitations',
          data: { organization: org.id, email: email('someone'), role: 'member' },
          user: actor,
          overrideAccess: false,
        }),
      ).rejects.toMatchObject({ status: 403 })

      const channel = { name: 'Hook', type: 'webhook', config: { url: 'https://example.com/hook' } }
      const url = `${ORIGIN}/api/orgs/${org.id}/notifications`
      const res = await createNotificationRoute(await authedRequest(user, url, channel), {
        params: Promise.resolve({ orgId: String(org.id) }),
      })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { errors?: { message: string }[] }
      expect(JSON.stringify(body)).toMatch(/Confirm your email address/)

      // Verifying lifts the gate.
      const verified = await verifyRoute(
        jsonPost(`${ORIGIN}/api/auth/verify-email`, {
          token: lastToken(user.email),
        }),
      )
      expect(verified.status).toBe(200)
      const after = await createNotificationRoute(await authedRequest(user, url, channel), {
        params: Promise.resolve({ orgId: String(org.id) }),
      })
      expect(after.status).toBe(201)
    })

    it('verifies through the link once, records it and refuses reuse', async () => {
      await setRequired(true)
      const user = await signUp('link')
      const token = lastToken(user.email)

      const bad = await verifyRoute(
        jsonPost(`${ORIGIN}/api/auth/verify-email`, { token: 'x'.repeat(43) }),
      )
      expect(bad.status).toBe(400)

      const res = await verifyRoute(jsonPost(`${ORIGIN}/api/auth/verify-email`, { token }))
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ verified: true, email: user.email })
      const fresh = await as(user)
      expect(fresh.emailVerified).toBe(true)
      expect(fresh.emailVerifiedAt).toBeTruthy()
      expect(await auditCount(user, 'auth.email_verified', 'link')).toBe(1)

      const again = await verifyRoute(jsonPost(`${ORIGIN}/api/auth/verify-email`, { token }))
      expect(again.status).toBe(400)
    })

    it('resends a new link that replaces the old one, rate limited per account', async () => {
      await setRequired(true)
      const user = await signUp('resend')
      const first = lastToken(user.email)
      const url = `${ORIGIN}/api/auth/verify-email/resend`

      const res = await resendRoute(await authedRequest(user, url))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: true })
      const second = lastToken(user.email)
      expect(second).not.toBe(first)

      // The first link no longer works.
      expect(
        (await verifyRoute(jsonPost(`${ORIGIN}/api/auth/verify-email`, { token: first }))).status,
      ).toBe(400)

      for (let i = 1; i < EMAIL_VERIFICATION_RATE_LIMIT.points; i++) {
        expect((await resendRoute(await authedRequest(user, url))).status).toBe(200)
      }
      const limited = await resendRoute(await authedRequest(user, url))
      expect(limited.status).toBe(429)
      expect(limited.headers.get('Retry-After')).toBeTruthy()

      // The newest link still verifies.
      const latest = lastToken(user.email)
      expect(
        (await verifyRoute(jsonPost(`${ORIGIN}/api/auth/verify-email`, { token: latest }))).status,
      ).toBe(200)
      // Nothing left to resend.
      expect(await (await resendRoute(await authedRequest(user, url))).json()).toEqual({
        sent: false,
      })
    })

    it('verifies by accepting an invitation sent to the address, not one sent elsewhere', async () => {
      await setRequired(true)
      const invited = await signUp('invited')
      const other = await signUp('other')
      const invite = (address: string) =>
        payload.create({
          collection: 'invitations',
          data: { organization: org.id, email: address, role: 'member' },
          overrideAccess: true,
          context: { skipInvitationEmail: true },
        })

      const mine = await invite(invited.email)
      await acceptInvitation({ payload, token: mine.token!, user: invited })
      expect((await as(invited)).emailVerified).toBe(true)
      expect(await auditCount(invited, 'auth.email_verified', 'invitation')).toBe(1)

      const someoneElses = await invite(email('elsewhere'))
      await acceptInvitation({ payload, token: someoneElses.token!, user: other })
      expect((await as(other)).emailVerified).toBe(false)
    })

    it('re-verifies a changed address and only accepts links sent to the current one', async () => {
      await setRequired(true)
      const user = await createServerUser('mover')

      const moved = await payload.update({
        collection: 'users',
        id: user.id,
        data: { email: email('moved') },
        user: await as(user),
        overrideAccess: false,
        depth: 0,
      })
      expect(moved.emailVerified).toBe(false)
      expect(mailsTo(email('moved'))).toHaveLength(1)

      // A link for the previous address cannot confirm the new one.
      const stale = await issueEmailToken({
        purpose: 'email-verification',
        userId: user.id,
        email: user.email,
        ttlSeconds: 60,
      })
      expect(
        (await verifyRoute(jsonPost(`${ORIGIN}/api/auth/verify-email`, { token: stale.token })))
          .status,
      ).toBe(400)
      expect((await as(user)).emailVerified).toBe(false)
    })

    it('treats SSO identities with a verified address as verified', async () => {
      await setRequired(true)
      const provider = { id: 'github', name: 'GitHub', type: 'oauth2', meta: {} } as never
      const ctx = (verified: boolean, address = email('sso')) => ({
        payload,
        request: new Request(`${ORIGIN}/api/auth/sso/github/callback`),
        provider,
        identity: {
          provider: 'github',
          providerAccountId: `gh-${run}`,
          email: address,
          emailVerified: verified,
          raw: {},
        },
      })
      expect(await userResolution.mapNewUser!(ctx(true) as never)).not.toHaveProperty(
        'emailVerified',
      )
      expect(await userResolution.mapNewUser!(ctx(false) as never)).toMatchObject({
        emailVerified: false,
      })

      // A pending local account confirmed by a login whose identity asserts the address.
      const user = await signUp('sso-link')
      await userResolution.afterLogin!({
        ...ctx(true, user.email),
        user,
        created: false,
        linked: true,
      } as never)
      expect((await as(user)).emailVerified).toBe(true)
      expect(await auditCount(user, 'auth.email_verified', 'sso')).toBe(1)
    })
  })

  describe('token plumbing', () => {
    it('binds tokens to their purpose and redeems them once', async () => {
      const { token, expiresAt } = await issueEmailToken({
        purpose: 'email-verification',
        userId: 'u1',
        email: ' Someone@Example.com ',
        ttlSeconds: 60,
      })
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now())
      const redeemed = await consumeEmailToken({ purpose: 'email-verification', token })
      expect(redeemed).toMatchObject({ userId: 'u1', email: 'someone@example.com' })
      expect(await consumeEmailToken({ purpose: 'email-verification', token })).toBeNull()
      expect(await consumeEmailToken({ purpose: 'email-verification', token: 'nope' })).toBeNull()
    })
  })
})
