import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The issuer must exist and be configured in `process.env` before `env`/`@payload-config` are
// first imported (the env is parsed once and cached), hence `vi.hoisted`.
const mock = await vi.hoisted(async () => {
  const { startMockIssuer } = await import('../helpers/oidc-issuer')
  const issuer = await startMockIssuer()
  process.env.OIDC_ISSUER_URL = issuer.issuer
  process.env.OIDC_CLIENT_ID = issuer.clientId
  process.env.OIDC_CLIENT_SECRET = issuer.clientSecret
  process.env.OIDC_DISPLAY_NAME = 'Acme SSO'
  process.env.OIDC_AUTO_PROVISION = 'true'
  process.env.DISABLE_SIGNUP = 'false'
  return issuer
})

import config from '@payload-config'

import {
  handleOidcCallback,
  handleOidcLogin,
  handleOidcLogout,
  handleProviders,
} from '@/auth/oidc/handlers'
import { OIDC_STATE_COOKIE } from '@/auth/oidc/state'
import { resetEnvCache } from '@/env'
import type { Organization, User } from '@/payload-types'

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+${run}@sso.marmot.test`
const sub = (name: string) => `${name}-${run}`

const createdUserEmails = new Set<string>()

/** Starts the flow: returns the authorization URL and the sealed transaction cookie. */
async function startLogin(next?: string) {
  const url = new URL('http://localhost:3000/api/auth/oidc/login')
  if (next) url.searchParams.set('next', next)
  const res = await handleOidcLogin(new Request(url))
  expect(res.status).toBe(302)
  const authorizationUrl = new URL(res.headers.get('location') ?? '')
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${OIDC_STATE_COOKIE}=`))
  expect(setCookie).toBeDefined()
  const cookie = (setCookie as string).split(';')[0]
  return { authorizationUrl, cookie }
}

/** Lets the mock issuer "log the user in" and returns the callback URL it redirects to. */
async function authorize(authorizationUrl: URL): Promise<URL> {
  const res = await fetch(authorizationUrl, { redirect: 'manual' })
  expect(res.status).toBe(302)
  return new URL(res.headers.get('location') ?? '')
}

async function callback(callbackUrl: URL, cookie: string) {
  return handleOidcCallback(new Request(callbackUrl, { headers: { cookie } }))
}

/** Full happy-path login for the issuer's current user. */
async function loginVia(next?: string) {
  const { authorizationUrl, cookie } = await startLogin(next)
  const callbackUrl = await authorize(authorizationUrl)
  const res = await callback(callbackUrl, cookie)
  return { res, callbackUrl, cookie }
}

const payloadCookieOf = (res: Response) => {
  const prefix = `${payload.config.cookiePrefix}-token=`
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith(prefix))
  return cookie ? cookie.split(';')[0] : undefined
}

const locationOf = (res: Response) => res.headers.get('location') ?? ''

/**
 * What `payload.auth` makes of the cookie. Browsers send `Origin`/`Sec-Fetch-Site` with every
 * request; Payload's CSRF check ignores cookie tokens that carry neither, so mimic a browser.
 */
async function authenticate(cookie: string | undefined): Promise<User | null> {
  const { user } = await payload.auth({
    headers: new Headers({ cookie: cookie ?? '', origin: 'http://localhost:3000' }),
  })
  return (user as User | null) ?? null
}

async function usersWithEmail(address: string) {
  const { docs } = await payload.find({
    collection: 'users',
    where: { email: { equals: address } },
    depth: 0,
    overrideAccess: true,
  })
  return docs
}

