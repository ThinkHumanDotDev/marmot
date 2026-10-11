import { generateSync } from 'otplib'
import { getPayload, type Payload, type SendEmailOptions } from 'payload'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest'

import config from '@payload-config'

import { addOrgMembership } from '@/access/memberships'
import { GET as configGet } from '@/app/api/auth/config/route'
import { POST as requestRoute } from '@/app/api/auth/magic-link/route'
import { POST as verifyRoute } from '@/app/api/auth/magic-link/verify/route'
import { TWO_FACTOR_CHALLENGE_COOKIE } from '@/auth/two-factor/challenge'
import { handleTwoFactorLogin } from '@/auth/two-factor/handlers'
import { beginTwoFactorSetup, confirmTwoFactorSetup } from '@/auth/two-factor/service'
import { SSO_DOMAINS_SLUG } from '@/collections/SsoDomains'
import { resetEnvCache } from '@/env'
import type { Organization, User } from '@/payload-types'
import { closeEmailTokenStore, issueEmailToken } from '@/server/auth/email-tokens'
import {
  MAGIC_LINK_EMAIL_RATE_LIMIT,
  MAGIC_LINK_IP_RATE_LIMIT,
  settleMagicLinkDeliveries,
} from '@/server/auth/magic-link'
import { createRedis } from '@/server/redis'
import { RATE_LIMIT_PREFIX } from '@/server/security/rate-limit'
import { resetInstanceSettingsCache } from '@/server/settings'

let payload: Payload
let sendEmail: MockInstance<Payload['sendEmail']>

const run = Date.now().toString(36)
const DOMAIN = `magic-${run}.test`
const email = (name: string) => `${name}@${DOMAIN}`
const PASSWORD = 'password-123'
const ORIGIN = 'http://localhost:3000'

let ip = 0
/** A fresh client address per request unless one is given (the per-IP bucket stays out of the way). */
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      origin: ORIGIN,
      'x-forwarded-for': `198.51.100.${(ip++ % 250) + 1}`,
      ...headers,
    },
    body: JSON.stringify(body),
  })

const askForLink = (address: string, extra: Record<string, unknown> = {}, headers = {}) =>
  requestRoute(post('/api/auth/magic-link', { email: address, ...extra }, headers))

const redeem = (token: string) => verifyRoute(post('/api/auth/magic-link/verify', { token }))

async function setSettings(data: Record<string, unknown>) {
  await payload.updateGlobal({ slug: 'instance-settings', data, overrideAccess: true })
  resetInstanceSettingsCache()
}

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetEnvCache()
}

/** Sign-in mails sent to `address` (not verification mails). */
const mailsTo = (address: string): SendEmailOptions[] =>
  sendEmail.mock.calls
    .map(([message]) => message as SendEmailOptions)
    .filter((message) => message.to === address && /\/login\/magic-link/.test(String(message.text)))

/** Token from the newest sign-in mail sent to `address`. */
async function lastToken(address: string): Promise<string> {
  await settleMagicLinkDeliveries()
  const mails = mailsTo(address)
  const text = String(mails[mails.length - 1]?.text ?? '')
  const match = text.match(/\/login\/magic-link\?token=([A-Za-z0-9_-]{43})/)
  if (!match?.[1]) throw new Error(`no sign-in link sent to ${address}`)
  return match[1]
}

const createUser = (name: string, extra: Partial<User> = {}) =>
  payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name, ...extra },
    depth: 0,
  })

const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0]

const sessionCookieName = () => `${payload.config.cookiePrefix}-token`

async function authenticate(cookie: string | undefined): Promise<User | null> {
  const { user } = await payload.auth({
    headers: new Headers({ cookie: cookie ?? '', origin: ORIGIN }),
  })
  return (user as User | null) ?? null
}

async function audits(action: string, entityId?: User['id']) {
  const { docs } = await payload.find({
    collection: 'audit-logs',
    where: {
      and: [
        { action: { equals: action } },
        ...(entityId !== undefined ? [{ entityId: { equals: String(entityId) } }] : []),
      ],
    },
    limit: 100,
    depth: 0,
    overrideAccess: true,
  })
  return docs
}

async function clearRateLimits() {
  const redis = createRedis()
  const stale = await redis.keys(`${RATE_LIMIT_PREFIX}:magic-link*`)
  if (stale.length) await redis.del(...stale)
  await redis.quit()
}

