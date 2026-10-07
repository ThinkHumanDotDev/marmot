import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { GET as badgeRoute } from '@/app/status/[slug]/badge.svg/route'
import type { Monitor, Organization, StatusPage } from '@/payload-types'

let payload: Payload

const run = Date.now().toString(36)

const MONITOR_DEFAULTS = {
  type: 'manual' as const,
  active: true,
  interval: 60,
  retryInterval: 60,
  maxRetries: 0,
  resendInterval: 0,
  timeout: 48,
}

type LastStatus = NonNullable<NonNullable<Monitor['status']>['lastStatus']>

let org: Organization
let api: Monitor
let web: Monitor
let page: StatusPage
let draft: StatusPage

async function setStatus(monitor: Monitor, lastStatus: LastStatus | null) {
  await payload.update({
    collection: 'monitors',
    id: monitor.id,
    data: {
      status: lastStatus
        ? { lastStatus, lastCheckAt: new Date().toISOString(), lastPing: 42 }
        : { lastStatus: null, lastCheckAt: null, lastPing: null },
    },
    overrideAccess: true,
    depth: 0,
  })
}

async function badge(slug: string, query = '') {
  const res = await (
    badgeRoute as unknown as (
      req: Request,
      ctx: { params: Promise<{ slug: string }> },
    ) => Promise<Response>
  )(new Request(`http://localhost/status/${slug}/badge.svg${query}`), {
    params: Promise.resolve({ slug }),
  })
  const svg = await res.text()
  return { res, svg, state: /data-state="([a-z]+)"/.exec(svg)?.[1] ?? null }
}

describe('status page badge', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    org = await payload.create({
      collection: 'organizations',
      data: { name: 'Badge Org', slug: `badge-org-${run}` },
      overrideAccess: true,
    })
    api = await payload.create({
      collection: 'monitors',
      data: { ...MONITOR_DEFAULTS, name: 'API', organization: org.id },
      overrideAccess: true,
    })
    web = await payload.create({
      collection: 'monitors',
      data: { ...MONITOR_DEFAULTS, name: 'Web', organization: org.id },
      overrideAccess: true,
    })
    page = await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'Badge Status',
        slug: `badge-${run}`,
        published: true,
        autoRefreshInterval: 120,
        groups: [{ name: 'Core', monitors: [{ monitor: api.id }, { monitor: web.id }] }],
      },
      overrideAccess: true,
    })
    draft = await payload.create({
      collection: 'status-pages',
      data: { organization: org.id, title: 'Badge Draft', slug: `badge-draft-${run}` },
      overrideAccess: true,
    })
  })

  afterAll(async () => {
    if (!org) return
    await payload.delete({ collection: 'maintenance', where: { organization: { equals: org.id } } })
    await payload.delete({
      collection: 'status-pages',
      where: { organization: { equals: org.id } },
    })
    await payload.delete({ collection: 'monitors', where: { organization: { equals: org.id } } })
    await payload.delete({ collection: 'organizations', where: { id: { equals: org.id } } })
  })

  it('is Unknown while no monitor has been checked', async () => {
    await setStatus(api, null)
    await setStatus(web, null)
    const { res, svg, state } = await badge(page.slug)
    expect(res.status).toBe(200)
    expect(state).toBe('unknown')
    expect(svg).toContain('>Unknown</text>')
  })

  it.each([
    ['up', 'up', 'operational', 'All systems operational'],
    ['up', 'down', 'partial', 'Partial outage'],
    ['down', 'down', 'major', 'Major outage'],
    ['up', 'maintenance', 'maintenance', 'Under maintenance'],
  ] as const)('%s + %s → %s', async (a, b, expected, message) => {
    await setStatus(api, a)
    await setStatus(web, b)
    const { svg, state } = await badge(page.slug)
    expect(state).toBe(expected)
    expect(svg).toContain(`>${message}</text>`)
  })

  it('shows a running maintenance window attached to the page', async () => {
    await setStatus(api, 'up')
    await setStatus(web, 'up')
    const window = await payload.create({
      collection: 'maintenance',
      data: {
        organization: org.id,
        title: 'Upgrade',
        strategy: 'manual',
        active: true,
        statusPages: [page.id],
      } as RequiredDataFromCollectionSlug<'maintenance'>,
      overrideAccess: true,
      depth: 0,
    })
    try {
      expect((await badge(page.slug)).state).toBe('maintenance')
    } finally {
      await payload.delete({ collection: 'maintenance', id: window.id, overrideAccess: true })
    }
    expect((await badge(page.slug)).state).toBe('operational')
  })

  it('answers an embeddable SVG cached for the auto-refresh interval', async () => {
    const { res } = await badge(page.slug)
    expect(res.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('public, max-age=120')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('renders the shields style with the monitor badge label', async () => {
    await setStatus(api, 'down')
    await setStatus(web, 'down')
    const { svg } = await badge(page.slug, '?style=flat')
    expect(svg).toContain('Status')
    expect(svg).toContain('Major outage')
    expect(svg).toContain('#c2290a')
    const custom = await badge(page.slug, '?style=for-the-badge&label=Acme')
    expect(custom.svg).toContain('ACME') // for-the-badge upper-cases its text
  })

  it('applies theme, size and variant to the pill', async () => {
    await setStatus(api, 'up')
    await setStatus(web, 'up')
    const { svg } = await badge(page.slug, '?theme=dark&size=xl&variant=outline')
    expect(svg).toContain('height="40"')
    expect(svg).toContain('fill="none" stroke="#66c20a"')
    expect(svg).toContain('fill="#fafafa"')
  })

  it('never exposes monitor names, uptime or response times', async () => {
    const { svg } = await badge(page.slug)
    expect(svg).not.toContain('API')
    expect(svg).not.toContain('Web')
    expect(svg).not.toMatch(/\d+(\.\d+)?%|\d+ ?ms/)
  })

  it('404s with an Unknown badge for drafts and unknown slugs, without caching', async () => {
    for (const slug of [draft.slug, `missing-${run}`]) {
      const { res, state } = await badge(slug)
      expect(res.status).toBe(404)
      expect(state).toBe('unknown')
      expect(res.headers.get('content-type')).toContain('image/svg+xml')
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
  })
})
