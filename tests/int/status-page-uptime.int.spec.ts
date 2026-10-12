/**
 * Daily uptime bars, calculation modes and preserved history of status pages (#112).
 */
import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { GET as historyRoute } from '@/app/api/orgs/[orgId]/status-pages/[id]/uptime-history/route'
import { GET as publicRoute } from '@/app/api/status-pages/[slug]/public/route'
import { DAY_SECONDS, dayLabel, uptimeOf, utcDayStart } from '@/lib/uptime-history'
import { runRetention } from '@/server/jobs/retention'
import type { PublicMonitor, PublicStatusPageData } from '@/server/status-pages/public'
import {
  loadPageUptime,
  snapshotUptimeHistory,
  type UptimeComponent,
} from '@/server/status-pages/uptime-history'
import type { Monitor, Organization, StatusPage, User } from '@/payload-types'

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+spu-${run}@marmot.test`
const PASSWORD = 'password-123'
const HOUR = 3600 * 1000

const MONITOR_DEFAULTS = {
  type: 'manual' as const,
  active: true,
  interval: 60,
  retryInterval: 60,
  maxRetries: 0,
  resendInterval: 0,
  timeout: 48,
}

const now = new Date()
const today = utcDayStart(now.getTime())
/** Unix seconds of the UTC day `n` days ago. */
const daysAgo = (n: number) => today - n * DAY_SECONDS
const iso = (day: number, hours = 0) => new Date(day * 1000 + hours * HOUR).toISOString()

let owner: User
let member: User
let org: Organization
let monitor: Monitor
let page: StatusPage
let ownerToken: string
let memberToken: string
let monitorRow: string
let staticRow: string

async function fetchPublic(): Promise<PublicStatusPageData> {
  const res = await publicRoute(new Request('http://localhost/api/status-pages/x/public'), {
    params: Promise.resolve({ slug: page.slug }),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as PublicStatusPageData
}

const row = (data: PublicStatusPageData, componentId: string): PublicMonitor => {
  const found = data.groups.flatMap((g) => g.monitors).find((m) => m.componentId === componentId)
  if (!found) throw new Error(`component ${componentId} missing`)
  return found
}

const components = (): UptimeComponent[] => [
  { id: monitorRow, type: 'monitor', monitorId: monitor.id, lastStatus: 'up' },
  { id: staticRow, type: 'static', monitorId: null },
]

describe('status page uptime history', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    owner = await payload.create({
      collection: 'users',
      data: { email: email('owner'), password: PASSWORD, name: 'Owner' },
    })
    member = await payload.create({
      collection: 'users',
      data: { email: email('member'), password: PASSWORD, name: 'Member' },
    })
    org = await payload.create({
      collection: 'organizations',
      data: { name: 'SPU Acme', slug: `spu-acme-${run}` },
      user: { ...owner, collection: 'users' },
      overrideAccess: false,
    })
    await payload.update({
      collection: 'users',
      id: member.id,
      data: { organizations: [{ organization: org.id, role: 'member' }] },
    })
    monitor = await payload.create({
      collection: 'monitors',
      data: {
        ...MONITOR_DEFAULTS,
        name: 'API',
        organization: org.id,
        status: { lastStatus: 'up', lastCheckAt: now.toISOString() },
      },
    })
    page = await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'SPU Status',
        slug: `spu-${run}`,
        published: true,
        groups: [
          {
            name: 'Core',
            monitors: [{ monitor: monitor.id }, { type: 'static', name: 'Support desk' }],
          },
        ],
      },
      depth: 0,
    })
    // The static component's history starts when the page was created; backdate it.
    await payload.db.updateOne({
      collection: 'status-pages',
      id: page.id,
      data: { createdAt: iso(daysAgo(120)) },
      req: {} as never,
    })
    page = await payload.findByID({ collection: 'status-pages', id: page.id, depth: 0 })
    monitorRow = String(page.groups?.[0]?.monitors?.[0]?.id)
    staticRow = String(page.groups?.[0]?.monitors?.[1]?.id)

    // Two days ago: 90 of 100 checks succeeded and the monitor was DOWN from 06:00 to 12:00.
    // Sixty days ago: a clean day (pruned later by retention).
    for (const [day, up, down] of [
      [daysAgo(60), 1440, 0],
      [daysAgo(2), 90, 10],
      [daysAgo(1), 1440, 0],
    ] as const) {
      await payload.create({
        collection: 'stat-daily',
        data: { monitor: monitor.id, organization: org.id, timestamp: day, up, down },
      })
    }
    for (const [time, status] of [
      [iso(daysAgo(10)), 'up'],
      [iso(daysAgo(2), 6), 'down'],
      [iso(daysAgo(2), 12), 'up'],
    ] as const) {
      await payload.create({
        collection: 'heartbeats',
        data: { monitor: monitor.id, organization: org.id, status, time, important: true },
      })
    }
    // A major outage of the monitor component from 00:00 to 03:00 two days ago, and a partial
    // outage of the static component from 00:00 to 12:00 on the same day.
    await payload.create({
      collection: 'incidents',
      data: {
        statusPage: page.id,
        title: 'API outage',
        updates: [
          {
            status: 'investigating',
            message: 'Down.',
            postedAt: iso(daysAgo(2), 0),
            components: [{ component: monitorRow, impact: 'major_outage' }],
          },
          { status: 'resolved', message: 'Fixed.', postedAt: iso(daysAgo(2), 3) },
        ],
      } as RequiredDataFromCollectionSlug<'incidents'>,
      overrideAccess: true,
    })
    await payload.create({
      collection: 'incidents',
      data: {
        statusPage: page.id,
        title: 'Slow support',
        updates: [
          {
            status: 'investigating',
            message: 'Slow.',
            postedAt: iso(daysAgo(2), 0),
            components: [{ component: staticRow, impact: 'partial_outage' }],
          },
          { status: 'resolved', message: 'Fixed.', postedAt: iso(daysAgo(2), 12) },
        ],
      } as RequiredDataFromCollectionSlug<'incidents'>,
      overrideAccess: true,
    })

    const login = async (user: User) =>
      (
        await payload.login({
          collection: 'users',
          data: { email: user.email, password: PASSWORD },
        })
      ).token as string
    ownerToken = await login(owner)
    memberToken = await login(member)
  })

  afterAll(async () => {
    if (org?.id) {
      const where = { organization: { equals: org.id } }
      await payload.delete({ collection: 'heartbeats', where })
      await payload.delete({ collection: 'stat-daily', where })
      await payload.delete({ collection: 'incidents', where })
      await payload.delete({ collection: 'status-pages', where })
      await payload.delete({ collection: 'monitors', where })
      await payload.delete({ collection: 'organizations', id: org.id })
    }
    await payload.delete({ collection: 'users', where: { email: { like: `+spu-${run}@` } } })
  })

  it('renders one bar per day for 30, 45 and 90 days, naming the incidents of the day', async () => {
    for (const days of [30, 45, 90] as const) {
      await payload.update({
        collection: 'status-pages',
        id: page.id,
        data: { uptimeBarDays: days },
      })
      const data = await fetchPublic()
      expect(data.config.uptimeBarDays).toBe(days)
      for (const id of [monitorRow, staticRow]) {
        const bars = row(data, id).days
        expect(bars).toHaveLength(days)
        expect(bars.at(-1)?.date).toBe(dayLabel(today))
      }
    }

    const data = await fetchPublic()
    const api = row(data, monitorRow)
    const outage = api.days.find((d) => d.date === dayLabel(daysAgo(2)))
    expect(outage).toMatchObject({ state: 'down', downtimeSeconds: 6 * 3600 })
    expect(outage?.incidents).toEqual([
      expect.objectContaining({ title: 'API outage', impact: 'major_outage' }),
    ])
    expect(outage?.incidents.map((i) => i.title)).not.toContain('Slow support')
    expect(api.days.find((d) => d.date === dayLabel(daysAgo(1)))?.state).toBe('up')
    // Days without checks have no data.
    expect(api.days.find((d) => d.date === dayLabel(daysAgo(5)))).toMatchObject({
      state: 'nodata',
      uptime: null,
    })

    const support = row(data, staticRow)
    const slow = support.days.find((d) => d.date === dayLabel(daysAgo(2)))
    expect(slow).toMatchObject({ state: 'partial', uptime: 0.75 })
    expect(slow?.incidents.map((i) => i.title)).toEqual(['Slow support'])
  })

  it('changes the displayed uptime deterministically with the calculation mode', async () => {
    const expected = { checks: 0.9, duration: 0.75, manual: 0.875 } as const
    for (const mode of ['checks', 'duration', 'manual'] as const) {
      await payload.update({
        collection: 'status-pages',
        id: page.id,
        data: { uptimeCalculation: mode },
      })
      const data = await fetchPublic()
      expect(data.config.uptimeCalculation).toBe(mode)
      const day = row(data, monitorRow).days.find((d) => d.date === dayLabel(daysAgo(2)))
      expect(day?.uptime).toBeCloseTo(expected[mode], 10)
    }

    // The window figure sums the days with data the same way.
    const uptime = await loadPageUptime(payload, page, components(), {
      now,
      days: [daysAgo(2), daysAgo(1)],
    })
    const totals = uptime.get(monitorRow)?.totals
    if (!totals) throw new Error('no totals')
    expect(uptimeOf('checks', totals)).toBeCloseTo(1530 / 1540, 10)
    expect(uptimeOf('duration', totals)).toBeCloseTo(1 - 6 / 48, 10)
    expect(uptimeOf('manual', totals)).toBeCloseTo(1 - 3 / 48, 10)
  })

  it('hides the percentages when the page turns them off', async () => {
    await payload.update({
      collection: 'status-pages',
      id: page.id,
      data: { showUptimePercentage: false, uptimeCalculation: 'checks' },
    })
    const hidden = row(await fetchPublic(), monitorRow)
    expect(hidden).not.toHaveProperty('uptime')
    expect(hidden.days.every((d) => !('uptime' in d))).toBe(true)
    expect(hidden.days.find((d) => d.date === dayLabel(daysAgo(2)))?.downtimeSeconds).toBe(6 * 3600)

    await payload.update({
      collection: 'status-pages',
      id: page.id,
      data: { showUptimePercentage: true },
    })
    const shown = row(await fetchPublic(), monitorRow)
    expect(typeof shown.uptime).toBe('number')
  })

  it('preserves daily uptime beyond retention through the snapshot job', async () => {
    const first = await snapshotUptimeHistory(payload, { now })
    expect(first.created).toBeGreaterThanOrEqual(3)
    const rows = await payload.find({
      collection: 'status-page-uptime-history',
      where: { statusPage: { equals: page.id } },
      sort: 'timestamp',
      depth: 0,
      limit: 100,
    })
    expect(rows.docs.map((r) => r.day)).toEqual([
      dayLabel(daysAgo(60)),
      dayLabel(daysAgo(2)),
      dayLabel(daysAgo(1)),
    ])
    expect(rows.docs[1]).toMatchObject({
      component: monitorRow,
      month: dayLabel(daysAgo(2)).slice(0, 7),
      up: 90,
      down: 10,
      downSeconds: 6 * 3600,
      knownSeconds: 24 * 3600,
      state: 'down',
    })
    // Idempotent: complete days are written once, today never.
    expect((await snapshotUptimeHistory(payload, { now })).created).toBe(0)

    // Retention keeps 30 days: the 60-day-old statistics go, the snapshot stays.
    await runRetention(payload, now, { keepDataPeriodDays: 30 })
    const pruned = await payload.find({
      collection: 'stat-daily',
      where: { and: [{ monitor: { equals: monitor.id } }, { timestamp: { equals: daysAgo(60) } }] },
      depth: 0,
    })
    expect(pruned.totalDocs).toBe(0)

    await payload.update({ collection: 'status-pages', id: page.id, data: { uptimeBarDays: 90 } })
    const old = row(await fetchPublic(), monitorRow).days.find(
      (d) => d.date === dayLabel(daysAgo(60)),
    )
    expect(old).toMatchObject({ state: 'up', uptime: 1 })

    const fromSnapshot = await loadPageUptime(payload, page, components(), {
      now,
      days: [daysAgo(60), daysAgo(2)],
    })
    expect(fromSnapshot.get(monitorRow)?.days.map((d) => d.source)).toEqual(['snapshot', 'live'])
  })

  it('serves the monthly history to admins only, as JSON and CSV', async () => {
    const call = (token: string, query: string) =>
      historyRoute(
        new Request(
          `http://localhost/api/orgs/${org.id}/status-pages/${page.id}/uptime-history${query}`,
          {
            headers: { authorization: `JWT ${token}` },
          },
        ),
        { params: Promise.resolve({ orgId: String(org.id), id: String(page.id) }) },
      )

    expect((await call(memberToken, '')).status).toBe(403)

    const res = await call(ownerToken, '?months=3')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      mode: string
      months: string[]
      components: { id: string; name: string }[]
      rows: { month: string; componentId: string; uptime: number | null; days: number }[]
    }
    expect(body.mode).toBe('checks')
    expect(body.months).toHaveLength(3)
    expect(body.months[0]).toBe(dayLabel(today).slice(0, 7))
    expect(body.components.map((c) => c.name)).toEqual(['API', 'Support desk'])
    const month = dayLabel(daysAgo(2)).slice(0, 7)
    const api = body.rows.find((r) => r.month === month && r.componentId === monitorRow)
    expect(api?.uptime).not.toBeNull()
    expect(api?.days).toBeGreaterThan(0)

    const csv = await call(ownerToken, '?months=3&format=csv')
    expect(csv.headers.get('content-type')).toContain('text/csv')
    const text = await csv.text()
    expect(text.split('\r\n')[0]).toBe(
      'month,component_id,component,uptime_percent,downtime_seconds,days',
    )
    expect(text).toContain(`${month},${monitorRow},API,`)
  })

  it('removes the preserved history with its page', async () => {
    const extra = await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'SPU Extra',
        slug: `spu-extra-${run}`,
        groups: [{ name: 'Core', monitors: [{ monitor: monitor.id }] }],
      },
      depth: 0,
    })
    await snapshotUptimeHistory(payload, { now })
    const where = { statusPage: { equals: extra.id } }
    expect(
      (await payload.find({ collection: 'status-page-uptime-history', where })).totalDocs,
    ).toBeGreaterThan(0)
    await payload.delete({ collection: 'status-pages', id: extra.id })
    expect(
      (await payload.find({ collection: 'status-page-uptime-history', where })).totalDocs,
    ).toBe(0)
  })
})
