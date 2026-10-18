import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest'

import config from '@payload-config'
import { PATCH as patchSubscriberRoute } from '@/app/api/orgs/[orgId]/status-pages/[id]/subscribers/[subscriberId]/route'
import { GET as exportRoute } from '@/app/api/orgs/[orgId]/status-pages/[id]/subscribers/export/route'
import { POST as importRoute } from '@/app/api/orgs/[orgId]/status-pages/[id]/subscribers/import/route'
import { GET as listSubscribersRoute } from '@/app/api/orgs/[orgId]/status-pages/[id]/subscribers/route'
import { POST as accessRoute } from '@/app/api/status-pages/[slug]/access/route'
import { POST as subscribeRoute } from '@/app/api/status-pages/[slug]/subscribe/route'
import { addOrgMembership } from '@/access/memberships'
import type {
  Organization,
  StatusPage,
  StatusPageAudience,
  StatusPageSubscriber,
  StatusPageViewer,
  User,
} from '@/payload-types'
import { closeRateLimitStore } from '@/server/security/rate-limit'
import { resetInstanceSettingsCache } from '@/server/settings'
import {
  accessCookieName,
  checkStatusPageAccess,
  signAccessToken,
} from '@/server/status-pages/access'
import { closeMagicLinkStore, settleMagicLinkDeliveries } from '@/server/status-pages/magic-link'
import { csvSubscriberRows, resolveCsvAudiences } from '@/server/status-pages/subscribers/owner'

/**
 * Audience extras (#278): self sign-ups bound to the viewer and ended when membership is revoked,
 * audiences in the builder's subscriber list and CSV, and the "viewing as" session.
 */
let payload: Payload

const run = Date.now().toString(36)
const BASE = 'http://localhost:3000'
const PASSWORD = 'password-123'
const ACME = `acme-${run}.com`
const alice = `alice@${ACME}`
const carol = `carol@${ACME}`
const dave = `dave@${ACME}`

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>

const call = (
  handler: unknown,
  url: string,
  params: Record<string, string>,
  init: RequestInit = {},
): Promise<Response> =>
  (handler as Handler)(new Request(url, init), { params: Promise.resolve(params) })

let owner: User
let org: Organization
let page: StatusPage
let apiC: string
let docsC: string
let named: StatusPageAudience
let everyone: StatusPageAudience
let ownerHeaders: Record<string, string>
let sendEmail: MockInstance<Payload['sendEmail']>

type RequestUser = User & { collection: 'users' }

async function as(user: { id: User['id'] }): Promise<RequestUser> {
  const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
  return { ...fresh, collection: 'users' }
}

async function signIn(email: string): Promise<{ viewer: StatusPageViewer; cookie: string }> {
  const viewer = (await payload.create({
    collection: 'status-page-viewers',
    data: {
      organization: org.id,
      page: page.id,
      email,
      status: 'active',
    } as RequiredDataFromCollectionSlug<'status-page-viewers'>,
    overrideAccess: true,
  })) as StatusPageViewer
  const fresh = await payload.findByID({
    collection: 'status-pages',
    id: page.id,
    depth: 0,
    overrideAccess: true,
  })
  const token = await signAccessToken(fresh, { viewer: viewer.id })
  return { viewer, cookie: `${accessCookieName(page.id)}=${token}` }
}

async function subscribe(cookie: string, target: string): Promise<StatusPageSubscriber> {
  const res = await call(
    subscribeRoute,
    `${BASE}/api/status-pages/${page.slug}/subscribe`,
    { slug: page.slug },
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ channel: 'email', target }),
    },
  )
  expect(res.status).toBe(202)
  const found = await findSubscriber(target)
  expect(found).not.toBeNull()
  return found!
}

async function findSubscriber(target: string): Promise<StatusPageSubscriber | null> {
  const { docs } = await payload.find({
    collection: 'status-page-subscribers',
    where: { and: [{ statusPage: { equals: page.id } }, { target: { equals: target } }] },
    depth: 0,
    overrideAccess: true,
  })
  return (docs[0] as StatusPageSubscriber | undefined) ?? null
}

const ids = (values: StatusPageSubscriber['audiences']) =>
  (values ?? []).map((a) => String(typeof a === 'object' ? a.id : a)).sort()

const relationId = (value: unknown) =>
  String(typeof value === 'object' && value !== null ? (value as { id: unknown }).id : value)

