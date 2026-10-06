import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import { getUserRole } from '@/access/permissions'
import { POST as lookupRoute } from '@/app/api/auth/sso/lookup/route'
import {
  GET as listConnections,
  POST as createConnection,
} from '@/app/api/orgs/[orgId]/sso/connections/route'
import {
  DELETE as deleteConnection,
  PATCH as patchConnection,
} from '@/app/api/orgs/[orgId]/sso/connections/[id]/route'
import { POST as addDomain } from '@/app/api/orgs/[orgId]/sso/domains/route'
import { POST as parseMetadataRoute } from '@/app/api/orgs/[orgId]/sso/metadata/route'
import {
  handleSamlAcs,
  handleSamlLogin,
  handleSamlMetadata,
  handleSsoCallback,
  handleSsoLogin,
} from '@/auth/sso/handlers'
import { SSO_CONNECTIONS_SLUG } from '@/collections/SsoConnections'
import { SSO_DOMAINS_SLUG } from '@/collections/SsoDomains'
import { env } from '@/env'
import type { Organization, SsoConnection, SsoDomain, User } from '@/payload-types'
import { toDomainRow } from '@/server/sso/domain-rows'
import { lookupSsoForEmail, verifyDomain } from '@/server/sso/domains'

import { startMockIssuer, type MockIssuer } from '../helpers/oidc-issuer'
import {
  buildSamlResponse,
  decodeAuthnRequest,
  encodeResponse,
  IDP_CERT,
  IDP_ENTITY_ID,
  IDP_METADATA,
  IDP_SSO_URL,
} from '../helpers/saml-idp'

let payload: Payload
let issuer: MockIssuer

const run = Date.now().toString(36)
const email = (name: string) => `${name}+ssoconn-${run}@marmot.test`
const PASSWORD = 'password-123'
const DOMAIN = `acme-${run}.test`
const ORIGIN = 'http://localhost:3000'

type Session = { user: User; cookie: string }

let orgA: Organization
let orgB: Organization
let owner: Session
let admin: Session
let member: Session
let outsider: Session
const created: User['id'][] = []

async function createUser(name: string, extra: Record<string, unknown> = {}): Promise<User> {
  const user = await payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name, ...extra },
  })
  created.push(user.id)
  return user
}

async function session(user: User): Promise<Session> {
  const { token } = await payload.login({
    collection: 'users',
    data: { email: user.email, password: PASSWORD },
  })
  return { user, cookie: `${payload.config.cookiePrefix}-token=${token}` }
}