describe('OIDC single sign-on', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
  })

  beforeEach(() => {
    process.env.DISABLE_SIGNUP = 'false'
    process.env.OIDC_AUTO_PROVISION = 'true'
    resetEnvCache()
  })

  afterAll(async () => {
    for (const address of createdUserEmails) {
      await payload.delete({
        collection: 'users',
        where: { email: { equals: address } },
        overrideAccess: true,
      })
    }
    await payload.delete({
      collection: 'invitations',
      where: { email: { like: `+${run}@sso.marmot.test` } },
      overrideAccess: true,
    })
    await mock.close()
  })

  it('advertises the provider', async () => {
    const body = await handleProviders().json()
    expect(body).toEqual({ local: true, oidc: { enabled: true, displayName: 'Acme SSO' } })
  })

  it('redirects to the provider with PKCE, state, nonce and a sealed cookie', async () => {
    const { authorizationUrl, cookie } = await startLogin('/acme/monitors')
    expect(authorizationUrl.origin).toBe(mock.issuer)
    expect(authorizationUrl.pathname).toBe('/authorize')
    const q = authorizationUrl.searchParams
    expect(q.get('response_type')).toBe('code')
    expect(q.get('client_id')).toBe(mock.clientId)
    expect(q.get('redirect_uri')).toBe('http://localhost:3000/api/auth/oidc/callback')
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(q.get('state')).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(q.get('nonce')).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(q.get('scope')).toBe('openid email profile')
    // The cookie carries none of the values in clear text.
    expect(cookie).not.toContain(q.get('state') as string)
    expect(cookie).not.toContain(q.get('nonce') as string)
  })

  it('provisions a user on first login and sets a cookie payload.auth accepts', async () => {
    const address = email('jane')
    createdUserEmails.add(address)
    mock.setUser({
      sub: sub('jane'),
      email: address,
      email_verified: true,
      given_name: 'Jane',
      family_name: 'Doe',
    })

    const { res } = await loginVia('/acme/monitors')
    expect(res.status).toBe(303)
    expect(locationOf(res)).toBe('/acme/monitors')
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${OIDC_STATE_COOKIE}=;`))).toBe(
      true,
    )

    const cookie = payloadCookieOf(res)
    expect(cookie).toBeDefined()
    expect(res.headers.getSetCookie().find((c) => c.startsWith(cookie as string))).toMatch(
      /HttpOnly/,
    )

    const user = await authenticate(cookie)
    expect(user).not.toBeNull()
    expect(user?.email).toBe(address)
    expect(user?.name).toBe('Jane Doe')
    expect(user?.authProvider).toBe('oidc')
    expect(user?.oidcSubject).toBe(sub('jane'))
    expect(user?.oidcIssuer).toBe(mock.issuer)
    expect(user?.superadmin).toBe(false)
  })

  it('reuses the same user on the second login', async () => {
    const address = email('jane')
    const before = await usersWithEmail(address)
    expect(before).toHaveLength(1)

    const { res } = await loginVia()
    expect(res.status).toBe(303)
    expect(locationOf(res)).toBe('/')
    const user = await authenticate(payloadCookieOf(res))
    expect(String(user?.id)).toBe(String(before[0].id))
    expect(await usersWithEmail(address)).toHaveLength(1)
  })

  it('rejects a callback whose state does not match the cookie', async () => {
    const { authorizationUrl, cookie } = await startLogin()
    const callbackUrl = await authorize(authorizationUrl)
    callbackUrl.searchParams.set('state', 'not-the-state')
    const res = await callback(callbackUrl, cookie)
    expect(res.status).toBe(303)
    expect(locationOf(res)).toBe('/login?error=oidc_state')
    expect(payloadCookieOf(res)).toBeUndefined()
    expect(mock.tokenRequests()).toBe(2) // no token exchange happened
  })

  it('rejects a callback without the transaction cookie', async () => {
    const { authorizationUrl } = await startLogin()
    const callbackUrl = await authorize(authorizationUrl)
    const res = await handleOidcCallback(new Request(callbackUrl))
    expect(locationOf(res)).toBe('/login?error=oidc_state')
  })

  it('rejects a callback whose cookie belongs to another transaction (nonce/PKCE)', async () => {
    const first = await startLogin()
    const second = await startLogin()
    const callbackUrl = await authorize(second.authorizationUrl)
    // Right query string, wrong cookie: the state check fails before any token exchange.
    const res = await callback(callbackUrl, first.cookie)
    expect(locationOf(res)).toBe('/login?error=oidc_state')
  })

  it('links an existing local account when the provider verified the email', async () => {
    const address = email('local')
    createdUserEmails.add(address)
    const local = await payload.create({
      collection: 'users',
      data: { email: address, password: 'password-123', name: 'Local Larry' },
      overrideAccess: true,
    })
    mock.setUser({ sub: sub('larry'), email: address, email_verified: true, name: 'Larry' })

    const { res } = await loginVia()
    const user = await authenticate(payloadCookieOf(res))
    expect(String(user?.id)).toBe(String(local.id))
    expect(user?.oidcSubject).toBe(sub('larry'))
    expect(user?.authProvider).toBe('local')
    expect(user?.name).toBe('Local Larry')
  })

  it('never links by an unverified email', async () => {
    const address = email('victim')
    createdUserEmails.add(address)
    await payload.create({
      collection: 'users',
      data: { email: address, password: 'password-123' },
      overrideAccess: true,
    })
    mock.setUser({ sub: sub('impostor'), email: address, email_verified: false })

    const { res } = await loginVia()
    expect(locationOf(res)).toBe('/login?error=email_unverified')
    expect(payloadCookieOf(res)).toBeUndefined()
    const [user] = await usersWithEmail(address)
    expect(user.oidcSubject ?? null).toBeNull()
  })

  it('refuses to provision when signup is disabled and there is no invitation', async () => {
    process.env.DISABLE_SIGNUP = 'true'
    resetEnvCache()
    const address = email('uninvited')
    mock.setUser({ sub: sub('uninvited'), email: address, email_verified: true })

    const { res } = await loginVia()
    expect(locationOf(res)).toBe('/login?error=signup_disabled')
    expect(payloadCookieOf(res)).toBeUndefined()
    expect(await usersWithEmail(address)).toHaveLength(0)
  })

  it('provisions an invited user when signup is disabled and joins the organization', async () => {
    process.env.DISABLE_SIGNUP = 'true'
    resetEnvCache()
    const ownerAddress = email('owner')
    createdUserEmails.add(ownerAddress)
    const owner = await payload.create({
      collection: 'users',
      data: { email: ownerAddress, password: 'password-123' },
      overrideAccess: true,
    })
    const org = (await payload.create({
      collection: 'organizations',
      data: { name: `SSO Org ${run}`, slug: `sso-org-${run}` },
      user: { ...owner, collection: 'users' },
      overrideAccess: true,
    })) as Organization

    const address = email('invited')
    createdUserEmails.add(address)
    await payload.create({
      collection: 'invitations',
      data: { organization: org.id, email: address, role: 'member' },
      overrideAccess: true,
      context: { skipInvitationEmail: true },
    })
    mock.setUser({ sub: sub('invited'), email: address, email_verified: true, name: 'Ivy' })

    const { res } = await loginVia()
    expect(res.status).toBe(303)
    const user = await authenticate(payloadCookieOf(res))
    expect(user?.email).toBe(address)
    expect(user?.authProvider).toBe('oidc')
    const memberships = (user?.organizations ?? []).map((row) => ({
      org: String(typeof row.organization === 'object' ? row.organization.id : row.organization),
      role: row.role,
    }))
    expect(memberships).toContainEqual({ org: String(org.id), role: 'member' })

    const { docs } = await payload.find({
      collection: 'invitations',
      where: { email: { equals: address } },
      overrideAccess: true,
    })
    expect(docs[0]?.status).toBe('accepted')

    await payload.delete({
      collection: 'invitations',
      where: { organization: { equals: org.id } },
      overrideAccess: true,
    })
    await payload.delete({ collection: 'organizations', id: org.id, overrideAccess: true })
  })

  it('refuses to provision when OIDC_AUTO_PROVISION is off', async () => {
    process.env.OIDC_AUTO_PROVISION = 'false'
    resetEnvCache()
    const address = email('manual')
    mock.setUser({ sub: sub('manual'), email: address, email_verified: true })

    const { res } = await loginVia()
    expect(locationOf(res)).toBe('/login?error=provisioning_disabled')
    expect(await usersWithEmail(address)).toHaveLength(0)
  })

  it('refuses identities without an email', async () => {
    mock.setUser({ sub: sub('noemail') })
    const { res } = await loginVia()
    expect(locationOf(res)).toBe('/login?error=email_missing')
  })

  it('logs out: revokes the Payload session and points at the end-session endpoint', async () => {
    const address = email('jane')
    mock.setUser({ sub: sub('jane'), email: address, email_verified: true })
    const { res } = await loginVia()
    const cookie = payloadCookieOf(res) as string
    expect(await authenticate(cookie)).not.toBeNull()

    const logout = await handleOidcLogout(
      new Request('http://localhost:3000/api/auth/oidc/logout', {
        method: 'POST',
        headers: { cookie, accept: 'application/json', origin: 'http://localhost:3000' },
      }),
    )
    expect(logout.status).toBe(200)
    const body = (await logout.json()) as { redirectTo: string }
    const redirectTo = new URL(body.redirectTo)
    expect(`${redirectTo.origin}${redirectTo.pathname}`).toBe(mock.endSessionEndpoint)
    expect(redirectTo.searchParams.get('post_logout_redirect_uri')).toBe(
      'http://localhost:3000/login',
    )
    expect(redirectTo.searchParams.get('client_id')).toBe(mock.clientId)
    expect(logout.headers.getSetCookie().some((c) => c.includes('Expires='))).toBe(true)

    expect(await authenticate(cookie)).toBeNull()
  })
})