describe('magic-link sign-in (#164)', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    sendEmail = vi.spyOn(payload, 'sendEmail').mockResolvedValue(undefined as never)
    await clearRateLimits()
  })

  afterEach(async () => {
    await settleMagicLinkDeliveries()
  })

  afterAll(async () => {
    sendEmail.mockRestore()
    await setSettings({
      magicLinkEnabled: null,
      allowSignup: null,
      requireEmailVerification: null,
      trustProxy: null,
    })
    await payload.delete({
      collection: SSO_DOMAINS_SLUG,
      where: { domain: { equals: DOMAIN } },
      overrideAccess: true,
    })
    await payload.delete({
      collection: 'invitations',
      where: { email: { like: DOMAIN } },
      overrideAccess: true,
    })
    await payload.delete({
      collection: 'organizations',
      where: { slug: { like: `magic-${run}` } },
      overrideAccess: true,
    })
    await payload.delete({
      collection: 'users',
      where: { email: { like: `@${DOMAIN}` } },
      overrideAccess: true,
    })
    await closeEmailTokenStore()
  })

  beforeAll(async () => {
    // Per-IP buckets only exist behind a trusted proxy.
    await setSettings({ trustProxy: true })
  })

  it('is off by default', async () => {
    await setSettings({ magicLinkEnabled: null })
    const user = await createUser('off')
    const res = await askForLink(user.email)
    expect(res.status).toBe(403)
    await settleMagicLinkDeliveries()
    expect(mailsTo(user.email)).toHaveLength(0)
    const cfg = await configGet()
    expect(await cfg.json()).toMatchObject({ magicLinkEnabled: false })
  })

  describe('enabled', () => {
    beforeEach(async () => {
      await setSettings({
        magicLinkEnabled: true,
        allowSignup: false,
        requireEmailVerification: null,
        trustProxy: true,
      })
    })

    it('answers the same for known and unknown addresses and only mails the account', async () => {
      await setSettings({ magicLinkEnabled: true, allowSignup: false })
      const user = await createUser('known')
      const known = await askForLink(user.email)
      const unknown = await askForLink(email('nobody'))
      expect(known.status).toBe(202)
      expect(unknown.status).toBe(202)
      expect(await known.json()).toEqual(await unknown.json())
      await settleMagicLinkDeliveries()
      expect(mailsTo(user.email)).toHaveLength(1)
      expect(mailsTo(email('nobody'))).toHaveLength(0)
      const [mail] = mailsTo(user.email)
      expect(mail?.subject).toBe('Your Marmot sign-in link')
      expect(String(mail?.html)).toContain('/login/magic-link?token=')
      expect(await audits('auth.magic_link_sent', user.id)).toHaveLength(1)
    })

    it('rejects something that is not an address', async () => {
      expect((await askForLink('not-an-address')).status).toBe(400)
    })

    it('signs in once, verifies the address, and audits the login', async () => {
      await setSettings({ magicLinkEnabled: true, requireEmailVerification: true })
      const user = await createUser('once', { emailVerified: false })
      await askForLink(user.email, { next: '/somewhere' })
      const token = await lastToken(user.email)
      expect(String(mailsTo(user.email)[0]?.text)).toContain('next=%2Fsomewhere')

      const res = await redeem(token)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { user: { id: User['id'] }; created: boolean }
      expect(String(body.user.id)).toBe(String(user.id))
      expect(body.created).toBe(false)
      const signedIn = await authenticate(cookieOf(res, sessionCookieName()))
      expect(String(signedIn?.id)).toBe(String(user.id))

      const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
      expect(fresh.emailVerified).toBe(true)
      const logins = await audits('auth.login', user.id)
      expect(logins.map((d) => (d.metadata as { method?: string }).method)).toContain('magic-link')
      const verified = await audits('auth.email_verified', user.id)
      expect(verified.map((d) => (d.metadata as { method?: string }).method)).toContain(
        'magic-link',
      )

      // Single use.
      expect((await redeem(token)).status).toBe(400)
    })

    it('rejects unknown, revoked, expired and outdated links', async () => {
      const user = await createUser('stale')
      expect((await redeem('x'.repeat(43))).status).toBe(400)

      await askForLink(user.email)
      const first = await lastToken(user.email)
      await askForLink(user.email)
      const second = await lastToken(user.email)
      expect(second).not.toBe(first)
      expect((await redeem(first)).status).toBe(400) // the newer link revoked it

      // The account's address changed after the link was sent.
      await payload.update({
        collection: 'users',
        id: user.id,
        data: { email: email('stale-moved') },
        overrideAccess: true,
      })
      expect((await redeem(second)).status).toBe(400)

      const { token } = await issueEmailToken({
        purpose: 'magic-link',
        userId: user.id,
        email: email('stale-moved'),
        ttlSeconds: 1,
      })
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      expect((await redeem(token)).status).toBe(400)
    })

    it('does not bypass two-factor authentication', async () => {
      const user = await createUser('totp')
      const { secret } = await beginTwoFactorSetup(payload, user.id)
      const { backupCodes } = await confirmTwoFactorSetup(
        payload,
        user.id,
        generateSync({ secret, epoch: Math.floor(Date.now() / 1000) }),
      )

      await askForLink(user.email)
      const res = await redeem(await lastToken(user.email))
      expect(res.status).toBe(200)
      const body = (await res.json()) as { requiresTwoFactor?: boolean; user?: unknown }
      expect(body.requiresTwoFactor).toBe(true)
      expect(body.user).toBeUndefined()
      expect(cookieOf(res, sessionCookieName())).toBeUndefined()
      const challenge = cookieOf(res, TWO_FACTOR_CHALLENGE_COOKIE)
      expect(challenge).toBeTruthy()

      const second = await handleTwoFactorLogin(
        new Request(`${ORIGIN}/api/auth/2fa`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', cookie: challenge ?? '' },
          body: JSON.stringify({ code: backupCodes[0] }),
        }),
      )
      expect(second.status).toBe(200)
      const signedIn = await authenticate(cookieOf(second, sessionCookieName()))
      expect(String(signedIn?.id)).toBe(String(user.id))
      const logins = await audits('auth.login', user.id)
      expect(logins.map((d) => d.metadata)).toContainEqual(
        expect.objectContaining({ method: 'magic-link', secondFactor: 'backup' }),
      )
    })

    it('creates an account for an unknown address while sign-up is allowed', async () => {
      await setSettings({ magicLinkEnabled: true, allowSignup: true })
      const address = email('newcomer')
      await askForLink(address)
      await settleMagicLinkDeliveries()
      expect(mailsTo(address)[0]?.subject).toBe('Finish creating your Marmot account')
      const res = await redeem(await lastToken(address))
      expect(res.status).toBe(200)
      expect(((await res.json()) as { created: boolean }).created).toBe(true)

      const { docs } = await payload.find({
        collection: 'users',
        where: { email: { equals: address } },
        depth: 0,
        overrideAccess: true,
      })
      expect(docs).toHaveLength(1)
      expect(docs[0]?.authProvider).toBe('magic-link')
      expect(docs[0]?.emailVerified).toBe(true)
      expect(String((await authenticate(cookieOf(res, sessionCookieName())))?.id)).toBe(
        String(docs[0]?.id),
      )
    })

    it('needs a pending invitation for new accounts while sign-up is off', async () => {
      await setSettings({ magicLinkEnabled: true, allowSignup: false })
      const inviter = await createUser('inviter')
      const org = (await payload.create({
        collection: 'organizations',
        data: { name: 'Invited', slug: `invited-magic-${run}` },
        user: { ...inviter, collection: 'users' },
        overrideAccess: true,
      })) as Organization
      const address = email('invitee')
      await payload.create({
        collection: 'invitations',
        data: { organization: org.id, email: address, role: 'member' } as never,
        overrideAccess: true,
      })

      await askForLink(address)
      const res = await redeem(await lastToken(address))
      expect(res.status).toBe(200)
      const user = (await res.json()) as { user: { id: User['id'] } }
      const fresh = await payload.findByID({ collection: 'users', id: user.user.id, depth: 0 })
      const orgIds = (fresh.organizations ?? []).map((m) =>
        String(typeof m.organization === 'object' ? m.organization.id : m.organization),
      )
      expect(orgIds).toContain(String(org.id))
    })

    it('limits links per address and per client', async () => {
      await clearRateLimits()
      const address = email('limited')
      for (let i = 0; i < MAGIC_LINK_EMAIL_RATE_LIMIT.points; i++) {
        expect((await askForLink(address)).status).toBe(202)
      }
      const limited = await askForLink(address)
      expect(limited.status).toBe(429)
      expect(limited.headers.get('Retry-After')).toBeTruthy()
      const rateLimited = await audits('auth.rate_limited')
      expect(
        rateLimited.some(
          (d) => (d.metadata as { email?: string; operation?: string }).email === address,
        ),
      ).toBe(true)

      const client = { 'x-forwarded-for': '203.0.113.77' }
      for (let i = 0; i < MAGIC_LINK_IP_RATE_LIMIT.points; i++) {
        expect((await askForLink(email(`ip-${i}`), {}, client)).status).toBe(202)
      }
      expect((await askForLink(email('ip-last'), {}, client)).status).toBe(429)
      await clearRateLimits()
    })

    describe('single sign-on policy', () => {
      let org: Organization
      let owner: User
      let member: User

      beforeAll(async () => {
        owner = await createUser('sso-owner')
        member = await createUser('sso-member')
        org = (await payload.create({
          collection: 'organizations',
          data: { name: 'Enforced', slug: `enforced-magic-${run}` },
          user: { ...owner, collection: 'users' },
          overrideAccess: true,
        })) as Organization
        await addOrgMembership({ payload, userId: member.id, orgId: org.id, role: 'member' })
        const domain = await payload.create({
          collection: SSO_DOMAINS_SLUG,
          data: { organization: org.id, domain: DOMAIN } as never,
          overrideAccess: true,
        })
        await payload.update({
          collection: SSO_DOMAINS_SLUG,
          id: domain.id,
          data: { verifiedAt: new Date().toISOString() },
          overrideAccess: true,
        })
        await payload.update({
          collection: 'organizations',
          id: org.id,
          data: { enforceSso: true },
          overrideAccess: true,
        })
      })

      afterAll(async () => {
        await payload.update({
          collection: 'organizations',
          id: org.id,
          data: { enforceSso: false },
          overrideAccess: true,
        })
      })

      it('treats links like passwords under organization enforcement', async () => {
        await askForLink(member.email)
        await settleMagicLinkDeliveries()
        expect(mailsTo(member.email)).toHaveLength(0)
        const { token } = await issueEmailToken({
          purpose: 'magic-link',
          userId: member.id,
          email: member.email,
          ttlSeconds: 60,
        })
        const refused = await redeem(token)
        expect(refused.status).toBe(403)
        expect(cookieOf(refused, sessionCookieName())).toBeUndefined()

        // Owners keep their break-glass path, audited.
        await askForLink(owner.email)
        const res = await redeem(await lastToken(owner.email))
        expect(res.status).toBe(200)
        const breakGlass = await audits('auth.break_glass', owner.id)
        expect(breakGlass.map((d) => d.metadata)).toContainEqual(
          expect.objectContaining({ scope: 'organization', method: 'magic-link' }),
        )
      })

      it('creates no account on an enforced domain', async () => {
        await setSettings({ magicLinkEnabled: true, allowSignup: true })
        await askForLink(email('enforced-new'))
        await settleMagicLinkDeliveries()
        expect(mailsTo(email('enforced-new'))).toHaveLength(0)
      })
    })

    it('is off in SSO-only mode, break-glass included', async () => {
      const user = await createUser('sso-only', { superadmin: true })
      await askForLink(user.email)
      const token = await lastToken(user.email)
      const before = {
        OIDC_DISABLE_LOCAL_LOGIN: process.env.OIDC_DISABLE_LOCAL_LOGIN,
        OIDC_BREAK_GLASS: process.env.OIDC_BREAK_GLASS,
      }
      setEnv({ OIDC_DISABLE_LOCAL_LOGIN: 'true', OIDC_BREAK_GLASS: 'true' })
      try {
        expect((await askForLink(user.email)).status).toBe(403)
        expect(
          (await requestRoute(post('/api/auth/magic-link?local=1', { email: user.email }))).status,
        ).toBe(403)
        const res = await redeem(token)
        expect(res.status).toBe(403)
        expect(cookieOf(res, sessionCookieName())).toBeUndefined()
        const cfg = await configGet()
        expect(await cfg.json()).toMatchObject({ magicLinkEnabled: false })
      } finally {
        setEnv(before)
      }
    })
  })
})