function request(
  url: string,
  init: { method?: string; body?: unknown; session?: Session; cookie?: string } = {},
) {
  return new Request(url, {
    method: init.method ?? 'GET',
    headers: {
      Origin: env.NEXT_PUBLIC_SERVER_URL,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.session ? { cookie: init.session.cookie } : {}),
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
}

const orgParams = (org: Organization) => ({ params: Promise.resolve({ orgId: String(org.id) }) })
const idParams = (org: Organization, id: string | number) => ({
  params: Promise.resolve({ orgId: String(org.id), id: String(id) }),
})

const locationOf = (res: Response) => res.headers.get('location') ?? ''
const sessionCookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${payload.config.cookiePrefix}-token=`))
    ?.split(';')[0]
const txCookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0] as string

async function authenticate(cookie: string | undefined): Promise<User | null> {
  const { user } = await payload.auth({
    headers: new Headers({ cookie: cookie ?? '', origin: ORIGIN }),
  })
  return (user as User | null) ?? null
}

/** Full OIDC login through an organization connection for the issuer's current user. */
async function loginVia(slug: string) {
  const start = await handleSsoLogin(new Request(`${ORIGIN}/api/auth/sso/${slug}/login`), slug)
  if (start.status !== 302) return { res: start }
  const cookie = txCookieOf(start, 'marmot-sso')
  const authorized = await fetch(locationOf(start), { redirect: 'manual' })
  const callbackUrl = new URL(authorized.headers.get('location') ?? '')
  const res = await handleSsoCallback(new Request(callbackUrl, { headers: { cookie } }), slug)
  return { res }
}

describe('per-organization single sign-on', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    issuer = await startMockIssuer()

    const ownerUser = await createUser('owner')
    orgA = (await payload.create({
      collection: 'organizations',
      data: { name: `Acme ${run}`, slug: `acme-${run}` },
      user: { ...ownerUser, collection: 'users' },
      overrideAccess: true,
    })) as Organization
    const otherOwner = await createUser('other-owner')
    orgB = (await payload.create({
      collection: 'organizations',
      data: { name: `Globex ${run}`, slug: `globex-${run}` },
      user: { ...otherOwner, collection: 'users' },
      overrideAccess: true,
    })) as Organization

    const adminUser = await createUser('admin')
    await addOrgMembership({ payload, userId: adminUser.id, orgId: orgA.id, role: 'admin' })
    const memberUser = await createUser('member')
    await addOrgMembership({ payload, userId: memberUser.id, orgId: orgA.id, role: 'member' })

    owner = await session(
      await payload.findByID({ collection: 'users', id: ownerUser.id, overrideAccess: true }),
    )
    admin = await session(
      await payload.findByID({ collection: 'users', id: adminUser.id, overrideAccess: true }),
    )
    member = await session(
      await payload.findByID({ collection: 'users', id: memberUser.id, overrideAccess: true }),
    )
    outsider = await session(
      await payload.findByID({ collection: 'users', id: otherOwner.id, overrideAccess: true }),
    )
  })

  afterAll(async () => {
    await issuer.close()
    for (const org of [orgA, orgB]) {
      await payload.delete({ collection: 'organizations', id: org.id, overrideAccess: true })
    }
    const { docs } = await payload.find({
      collection: 'users',
      where: { email: { like: `+ssoconn-${run}@marmot.test` } },
      limit: 100,
      overrideAccess: true,
    })
    for (const user of docs) {
      await payload.delete({ collection: 'users', id: user.id, overrideAccess: true })
    }
    await payload.delete({
      collection: 'users',
      where: { email: { like: `@${DOMAIN}` } },
      overrideAccess: true,
    })
  })

  const oidcInput = () => ({
    name: 'Corp SSO',
    slug: `corp-${run}`,
    type: 'oidc' as const,
    issuerUrl: issuer.issuer,
    clientId: issuer.clientId,
    clientSecret: issuer.clientSecret,
  })

  describe('connections API', () => {
    it('only owners create connections; admins read them; members and outsiders see nothing', async () => {
      const url = `${ORIGIN}/api/orgs/${orgA.id}/sso/connections`
      expect(
        (
          await createConnection(
            request(url, { method: 'POST', body: oidcInput(), session: member }),
            orgParams(orgA),
          )
        ).status,
      ).toBe(403)
      expect(
        (
          await createConnection(
            request(url, { method: 'POST', body: oidcInput(), session: admin }),
            orgParams(orgA),
          )
        ).status,
      ).toBe(403)
      expect(
        (
          await createConnection(
            request(url, { method: 'POST', body: oidcInput(), session: outsider }),
            orgParams(orgA),
          )
        ).status,
      ).toBe(403)

      const res = await createConnection(
        request(url, { method: 'POST', body: oidcInput(), session: owner }),
        orgParams(orgA),
      )
      expect(res.status).toBe(201)
      const { doc } = (await res.json()) as { doc: Record<string, unknown> }
      expect(doc).toMatchObject({
        slug: `corp-${run}`,
        type: 'oidc',
        enabled: true,
        hasClientSecret: true,
        autoProvision: true,
        defaultRole: 'member',
        callbackUrl: `${ORIGIN}/api/auth/sso/corp-${run}/callback`,
        loginUrl: `${ORIGIN}/api/auth/sso/corp-${run}/login`,
      })
      expect(doc.clientSecret).toBeUndefined()

      // Sealed at rest: the raw row never holds the plaintext.
      const raw = await payload.db.findOne<{
        id: string | number
        client_secret?: string
        clientSecret?: string
      }>({
        collection: SSO_CONNECTIONS_SLUG,
        where: { slug: { equals: `corp-${run}` } },
      })
      const stored = raw?.clientSecret ?? raw?.client_secret
      expect(stored).toMatch(/^v1\./)
      expect(stored).not.toContain(issuer.clientSecret)

      const asAdmin = await listConnections(request(url, { session: admin }), orgParams(orgA))
      expect(asAdmin.status).toBe(200)
      expect(((await asAdmin.json()) as { docs: unknown[] }).docs).toHaveLength(1)
      expect(
        (await listConnections(request(url, { session: member }), orgParams(orgA))).status,
      ).toBe(403)
      expect(
        (await listConnections(request(url, { session: outsider }), orgParams(orgA))).status,
      ).toBe(403)
    })

    it('refuses reserved and duplicate slugs', async () => {
      const url = `${ORIGIN}/api/orgs/${orgA.id}/sso/connections`
      const reserved = await createConnection(
        request(url, { method: 'POST', body: { ...oidcInput(), slug: 'github' }, session: owner }),
        orgParams(orgA),
      )
      expect(reserved.status).toBe(400)
      expect(((await reserved.json()) as { error: string }).error).toMatch(/reserved/)

      const otherOrgUrl = `${ORIGIN}/api/orgs/${orgB.id}/sso/connections`
      const duplicate = await createConnection(
        request(otherOrgUrl, { method: 'POST', body: oidcInput(), session: outsider }),
        orgParams(orgB),
      )
      expect(duplicate.status).toBe(400)
    })
  })

  describe('OIDC connection login', () => {
    it('provisions the user and adds them to the organization with the default role', async () => {
      const address = email('newbie')
      issuer.setUser({
        sub: `newbie-${run}`,
        email: address,
        email_verified: true,
        name: 'New Bee',
      })
      const { res } = await loginVia(`corp-${run}`)
      expect(res.status).toBe(303)
      const user = await authenticate(sessionCookieOf(res))
      expect(user?.email).toBe(address)
      expect(user?.authProvider).toBe('oidc')
      expect(getUserRole(user, orgA.id)).toBe('member')
      expect(getUserRole(user, orgB.id)).toBeNull()
    })

    it('lets a user of another organization join through the connection, keeping their account', async () => {
      const address = email('other-owner')
      issuer.setUser({ sub: `other-owner-${run}`, email: address, email_verified: true })
      const { res } = await loginVia(`corp-${run}`)
      const user = await authenticate(sessionCookieOf(res))
      expect(String(user?.id)).toBe(String(outsider.user.id))
      expect(getUserRole(user, orgB.id)).toBe('owner')
      expect(getUserRole(user, orgA.id)).toBe('member')
    })

    it('honours autoProvision, the default role and the enabled flag', async () => {
      const [connection] = (
        await payload.find({
          collection: SSO_CONNECTIONS_SLUG,
          where: { slug: { equals: `corp-${run}` } },
          overrideAccess: true,
        })
      ).docs as SsoConnection[]
      const url = `${ORIGIN}/api/orgs/${orgA.id}/sso/connections/${connection.id}`

      const patched = await patchConnection(
        request(url, {
          method: 'PATCH',
          body: { autoProvision: false, defaultRole: 'viewer' },
          session: owner,
        }),
        idParams(orgA, connection.id),
      )
      expect(patched.status).toBe(200)
      expect(
        ((await patched.json()) as { doc: { hasClientSecret: boolean } }).doc.hasClientSecret,
      ).toBe(true)

      issuer.setUser({ sub: `stranger-${run}`, email: email('stranger'), email_verified: true })
      expect(locationOf((await loginVia(`corp-${run}`)).res)).toBe(
        '/login?error=provisioning_disabled',
      )

      // Existing users still get in and join with the (new) default role.
      issuer.setUser({ sub: `member-${run}`, email: email('member'), email_verified: true })
      const existing = await loginVia(`corp-${run}`)
      expect(existing.res.status).toBe(303)
      const memberUser = await authenticate(sessionCookieOf(existing.res))
      expect(getUserRole(memberUser, orgA.id)).toBe('member') // already a member: role unchanged

      const disabled = await patchConnection(
        request(url, { method: 'PATCH', body: { enabled: false }, session: owner }),
        idParams(orgA, connection.id),
      )
      expect(disabled.status).toBe(200)
      expect(locationOf((await loginVia(`corp-${run}`)).res)).toBe('/login?error=provider_unknown')
      await patchConnection(
        request(url, {
          method: 'PATCH',
          body: { enabled: true, autoProvision: true },
          session: owner,
        }),
        idParams(orgA, connection.id),
      )
    })
  })

  describe('verified domains and lookup', () => {
    let domain: SsoDomain

    it('owners add a domain and get the DNS record; verification needs the TXT value', async () => {
      const url = `${ORIGIN}/api/orgs/${orgA.id}/sso/domains`
      expect(
        (
          await addDomain(
            request(url, { method: 'POST', body: { domain: DOMAIN }, session: admin }),
            orgParams(orgA),
          )
        ).status,
      ).toBe(403)
      const res = await addDomain(
        request(url, { method: 'POST', body: { domain: DOMAIN.toUpperCase() }, session: owner }),
        orgParams(orgA),
      )
      expect(res.status).toBe(201)
      const { doc } = (await res.json()) as { doc: ReturnType<typeof toDomainRow> }
      expect(doc.domain).toBe(DOMAIN)
      expect(doc.verifiedAt).toBeNull()
      expect(doc.record.name).toBe(`_marmot-verification.${DOMAIN}`)
      expect(doc.record.value).toMatch(/^marmot-verification=[0-9a-f]{32}$/)

      domain = (await payload.findByID({
        collection: SSO_DOMAINS_SLUG,
        id: doc.id,
        overrideAccess: true,
      })) as SsoDomain

      const notFound = await verifyDomain(payload, domain, async () => {
        throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' })
      })
      expect(notFound).toMatchObject({
        verified: false,
        reason: expect.stringMatching(/No TXT record/),
      })
      const wrong = await verifyDomain(payload, domain, async () => [['marmot-verification=other']])
      expect(wrong.verified).toBe(false)
      expect(await lookupSsoForEmail(payload, `someone@${DOMAIN}`)).toEqual([])

      const ok = await verifyDomain(payload, domain, async (name) => {
        expect(name).toBe(doc.record.name)
        return [['unrelated'], [doc.record.value.slice(0, 10), doc.record.value.slice(10)]]
      })
      expect(ok.verified).toBe(true)

      // One organization per domain.
      const claimed = await addDomain(
        request(`${ORIGIN}/api/orgs/${orgB.id}/sso/domains`, {
          method: 'POST',
          body: { domain: DOMAIN },
          session: outsider,
        }),
        orgParams(orgB),
      )
      expect(claimed.status).toBe(400)
      expect(((await claimed.json()) as { error: string }).error).toMatch(/already claimed/)
    })

    it('routes emails on the verified domain and organization slugs to the connections', async () => {
      const byEmail = await lookupRoute(
        request(`${ORIGIN}/api/auth/sso/lookup`, {
          method: 'POST',
          body: { email: `jane@${DOMAIN}` },
        }),
      )
      expect(byEmail.status).toBe(200)
      const { options } = (await byEmail.json()) as {
        options: { id: string; loginPath: string; organization: { slug: string } }[]
      }
      expect(options).toHaveLength(1)
      expect(options[0]).toMatchObject({
        id: `corp-${run}`,
        loginPath: `/api/auth/sso/corp-${run}/login`,
        organization: { slug: orgA.slug },
      })

      const bySlug = await lookupRoute(
        request(`${ORIGIN}/api/auth/sso/lookup`, {
          method: 'POST',
          body: { organization: orgA.slug.toUpperCase() },
        }),
      )
      expect(((await bySlug.json()) as { options: unknown[] }).options).toHaveLength(1)

      const unknown = await lookupRoute(
        request(`${ORIGIN}/api/auth/sso/lookup`, {
          method: 'POST',
          body: { email: 'x@unknown.test' },
        }),
      )
      expect(((await unknown.json()) as { options: unknown[] }).options).toEqual([])
      const empty = await lookupRoute(
        request(`${ORIGIN}/api/auth/sso/lookup`, { method: 'POST', body: {} }),
      )
      expect(((await empty.json()) as { options: unknown[] }).options).toEqual([])
    })

    it('links an existing user by email when the organization verified the domain, even unverified at the IdP', async () => {
      const address = `local-${run}@${DOMAIN}`
      const local = await payload.create({
        collection: 'users',
        data: { email: address, password: PASSWORD, name: 'Local' },
      })
      issuer.setUser({ sub: `local-${run}`, email: address, email_verified: false })
      const { res } = await loginVia(`corp-${run}`)
      expect(res.status).toBe(303)
      const user = await authenticate(sessionCookieOf(res))
      expect(String(user?.id)).toBe(String(local.id))
      // The connection's default role is `viewer` since the previous test changed it.
      expect(getUserRole(user, orgA.id)).toBe('viewer')

      // Same situation on a domain the organization has not verified: refused.
      const foreign = email('foreign')
      await createUser('foreign')
      issuer.setUser({ sub: `foreign-${run}`, email: foreign, email_verified: false })
      expect(locationOf((await loginVia(`corp-${run}`)).res)).toBe('/login?error=email_unverified')
    })
  })

  describe('SAML connection', () => {
    const slug = `corp-saml-${run}`
    const acs = `${ORIGIN}/api/auth/saml/${slug}/acs`
    const metadataUrl = `${ORIGIN}/api/auth/saml/${slug}/metadata`

    it('parses IdP metadata for the form', async () => {
      const res = await parseMetadataRoute(
        request(`${ORIGIN}/api/orgs/${orgA.id}/sso/metadata`, {
          method: 'POST',
          body: { xml: IDP_METADATA },
          session: owner,
        }),
        orgParams(orgA),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        entityId: string
        entryPoint: string
        certificate: string
      }
      expect(body.entityId).toBe(IDP_ENTITY_ID)
      expect(body.entryPoint).toBe(IDP_SSO_URL)
      expect(body.certificate).not.toContain('BEGIN')
      expect(
        (
          await parseMetadataRoute(
            request(`${ORIGIN}/api/orgs/${orgA.id}/sso/metadata`, {
              method: 'POST',
              body: { url: 'http://insecure.test/metadata' },
              session: owner,
            }),
            orgParams(orgA),
          )
        ).status,
      ).toBe(400)
    })

    it('serves SP metadata, signs users in from a signed assertion and joins them to the organization', async () => {
      const res = await createConnection(
        request(`${ORIGIN}/api/orgs/${orgA.id}/sso/connections`, {
          method: 'POST',
          body: {
            name: 'Corp SAML',
            slug,
            type: 'saml',
            idpEntryPoint: IDP_SSO_URL,
            idpEntityId: IDP_ENTITY_ID,
            idpCert: IDP_CERT,
            defaultRole: 'viewer',
          },
          session: owner,
        }),
        orgParams(orgA),
      )
      expect(res.status).toBe(201)
      const { doc } = (await res.json()) as {
        doc: { metadataUrl: string; callbackUrl: string; entityId: string }
      }
      expect(doc).toMatchObject({ metadataUrl, callbackUrl: acs, entityId: metadataUrl })

      const metadata = await handleSamlMetadata(new Request(metadataUrl), slug)
      expect(metadata.status).toBe(200)
      expect(await metadata.text()).toContain(`entityID="${metadataUrl}"`)

      const start = await handleSamlLogin(
        new Request(`${ORIGIN}/api/auth/saml/${slug}/login?next=/${orgA.slug}`),
        slug,
      )
      expect(start.status).toBe(302)
      expect(locationOf(start)).toContain(IDP_SSO_URL)
      const { id } = decodeAuthnRequest(locationOf(start))
      const cookie = txCookieOf(start, 'marmot-saml')

      const address = `saml-user-${run}@${DOMAIN}`
      const { xml } = buildSamlResponse({
        destination: acs,
        audience: metadataUrl,
        inResponseTo: id,
        nameId: address,
        attributes: { displayName: 'Sam L.' },
      })
      const body = new URLSearchParams({ SAMLResponse: encodeResponse(xml), RelayState: slug })
      const login = await handleSamlAcs(
        new Request(acs, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
          body,
        }),
        slug,
      )
      expect(login.status).toBe(303)
      expect(locationOf(login)).toBe(`/${orgA.slug}`)
      const user = await authenticate(sessionCookieOf(login))
      expect(user?.email).toBe(address)
      expect(user?.name).toBe('Sam L.')
      expect(user?.authProvider).toBe('saml')
      expect(getUserRole(user, orgA.id)).toBe('viewer')

      // A response for a request this server never issued is refused.
      const forged = buildSamlResponse({
        destination: acs,
        audience: metadataUrl,
        inResponseTo: '_nope',
        nameId: address,
      })
      const refused = await handleSamlAcs(
        new Request(acs, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
          body: new URLSearchParams({ SAMLResponse: encodeResponse(forged.xml) }),
        }),
        slug,
      )
      expect(locationOf(refused)).toBe('/login?error=exchange_failed')
    })

    it('deletes connections and removes them from the organization', async () => {
      const [connection] = (
        await payload.find({
          collection: SSO_CONNECTIONS_SLUG,
          where: { slug: { equals: slug } },
          overrideAccess: true,
        })
      ).docs
      const res = await deleteConnection(
        request(`${ORIGIN}/api/orgs/${orgA.id}/sso/connections/${connection.id}`, {
          method: 'DELETE',
          session: owner,
        }),
        idParams(orgA, connection.id),
      )
      expect(res.status).toBe(200)
      expect(
        locationOf(
          await handleSamlLogin(new Request(`${ORIGIN}/api/auth/saml/${slug}/login`), slug),
        ),
      ).toBe('/login?error=provider_unknown')
    })
  })
})
