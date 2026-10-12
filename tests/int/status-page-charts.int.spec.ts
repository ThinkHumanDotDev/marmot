/**
 * Public latency charts of status page components (#113): opt-in per component, aggregated data
 * from the rollups only, and the page's access control.
 */
import { randomBytes } from 'node:crypto'
import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { GET as chartsRoute } from '@/app/api/status-pages/[slug]/charts/route'
import { GET as publicRoute } from '@/app/api/status-pages/[slug]/public/route'
import { COMPONENT_ID_PATTERN } from '@/lib/status-page-charts'
import { defaultMonitorValues } from '@/lib/validation/monitor'
import type { Location, Monitor, Organization, StatusPage } from '@/payload-types'
import { hashProbeToken } from '@/server/probes/tokens'
import type { PublicComponentChart } from '@/server/status-pages/latency-charts'
import type { PublicMonitor, PublicStatusPageData } from '@/server/status-pages/public'
import { recordLocationHeartbeat } from '@/server/stats/location-stats'
import { recordHeartbeat } from '@/server/stats/uptime-calculator'

let payload: Payload
const run = Date.now().toString(36)
const MINUTE = 60 * 1000
const API_URL = `https://api-internal-${run}.example.com/health`
const PASSWORD = 'correct horse battery'

let org: Organization
let api: Monitor
let web: Monitor
let paused: Monitor
let berlin: Location
let page: StatusPage
let apiRow: string
let webRow: string
let pausedRow: string

type ChartsBody = { range: string; components: PublicComponentChart[] }

async function fetchCharts(slug: string, query = '') {
  return chartsRoute(new Request(`http://localhost/api/status-pages/${slug}/charts${query}`), {
    params: Promise.resolve({ slug }),
  })
}

