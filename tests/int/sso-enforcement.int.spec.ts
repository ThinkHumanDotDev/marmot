import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import { POST as restPost } from '@/app/(payload)/api/[...slug]/route'
import { PATCH as enforcementRoute } from '@/app/api/orgs/[orgId]/sso/enforcement/route'
import { handlePasswordLogin } from '@/auth/two-factor/handlers'
import { SSO_CONNECTIONS_SLUG } from '@/collections/SsoConnections'
import { SSO_DOMAINS_SLUG } from '@/collections/SsoDomains'
import { env } from '@/env'
import type { Organization, SsoDomain, User } from '@/payload-types'
import { enforcingOrganizationFor, SSO_ENFORCED_MESSAGE } from '@/server/sso/enforcement'
import { refusePasswordReset } from '@/server/sso/local-login'

let payload: Payload

const run = Date.now().toString(36)
const DOMAIN = `enforced-${run}.test`
const PASSWORD = 'password-123'
const ORIGIN = 'http://localhost:3000'

let org: Organization
let owner: User
let member: User
let outsider: User
let ownerCookie: string

const request = (url: string, body: unknown, cookie?: string) =>
  new Request(url, {
    method: 'PATCH',
    headers: {
      Origin: env.NEXT_PUBLIC_SERVER_URL,
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  })

const loginRequest = (email: string) =>
  new Request(`${ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email, password: PASSWORD }),
  })

async function setEnforcement(value: boolean) {
  return enforcementRoute(
    request(`${ORIGIN}/api/orgs/${org.id}/sso/enforcement`, { enforceSso: value }, ownerCookie),
    {
      params: Promise.resolve({ orgId: String(org.id) }),
    },
  )
}

describe('single sign-on enforcement', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    owner = await payload.create({
      collection: 'users',
      data: { email: `owner@${DOMAIN}`, password: PASSWORD, name: 'Owner' },
    })
    org = (await payload.create({
      collection: 'organizations',
      data: { name: `Enforced ${run}`, slug: `enforced-${run}` },
      user: { ...owner, collection: 'users' },
      overrideAccess: true,
    })) as Organization
    member = await payload.create({
      collection: 'users',
      data: { email: `member@${DOMAIN}`, password: PASSWORD, name: 'Member' },
    })
    await addOrgMembership({ payload, userId: member.id, orgId: org.id, role: 'member' })
    outsider = await payload.create({
      collection: 'users',
      data: { email: `outsider-${run}@elsewhere.test`, password: PASSWORD, name: 'Outsider' },
    })
    const { token } = await payload.login({
      collection: 'users',
      data: { email: owner.email, password: PASSWORD },
    })
    ownerCookie = `${payload.config.cookiePrefix}-token=${token}`
  })

  afterAll(async () => {
    await payload.delete({ collection: 'organizations', id: org.id, overrideAccess: true })
    for (const user of [owner, member, outsider]) {
      await payload.delete({ collection: 'users', id: user.id, overrideAccess: true })
    }
  })

  it('cannot be enabled before a domain is verified and a connection enabled', async () => {
    const res = await setEnforcement(true)
    expect(res.status).toBe(409)

    await payload.create({
      collection: SSO_CONNECTIONS_SLUG,
      data: {
        organization: org.id,
        name: 'Corp',
        slug: `enforced-corp-${run}`,
        type: 'oidc',
        issuerUrl: 'https://idp.example.test',
        clientId: 'id',
        clientSecret: 'secret',
      } as never,
      overrideAccess: true,
    })
    const domain = (await payload.create({
      collection: SSO_DOMAINS_SLUG,
      data: { organization: org.id, domain: DOMAIN } as never,
      overrideAccess: true,
    })) as SsoDomain
    expect((await setEnforcement(true)).status).toBe(409) // domain not verified yet

    await payload.update({
      collection: SSO_DOMAINS_SLUG,
      id: domain.id,
      data: { verifiedAt: new Date().toISOString() },
      overrideAccess: true,
    })
    const enabled = await setEnforcement(true)
    expect(enabled.status).toBe(200)
    expect(await enabled.json()).toEqual({ enforceSso: true })
    expect((await enforcingOrganizationFor(payload, `anyone@${DOMAIN}`))?.id).toBe(org.id)
    expect(await enforcingOrganizationFor(payload, 'anyone@elsewhere.test')).toBeNull()
  })

  it('refuses password logins for members on the verified domain, through both login paths', async () => {
    const res = await handlePasswordLogin(loginRequest(member.email))
    expect(res.status).toBe(403)
    expect(((await res.json()) as { errors: { message: string }[] }).errors[0].message).toBe(
      SSO_ENFORCED_MESSAGE,
    )
    await expect(
      payload.login({ collection: 'users', data: { email: member.email, password: PASSWORD } }),
    ).rejects.toThrow(/single sign-on/)
  })

  it('leaves users on other domains alone', async () => {
    const res = await handlePasswordLogin(loginRequest(outsider.email))
    expect(res.status).toBe(200)
  })

  it('lets owners in with a password and records a break-glass audit event', async () => {
    const before = await payload.count({
      collection: 'audit-logs',
      where: {
        and: [{ action: { equals: 'auth.break_glass' } }, { organization: { equals: org.id } }],
      },
      overrideAccess: true,
    })
    const res = await handlePasswordLogin(loginRequest(owner.email))
    expect(res.status).toBe(200)
    const after = await payload.count({
      collection: 'audit-logs',
      where: {
        and: [{ action: { equals: 'auth.break_glass' } }, { organization: { equals: org.id } }],
      },
      overrideAccess: true,
    })
    expect(after.totalDocs).toBe(before.totalDocs + 1)
  })

  it('only resets passwords that could be used afterwards', async () => {
    const forgot = (address: string) =>
      refusePasswordReset({
        args: { data: { email: address } },
        operation: 'forgotPassword',
        req: { payload, payloadAPI: 'REST', searchParams: new URLSearchParams() },
        context: {},
      } as never) as Promise<{ disableEmail?: boolean }>
    // Same answer for everyone; only the owner (break-glass) gets the mail.
    expect((await forgot(member.email)).disableEmail).toBe(true)
    expect((await forgot(owner.email)).disableEmail).toBeUndefined()
    expect((await forgot(outsider.email)).disableEmail).toBeUndefined()

    const token = await payload.forgotPassword({
      collection: 'users',
      data: { email: member.email },
      disableEmail: true,
    })
    const reset = await restPost(
      new Request(`${ORIGIN}/api/users/reset-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ token, password: 'another-password-1' }),
      }),
      { params: Promise.resolve({ slug: ['users', 'reset-password'] }) },
    )
    expect(reset.status).toBe(403)
    // The refused reset changed nothing.
    expect((await handlePasswordLogin(loginRequest(owner.email))).status).toBe(200)
  })

  it('restores password login as soon as enforcement is turned off', async () => {
    expect((await setEnforcement(false)).status).toBe(200)
    const res = await handlePasswordLogin(loginRequest(member.email))
    expect(res.status).toBe(200)
  })
})