describe('audience extras (#278)', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    resetInstanceSettingsCache()
    sendEmail = vi.spyOn(payload, 'sendEmail').mockResolvedValue(undefined)

    owner = await payload.create({
      collection: 'users',
      data: { email: `owner+aux-${run}@marmot.test`, password: PASSWORD, name: 'owner' },
    })
    org = await payload.create({
      collection: 'organizations',
      data: { name: 'Audience extras', slug: `aux-${run}` },
      user: await as(owner),
      overrideAccess: false,
    })
    await addOrgMembership({ payload, userId: owner.id, orgId: org.id, role: 'owner' }).catch(
      () => undefined,
    )
    const { token } = await payload.login({
      collection: 'users',
      data: { email: owner.email, password: PASSWORD },
    })
    ownerHeaders = { Cookie: `payload-token=${token}`, Origin: BASE }

    page = await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'Extras status',
        slug: `aux-page-${run}`,
        published: true,
        access: 'audience',
        subscriptions: { enabled: true, channels: ['email'], deliveryMode: 'review' },
        groups: [
          { name: 'Core', monitors: [{ type: 'static', name: 'API' }] },
          { name: 'Shared', monitors: [{ type: 'static', name: 'Docs' }] },
        ],
      } as never,
      overrideAccess: true,
    })
    apiC = String(page.groups?.[0]?.monitors?.[0]?.id)
    docsC = String(page.groups?.[1]?.monitors?.[0]?.id)

    named = await payload.create({
      collection: 'status-page-audiences',
      data: {
        statusPage: page.id,
        organization: org.id,
        name: 'Named people',
        components: [apiC],
        emails: [alice, carol],
      },
      overrideAccess: true,
    })
    everyone = await payload.create({
      collection: 'status-page-audiences',
      data: {
        statusPage: page.id,
        organization: org.id,
        name: 'Everyone at Acme',
        components: [docsC],
        emailDomains: [ACME],
      },
      overrideAccess: true,
    })
  })

  afterAll(async () => {
    sendEmail?.mockRestore()
    await settleMagicLinkDeliveries()
    if (org?.id) {
      await payload.delete({
        collection: 'status-pages',
        where: { organization: { equals: org.id } },
        overrideAccess: true,
      })
      await payload.delete({ collection: 'organizations', id: org.id, overrideAccess: true })
    }
    if (owner?.id) await payload.delete({ collection: 'users', id: owner.id, overrideAccess: true })
    await closeMagicLinkStore()
    await closeRateLimitStore()
  })

  it('names the viewer and their audiences in the session, and signs out', async () => {
    const { viewer, cookie } = await signIn(alice)
    const decision = await checkStatusPageAccess(payload, page, {
      headers: new Headers({ cookie }),
    })
    expect(decision.allowed).toBe(true)
    if (!decision.allowed) return
    expect(decision.viewer).toEqual({ id: viewer.id, email: alice })
    expect([...(decision.audience?.names ?? [])].sort()).toEqual([
      'Everyone at Acme',
      'Named people',
    ])

    const url = `${BASE}/api/status-pages/${page.slug}/access`
    const form = await call(
      accessRoute,
      url,
      { slug: page.slug },
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Host: 'localhost:3000',
          Origin: BASE,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'signout=1',
      },
    )
    expect(form.status).toBe(303)
    expect(form.headers.get('location')).toBe(`/status/${page.slug}/login`)
    expect(form.headers.get('set-cookie')).toMatch(
      new RegExp(`^${accessCookieName(page.id)}=; Max-Age=0;`),
    )
    const json = await call(
      accessRoute,
      url,
      { slug: page.slug },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signout: true }),
      },
    )
    expect(json.status).toBe(200)
    expect(json.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('binds self sign-ups to the viewer and narrows, then ends them as membership shrinks', async () => {
    const { viewer, cookie } = await signIn(carol)
    const subscriber = await subscribe(cookie, carol)
    expect(relationId(subscriber.viewer)).toBe(String(viewer.id))
    expect(ids(subscriber.audiences)).toEqual([String(named.id), String(everyone.id)].sort())

    // An owner-added subscriber has no viewer and is never touched by membership changes.
    const added = await payload.create({
      collection: 'status-page-subscribers',
      data: {
        statusPage: page.id,
        organization: org.id,
        channel: 'email',
        target: `ops-${run}@elsewhere.test`,
        audiences: [named.id],
        source: 'added_by_owner',
      } as RequiredDataFromCollectionSlug<'status-page-subscribers'>,
      overrideAccess: true,
    })

    // Carol leaves the named audience: she keeps the domain-wide one.
    await payload.update({
      collection: 'status-page-audiences',
      id: named.id,
      data: { emails: [alice] },
      overrideAccess: true,
    })
    expect(ids((await findSubscriber(carol))!.audiences)).toEqual([String(everyone.id)])

    // The domain is no longer listed: no audience lists Carol, her subscription ends.
    await payload.update({
      collection: 'status-page-audiences',
      id: everyone.id,
      data: { emailDomains: [] },
      overrideAccess: true,
    })
    expect(await findSubscriber(carol)).toBeNull()
    expect(ids((await findSubscriber(`ops-${run}@elsewhere.test`))!.audiences)).toEqual([
      String(named.id),
    ])

    await payload.update({
      collection: 'status-page-audiences',
      id: everyone.id,
      data: { emailDomains: [ACME] },
      overrideAccess: true,
    })
    await payload.delete({
      collection: 'status-page-subscribers',
      id: added.id,
      overrideAccess: true,
    })
  })

  it('ends a viewer’s subscriptions when the viewer is revoked or their audience deleted', async () => {
    const dana = await signIn(dave)
    await subscribe(dana.cookie, dave)
    await payload.update({
      collection: 'status-page-viewers',
      id: dana.viewer.id,
      data: { status: 'revoked' },
      overrideAccess: true,
    })
    expect(await findSubscriber(dave)).toBeNull()

    const temp = await payload.create({
      collection: 'status-page-audiences',
      data: {
        statusPage: page.id,
        organization: org.id,
        name: 'Temporary',
        components: [docsC],
        emails: [`erin@other-${run}.test`],
      },
      overrideAccess: true,
    })
    const erin = await signIn(`erin@other-${run}.test`)
    await subscribe(erin.cookie, `erin@other-${run}.test`)
    await payload.delete({ collection: 'status-page-audiences', id: temp.id, overrideAccess: true })
    expect(await findSubscriber(`erin@other-${run}.test`)).toBeNull()
  })

  it('lists and edits audiences in the builder, refusing ones that do not list the viewer', async () => {
    const { cookie } = await signIn(`frank@${ACME}`)
    const bound = await subscribe(cookie, `frank@${ACME}`)
    const params = { orgId: String(org.id), id: String(page.id) }
    const base = `${BASE}/api/orgs/${org.id}/status-pages/${page.id}/subscribers`

    const list = await call(listSubscribersRoute, base, params, { headers: ownerHeaders })
    const rows = (
      (await list.json()) as { docs: { id: unknown; audiences: string[]; viewerBound: boolean }[] }
    ).docs
    const row = rows.find((r) => String(r.id) === String(bound.id))
    expect(row).toMatchObject({ audiences: [String(everyone.id)], viewerBound: true })

    const patch = (id: unknown, audiences: string[]) =>
      call(
        patchSubscriberRoute,
        `${base}/${id}`,
        { ...params, subscriberId: String(id) },
        {
          method: 'PATCH',
          headers: { ...ownerHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ audiences }),
        },
      )
    // Frank is not in the named audience.
    expect((await patch(bound.id, [String(named.id)])).status).toBe(400)

    const added = await payload.create({
      collection: 'status-page-subscribers',
      data: {
        statusPage: page.id,
        organization: org.id,
        channel: 'email',
        target: `team-${run}@elsewhere.test`,
        source: 'added_by_owner',
      } as RequiredDataFromCollectionSlug<'status-page-subscribers'>,
      overrideAccess: true,
    })
    const ok = await patch(added.id, [String(named.id), String(everyone.id)])
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { doc: { audiences: string[] } }).doc.audiences.sort()).toEqual(
      [String(named.id), String(everyone.id)].sort(),
    )
  })

  it('exports and imports audiences by name in CSV', async () => {
    const params = { orgId: String(org.id), id: String(page.id) }
    const base = `${BASE}/api/orgs/${org.id}/status-pages/${page.id}/subscribers`
    const csv = await (
      await call(exportRoute, `${base}/export`, params, { headers: ownerHeaders })
    ).text()
    const [header, ...lines] = csv.trim().split('\r\n')
    expect(header).toBe('channel,target,components,source,confirmed_at,audiences')
    const team = lines.find((line) => line.includes(`team-${run}@elsewhere.test`))
    expect(team?.split(',').at(-1)?.split(';').sort()).toEqual(['Everyone at Acme', 'Named people'])

    const file = [
      'channel,target,audiences',
      `email,imported-${run}@elsewhere.test,named people;${everyone.id}`,
      `email,unknown-${run}@elsewhere.test,Nobody`,
      `email,plain-${run}@elsewhere.test,`,
    ].join('\n')
    const res = await call(importRoute, `${base}/import`, params, {
      method: 'POST',
      headers: { ...ownerHeaders, 'content-type': 'text/csv' },
      body: file,
    })
    expect(res.status).toBe(200)
    const report = (await res.json()) as { created: number; skipped: { line: number }[] }
    expect(report.created).toBe(2)
    expect(report.skipped.map((s) => s.line)).toEqual([3])
    expect(ids((await findSubscriber(`imported-${run}@elsewhere.test`))!.audiences)).toEqual(
      [String(named.id), String(everyone.id)].sort(),
    )
    expect(ids((await findSubscriber(`plain-${run}@elsewhere.test`))!.audiences)).toEqual([])
  })

  it('parses the audiences column', () => {
    const rows = csvSubscriberRows('channel,target\nemail,a@b.test\n')
    expect(rows?.[0].audiences).toBeNull()
    const audiences = [
      { id: 1, name: 'Acme' },
      { id: 2, name: '=Formula' },
    ]
    const withColumn = csvSubscriberRows(
      `channel,target,audiences\nemail,a@b.test,"'=Formula;acme"\n`,
    )
    expect(withColumn?.[0].audiences).toEqual(['=Formula', 'acme'])
    expect(resolveCsvAudiences(withColumn![0].audiences!, audiences)).toEqual(['2', '1'])
    expect(resolveCsvAudiences(['3'], audiences)).toBeNull()
  })
})
