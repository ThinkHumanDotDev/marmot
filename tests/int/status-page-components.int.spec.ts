/**
 * Status page components (#106): static components driven by incident impact and maintenance,
 * public display names, collapsible groups and hidden metrics.
 */
import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { GET as publicRoute } from '@/app/api/status-pages/[slug]/public/route'
import {
  componentDisplayName,
  isContactUrl,
  staticComponentStatus,
  worstImpact,
  worstStatus,
} from '@/lib/status-page-components'
import { impactsByComponent, type PublicStatusPageData } from '@/server/status-pages/public'
import type { Monitor, Organization, StatusPage, User } from '@/payload-types'

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+spc-${run}@marmot.test`

type RequestUser = User & { collection: 'users' }

async function as(user: { id: User['id'] }): Promise<RequestUser> {
  const fresh = await payload.findByID({ collection: 'users', id: user.id, depth: 0 })
  return { ...fresh, collection: 'users' }
}

const MONITOR_DEFAULTS = {
  type: 'manual' as const,
  active: true,
  interval: 60,
  retryInterval: 60,
  maxRetries: 0,
  resendInterval: 0,
  timeout: 48,
}

async function fetchPublic(slug: string): Promise<{ body: PublicStatusPageData; raw: string }> {
  const res = await publicRoute(new Request('http://localhost/api/status-pages/x/public'), {
    params: Promise.resolve({ slug }),
  })
  expect(res.status).toBe(200)
  const raw = await res.text()
  return { body: JSON.parse(raw) as PublicStatusPageData, raw }
}

/** Payload wraps field errors as "The following field is invalid"; the message lives in `data`. */
async function expectValidationError(promise: Promise<unknown>, message: RegExp) {
  const error = await promise.then(
    () => null,
    (err: unknown) => err as { data?: { errors?: { message: string }[] }; message?: string },
  )
  expect(error, 'expected the operation to fail').not.toBeNull()
  const messages = [
    ...(error?.data?.errors?.map((e) => e.message) ?? []),
    String(error?.message ?? ''),
  ]
  expect(
    messages.some((m) => message.test(m)),
    `got ${JSON.stringify(messages)}`,
  ).toBe(true)
}

let owner: User
let org: Organization
let api: Monitor
let web: Monitor
let page: StatusPage

const rowId = (groupIndex: number, rowIndex: number): string =>
  String(page.groups?.[groupIndex]?.monitors?.[rowIndex]?.id)

describe('status page components', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    owner = await payload.create({
      collection: 'users',
      data: { email: email('owner'), password: 'password-123', name: 'Owner' },
    })
    org = await payload.create({
      collection: 'organizations',
      data: { name: 'SPC Acme', slug: `spc-acme-${run}` },
      user: await as(owner),
      overrideAccess: false,
    })
    const status = { lastStatus: 'up' as const, lastCheckAt: new Date().toISOString() }
    api = await payload.create({
      collection: 'monitors',
      data: {
        ...MONITOR_DEFAULTS,
        name: 'prod-api-eu-west-1 /healthz',
        publicName: 'API',
        organization: org.id,
        status,
      },
    })
    web = await payload.create({
      collection: 'monitors',
      data: { ...MONITOR_DEFAULTS, name: 'web-lb-01', organization: org.id, status },
    })
    for (let i = 0; i < 2; i++) {
      await payload.create({
        collection: 'heartbeats',
        data: {
          monitor: api.id,
          organization: org.id,
          status: 'up',
          ping: 120 + i,
          time: new Date(Date.now() - (2 - i) * 60_000).toISOString(),
        },
      })
    }

    page = await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'Components',
        slug: `spc-${run}`,
        published: true,
        homepageUrl: 'https://example.com',
        contactUrl: 'mailto:support@example.com',
        groups: [
          {
            name: 'Services',
            monitors: [
              { monitor: api.id },
              { monitor: web.id, name: 'Website', description: 'Marketing site and docs.' },
            ],
          },
          {
            name: 'People',
            defaultOpen: false,
            monitors: [{ type: 'static', name: 'Customer support', description: 'Mon–Fri' }],
          },
        ],
      },
      user: await as(owner),
      overrideAccess: false,
    })
  })

  afterAll(async () => {
    if (org?.id) {
      const where = { organization: { equals: org.id } }
      await payload.delete({ collection: 'maintenance', where })
      await payload.delete({ collection: 'incidents', where })
      await payload.delete({ collection: 'status-pages', where })
      await payload.delete({ collection: 'heartbeats', where })
      await payload.delete({ collection: 'monitors', where })
      await payload.delete({ collection: 'organizations', where: { id: { equals: org.id } } })
    }
    await payload.delete({ collection: 'users', where: { email: { like: `+spc-${run}@` } } })
  })

  it('defaults keep existing pages unchanged', async () => {
    const plain = await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'Plain',
        slug: `spc-plain-${run}`,
        groups: [{ name: 'Core', monitors: [{ monitor: web.id }] }],
      },
      overrideAccess: true,
    })
    expect(plain.showValues).toBe(true)
    expect(plain.groups?.[0]?.defaultOpen).toBe(true)
    expect(plain.groups?.[0]?.monitors?.[0]).toMatchObject({ type: 'monitor', showValues: true })
  })

  it('shows monitors under their public name, overridable per component', async () => {
    const { body } = await fetchPublic(page.slug)
    expect(body.config).toMatchObject({
      homepageUrl: 'https://example.com',
      contactUrl: 'mailto:support@example.com',
      showValues: true,
    })
    const [services] = body.groups
    expect(services.monitors.map((m) => m.name)).toEqual(['API', 'Website'])
    expect(services.monitors[0]).toMatchObject({
      id: String(api.id),
      componentId: rowId(0, 0),
      type: 'monitor',
      impact: null,
    })
    expect(services.monitors[1].description).toBe('Marketing site and docs.')
    expect(JSON.stringify(body)).not.toContain('prod-api-eu-west-1')
  })

  it('collapsed groups carry defaultOpen and the worst child status', async () => {
    const { body } = await fetchPublic(page.slug)
    expect(body.groups.map((g) => [g.name, g.defaultOpen, g.status])).toEqual([
      ['Services', true, 'up'],
      ['People', false, 'up'],
    ])
    expect(body.groups[1].monitors[0]).toMatchObject({
      type: 'static',
      name: 'Customer support',
      status: 'up',
      impact: null,
      beats: [],
    })
  })

  it('a static component shows a partial outage while an incident marks it so', async () => {
    const incident = await payload.create({
      collection: 'incidents',
      data: {
        statusPage: page.id,
        organization: org.id,
        title: 'Support queue delays',
        affectedComponents: [{ component: rowId(1, 0), impact: 'partial_outage' }],
      },
      user: await as(owner),
      overrideAccess: false,
    })

    const during = (await fetchPublic(page.slug)).body
    const support = during.groups[1].monitors[0]
    expect(support).toMatchObject({ impact: 'partial_outage', status: 'pending' })
    expect(during.groups[1].status).toBe('pending')
    expect(during.overall).toBe('partial')

    await payload.update({
      collection: 'incidents',
      id: incident.id,
      data: { active: false },
      user: await as(owner),
      overrideAccess: false,
    })
    const after = (await fetchPublic(page.slug)).body
    expect(after.groups[1].monitors[0]).toMatchObject({ impact: null, status: 'up' })
    expect(after.overall).toBe('up')
  })

  it('monitor components report incident impact next to their own status', async () => {
    const incident = await payload.create({
      collection: 'incidents',
      data: {
        statusPage: page.id,
        organization: org.id,
        title: 'API latency',
        affectedComponents: [{ component: rowId(0, 0), impact: 'degraded_performance' }],
      },
      overrideAccess: true,
    })
    const { body } = await fetchPublic(page.slug)
    expect(body.groups[0].monitors[0]).toMatchObject({
      status: 'up',
      impact: 'degraded_performance',
    })
    await payload.delete({ collection: 'incidents', id: incident.id })
  })

  it('static components follow running maintenance attached to the page', async () => {
    const maintenance = await payload.create({
      collection: 'maintenance',
      data: {
        organization: org.id,
        title: 'Office move',
        strategy: 'manual',
        active: true,
        statusPages: [page.id],
      } as never,
      overrideAccess: true,
    })
    const { body } = await fetchPublic(page.slug)
    expect(body.groups[1].monitors[0].status).toBe('maintenance')
    await payload.delete({ collection: 'maintenance', id: maintenance.id })
  })

  it('rejects incidents that reference components of another page', async () => {
    await expectValidationError(
      payload.create({
        collection: 'incidents',
        data: {
          statusPage: page.id,
          organization: org.id,
          title: 'Bogus',
          affectedComponents: [{ component: 'not-a-component', impact: 'major_outage' }],
        },
        user: await as(owner),
        overrideAccess: false,
      }),
      /belong to the status page/i,
    )
  })

  it('hides uptime and latency from the public JSON when showValues is off', async () => {
    // Per component first: the API row hides its values, the page still shows them.
    const groups = (page.groups ?? []).map((group, gi) => ({
      ...group,
      monitors: (group.monitors ?? []).map((row, ri) =>
        gi === 0 && ri === 0 ? { ...row, showValues: false } : row,
      ),
    }))
    page = await payload.update({
      collection: 'status-pages',
      id: page.id,
      data: { groups },
      user: await as(owner),
      overrideAccess: false,
    })
    // Row ids survive the update, so incidents keep pointing at the same components.
    expect(rowId(0, 0)).toBe(String(groups[0].monitors[0].id))

    const perComponent = (await fetchPublic(page.slug)).body
    const apiRow = perComponent.groups[0].monitors[0]
    expect(apiRow.showValues).toBe(false)
    expect(apiRow).not.toHaveProperty('uptime24h')
    expect(apiRow).not.toHaveProperty('uptime30d')
    expect(apiRow.beats.length).toBe(2)
    expect(apiRow.beats.every((b) => !('ping' in b))).toBe(true)
    expect(typeof perComponent.groups[0].monitors[1].uptime24h).toBe('number')

    await payload.update({
      collection: 'status-pages',
      id: page.id,
      data: { showValues: false },
      user: await as(owner),
      overrideAccess: false,
    })
    const { body, raw } = await fetchPublic(page.slug)
    expect(body.config.showValues).toBe(false)
    expect(raw).not.toContain('uptime24h')
    expect(raw).not.toContain('uptime30d')
    expect(raw).not.toContain('"ping"')
  })

  it('validates static components and header links', async () => {
    await expectValidationError(
      payload.update({
        collection: 'status-pages',
        id: page.id,
        data: { groups: [{ name: 'Bad', monitors: [{ type: 'static' }] }] },
        user: await as(owner),
        overrideAccess: false,
      }),
      /needs a name/i,
    )
    await expectValidationError(
      payload.update({
        collection: 'status-pages',
        id: page.id,
        data: { groups: [{ name: 'Bad', monitors: [{ type: 'monitor' }] }] },
        user: await as(owner),
        overrideAccess: false,
      }),
      /pick a monitor/i,
    )
    await expectValidationError(
      payload.update({
        collection: 'status-pages',
        id: page.id,
        data: { contactUrl: 'javascript:alert(1)' },
        user: await as(owner),
        overrideAccess: false,
      }),
      /mailto/i,
    )
    await expectValidationError(
      payload.update({
        collection: 'status-pages',
        id: page.id,
        data: { homepageUrl: 'ftp://example.com' },
        user: await as(owner),
        overrideAccess: false,
      }),
      /http/i,
    )
    // A static row never keeps a monitor reference.
    const updated = await payload.update({
      collection: 'status-pages',
      id: page.id,
      data: {
        groups: [
          { name: 'Static', monitors: [{ type: 'static', name: 'Phones', monitor: api.id }] },
        ],
      },
      user: await as(owner),
      overrideAccess: false,
    })
    expect(updated.groups?.[0]?.monitors?.[0]?.monitor ?? null).toBeNull()
  })

  describe('helpers', () => {
    it('picks the worst impact and status', () => {
      expect(worstImpact([])).toBeNull()
      expect(worstImpact(['degraded_performance', 'major_outage', 'partial_outage'])).toBe(
        'major_outage',
      )
      expect(worstStatus(['up', 'maintenance', 'pending'])).toBe('pending')
      expect(worstStatus(['up', 'down', 'unknown'])).toBe('down')
      expect(worstStatus([])).toBe('unknown')
    })

    it('derives static status from impact before maintenance', () => {
      expect(staticComponentStatus(null, false)).toBe('up')
      expect(staticComponentStatus('operational', true)).toBe('maintenance')
      expect(staticComponentStatus('major_outage', true)).toBe('down')
      expect(staticComponentStatus('degraded_performance', false)).toBe('pending')
    })

    it('ignores resolved incidents when collecting impacts', () => {
      const impacts = impactsByComponent([
        { active: true, affectedComponents: [{ component: 'a', impact: 'partial_outage' }] },
        { active: true, affectedComponents: [{ component: 'a', impact: 'major_outage' }] },
        { active: false, affectedComponents: [{ component: 'b', impact: 'major_outage' }] },
      ])
      expect(Object.fromEntries(impacts)).toEqual({ a: 'major_outage' })
    })

    it('resolves display names and contact links', () => {
      expect(componentDisplayName(' ', { name: 'internal', publicName: 'Public' })).toBe('Public')
      expect(componentDisplayName('Override', { name: 'internal', publicName: 'Public' })).toBe(
        'Override',
      )
      expect(componentDisplayName(null, { name: 'internal', publicName: null })).toBe('internal')
      expect(isContactUrl('mailto:help@example.com')).toBe(true)
      expect(isContactUrl('https://example.com/help')).toBe(true)
      expect(isContactUrl('javascript:alert(1)')).toBe(false)
    })
  })
})