async function fetchPublic(slug: string): Promise<PublicStatusPageData> {
  const res = await publicRoute(new Request(`http://localhost/api/status-pages/${slug}/public`), {
    params: Promise.resolve({ slug }),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as PublicStatusPageData
}

const componentOf = (data: PublicStatusPageData, componentId: string): PublicMonitor => {
  const found = data.groups.flatMap((g) => g.monitors).find((m) => m.componentId === componentId)
  if (!found) throw new Error(`component ${componentId} missing`)
  return found
}

async function createMonitor(data: Partial<Monitor> & { name: string }): Promise<Monitor> {
  return (await payload.create({
    collection: 'monitors',
    data: {
      ...defaultMonitorValues('http'),
      url: API_URL,
      interval: 60,
      organization: org.id,
      status: { lastStatus: 'up', lastCheckAt: new Date().toISOString() },
      ...data,
    } as never,
    overrideAccess: true,
    depth: 0,
  })) as Monitor
}

/** Monitor-wide beats over the last 45 minutes: pings 10..99 ms and one failed check. */
async function seedBeats(monitor: Monitor) {
  const now = Date.now()
  for (let i = 0; i < 90; i++) {
    await recordHeartbeat(payload, {
      monitorId: monitor.id,
      organizationId: org.id,
      status: 'up',
      ping: 10 + i,
      time: new Date(now - (90 - i) * 30 * 1000),
    })
  }
  await recordHeartbeat(payload, {
    monitorId: monitor.id,
    organizationId: org.id,
    status: 'down',
    ping: null,
    time: new Date(now - 5 * MINUTE),
  })
}

describe('status page latency charts', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    org = await payload.create({
      collection: 'organizations',
      data: { name: 'SPC Acme', slug: `spc-acme-${run}` },
      overrideAccess: true,
    })
    berlin = (await payload.create({
      collection: 'locations',
      data: {
        organization: org.id,
        name: 'Berlin',
        slug: `berlin-${run}`,
        tokenHash: hashProbeToken(`mp_${randomBytes(8).toString('hex')}`),
        tokenPrefix: randomBytes(4).toString('hex'),
      } as never,
      overrideAccess: true,
      depth: 0,
    })) as Location
    api = await createMonitor({
      name: 'Internal API name',
      locations: [berlin.id],
      includeLocal: true,
    })
    web = await createMonitor({ name: 'Website' })
    paused = await createMonitor({ name: 'Paused', active: false })

    // Two locations for the API (Berlin and the local workers), one for the website.
    for (const location of [berlin, null]) {
      for (let i = 0; i < 45; i++) {
        const time = new Date(Date.now() - (45 - i) * MINUTE)
        await recordLocationHeartbeat(payload, {
          monitorId: api.id,
          organizationId: org.id,
          location: location ? String(location.id) : 'local',
          status: 'up',
          ping: location ? 200 + i : 20 + i,
          time,
        })
      }
    }
    await seedBeats(api)
    await seedBeats(web)

    page = await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'SPC Status',
        slug: `spc-${run}`,
        published: true,
        groups: [
          {
            name: 'Core',
            monitors: [
              { monitor: api.id, name: 'API', sendUrl: false, showChart: true },
              { monitor: web.id },
              { monitor: paused.id, showChart: true },
              { type: 'static', name: 'Support' },
            ],
          },
        ],
      },
      depth: 0,
      overrideAccess: true,
    })
    apiRow = String(page.groups?.[0]?.monitors?.[0]?.id)
    webRow = String(page.groups?.[0]?.monitors?.[1]?.id)
    pausedRow = String(page.groups?.[0]?.monitors?.[2]?.id)
  })

  afterAll(async () => {
    await payload.delete({
      collection: 'status-pages',
      where: { organization: { equals: org.id } },
      overrideAccess: true,
    })
    for (const collection of [
      'stat-minutely',
      'stat-hourly',
      'stat-daily',
      'stat-location-hourly',
    ] as const) {
      await payload.delete({
        collection,
        where: { organization: { equals: org.id } },
        overrideAccess: true,
      })
    }
    await payload.delete({
      collection: 'monitors',
      where: { organization: { equals: org.id } },
      overrideAccess: true,
    })
    await payload.delete({
      collection: 'locations',
      where: { organization: { equals: org.id } },
      overrideAccess: true,
    })
  })

  it('is off by default and only flags opted-in monitor components', async () => {
    expect(apiRow).toMatch(COMPONENT_ID_PATTERN)
    expect(page.groups?.[0]?.monitors?.[1]?.showChart).toBe(false)
    expect(page.groups?.[0]?.monitors?.[3]?.showChart).toBe(false)

    const data = await fetchPublic(page.slug)
    expect(componentOf(data, apiRow).showChart).toBe(true)
    expect(componentOf(data, webRow).showChart).toBe(false)
    const support = data.groups[0].monitors.find((m) => m.type === 'static')
    expect(support?.showChart).toBe(false)
  })

  it('serves aggregated charts for opted-in components only', async () => {
    const res = await fetchCharts(page.slug, '?range=1d')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=30')
    const body = (await res.json()) as ChartsBody
    expect(body.range).toBe('1d')
    // The website did not opt in; the paused monitor is hidden from the page altogether.
    expect(body.components.map((c) => c.componentId)).toEqual([apiRow])

    const chart = body.components[0]
    expect(chart.name).toBe('API')
    expect(chart.step).toBe(300)
    expect(chart.series).toHaveLength(288)
    expect(chart.checks).toEqual({ total: 91, up: 90, failed: 1, degraded: 0 })
    expect(chart.uptime).toBeCloseTo(90 / 91, 5)
    // Pings 10..99 ms: the percentiles are estimated within a histogram bucket (about ±19 %).
    expect(chart.percentiles.p50).toBeGreaterThan(45)
    expect(chart.percentiles.p50).toBeLessThan(65)
    expect(chart.percentiles.p99!).toBeGreaterThanOrEqual(chart.percentiles.p95!)
    expect(chart.percentiles.p99!).toBeLessThanOrEqual(99)
    const filled = chart.series.filter((point) => point.up + point.down > 0)
    expect(filled.length).toBeGreaterThan(0)
    expect(Object.keys(filled[0]).sort()).toEqual(
      ['degraded', 'down', 'p50', 'p95', 'p99', 'ping', 'timestamp', 'up'].sort(),
    )
    expect(filled.reduce((sum, point) => sum + point.up + point.down, 0)).toBe(91)

    // Per-location breakdown: names only, Berlin slower than the local workers.
    expect(chart.locations.map((l) => l.name)).toEqual(['Berlin', null])
    const [remote, local] = chart.locations
    expect(remote.avgPing!).toBeGreaterThan(local.avgPing!)
    expect(remote.uptime).toBe(1)
  })

  it('never exposes monitor ids, targets or internal names', async () => {
    const text = await (await fetchCharts(page.slug, '?range=7d')).text()
    expect(text).not.toContain(API_URL)
    expect(text).not.toContain(`api-internal-${run}`)
    expect(text).not.toContain('Internal API name')
    const body = JSON.parse(text) as ChartsBody
    const keys = Object.keys(body.components[0]).sort()
    expect(keys).toEqual(
      [
        'avgPing',
        'checks',
        'componentId',
        'locations',
        'name',
        'percentiles',
        'range',
        'series',
        'status',
        'step',
        'uptime',
      ].sort(),
    )
  })

  it('answers 404 for components without public charts and 400 for unknown ranges', async () => {
    for (const component of [webRow, pausedRow, 'ffffffffffffffffffffffff']) {
      const res = await fetchCharts(page.slug, `?component=${component}`)
      expect(res.status, component).toBe(404)
    }
    const one = await fetchCharts(page.slug, `?component=${apiRow}&range=30d`)
    expect(one.status).toBe(200)
    expect(((await one.json()) as ChartsBody).components).toHaveLength(1)
    expect((await fetchCharts(page.slug, '?range=90d')).status).toBe(400)
    expect((await fetchCharts(`missing-${run}`)).status).toBe(404)
  })

  it('respects showValues and showUptimePercentage', async () => {
    await payload.update({
      collection: 'status-pages',
      id: page.id,
      data: { showUptimePercentage: false },
      overrideAccess: true,
    })
    let body = (await (await fetchCharts(page.slug)).json()) as ChartsBody
    expect(body.components[0].uptime).toBeUndefined()
    expect(body.components[0].locations[0].uptime).toBeUndefined()

    await payload.update({
      collection: 'status-pages',
      id: page.id,
      data: { showValues: false },
      overrideAccess: true,
    })
    body = (await (await fetchCharts(page.slug)).json()) as ChartsBody
    expect(body.components).toEqual([])
    expect(componentOf(await fetchPublic(page.slug), apiRow).showChart).toBe(false)

    await payload.update({
      collection: 'status-pages',
      id: page.id,
      data: { showValues: true, showUptimePercentage: true },
      overrideAccess: true,
    })
  })

  it('follows the access control of a password-protected page', async () => {
    await payload.update({
      collection: 'status-pages',
      id: page.id,
      data: { access: 'password', password: PASSWORD } as Partial<StatusPage>,
      overrideAccess: true,
    })
    try {
      const denied = await fetchCharts(page.slug)
      expect(denied.status).toBe(401)
      expect(await denied.text()).not.toContain('API')

      const allowed = await fetchCharts(page.slug, `?pw=${encodeURIComponent(PASSWORD)}`)
      expect(allowed.status).toBe(200)
      expect(allowed.headers.get('Cache-Control')).not.toContain('public')
      expect(((await allowed.json()) as ChartsBody).components).toHaveLength(1)
    } finally {
      await payload.update({
        collection: 'status-pages',
        id: page.id,
        data: { access: 'public' } as Partial<StatusPage>,
        overrideAccess: true,
      })
    }
  })

  it('serves nothing for unpublished pages', async () => {
    await payload.update({
      collection: 'status-pages',
      id: page.id,
      data: { published: false },
      overrideAccess: true,
    })
    expect((await fetchCharts(page.slug)).status).toBe(404)
    await payload.update({
      collection: 'status-pages',
      id: page.id,
      data: { published: true },
      overrideAccess: true,
    })
  })
})
