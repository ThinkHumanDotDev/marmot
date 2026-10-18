/**
 * Provider imports (#120, #283): Atlassian Statuspage, Better Stack, Instatus and Checkly, driven
 * by hand-written fixtures
 * of their documented API responses (`tests/fixtures/providers`). `fetch` is stubbed: the tests
 * never reach the vendors.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getPayload, type Payload } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import type { Role } from '@/access/permissions'
import { POST as providerRoute } from '@/app/api/orgs/[orgId]/import/providers/[provider]/route'
import { env, resetEnvCache } from '@/env'
import type { ImportReport } from '@/lib/import-export'
import type {
  Incident,
  Maintenance,
  Monitor,
  Organization,
  StatusPage,
  StatusPageSubscriber,
  User,
} from '@/payload-types'

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+prov-${run}@marmot.test`
const PASSWORD = 'password-123'
const STATUSPAGE_KEY = `sp-secret-${run}-0123456789abcdef`
const BETTERSTACK_TOKEN = `bs-secret-${run}-fedcba9876543210`
const INSTATUS_KEY = `is-secret-${run}-0a1b2c3d4e5f6789`
const CHECKLY_KEY = `cu_secret_${run}_9f8e7d6c5b4a3210`
const CHECKLY_ACCOUNT = '5f1c6e1a-2b3c-4d5e-8f90-a1b2c3d4e5f6'

type Session = { user: User; cookie: string }

const fixture = (provider: string, name: string): unknown =>
  JSON.parse(
    readFileSync(
      path.join(process.cwd(), 'tests/fixtures/providers', provider, `${name}.json`),
      'utf8',
    ),
  )

async function createMember(name: string, orgs: [Organization, Role][]): Promise<Session> {
  const user = await payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name },
  })
  for (const [org, role] of orgs) {
    await addOrgMembership({ payload, userId: user.id, orgId: org.id, role })
  }
  const { token } = await payload.login({
    collection: 'users',
    data: { email: email(name), password: PASSWORD },
  })
  return { user, cookie: `payload-token=${token}` }
}

const SP = 'https://api.statuspage.io/v1'
const BS = 'https://uptime.betterstack.com/api/v2'
const IS = 'https://api.instatus.com'
const CK = 'https://api.checklyhq.com/v1'

const statuspageRoutes = (): Record<string, unknown> => {
  const page = `${SP}/pages/kctbh9vrtdwd`
  const list = '?page=1&per_page=100'
  return {
    [page]: fixture('statuspage', 'page'),
    [`${page}/components${list}`]: fixture('statuspage', 'components'),
    [`${page}/incidents${list}`]: fixture('statuspage', 'incidents'),
    [`${page}/subscribers${list}`]: fixture('statuspage', 'subscribers'),
  }
}

const betterStackRoutes = (): Record<string, unknown> => {
  const page = `${BS}/status-pages/123`
  return {
    [`${BS}/monitors`]: fixture('betterstack', 'monitors'),
    [`${BS}/monitors?page=2`]: fixture('betterstack', 'monitors-page-2'),
    [page]: fixture('betterstack', 'status-page'),
    [`${page}/sections`]: fixture('betterstack', 'sections'),
    [`${page}/resources`]: fixture('betterstack', 'resources'),
    [`${page}/status-reports`]: fixture('betterstack', 'status-reports'),
    [`${page}/status-reports/801/status-updates`]: fixture('betterstack', 'status-updates-801'),
  }
}

const instatusRoutes = (): Record<string, unknown> => {
  const page = 'ckp0page000acme0000000001'
  const list = '?page=1&per_page=100'
  return {
    [`${IS}/v2/pages${list}`]: fixture('instatus', 'pages'),
    [`${IS}/v2/${page}/components${list}`]: fixture('instatus', 'components'),
    [`${IS}/v1/${page}/incidents${list}`]: fixture('instatus', 'incidents'),
    [`${IS}/v2/${page}/maintenances${list}`]: fixture('instatus', 'maintenances'),
    [`${IS}/v2/${page}/subscribers${list}`]: fixture('instatus', 'subscribers'),
  }
}

const checklyRoutes = (): Record<string, unknown> => ({
  [`${CK}/checks?limit=100&page=1`]: fixture('checkly', 'checks'),
})

/** Stubs `fetch` with recorded responses; unknown URLs answer 404. Returns the recorded calls. */
function stubApi(routes: Record<string, unknown>, status = 200) {
  const calls: { url: string; authorization: string | null; account: string | null }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      calls.push({
        url,
        authorization: headers.get('authorization'),
        account: headers.get('x-checkly-account'),
      })
      if (status !== 200) return Response.json({ error: 'nope' }, { status })
      if (!(url in routes)) return Response.json({ error: 'not found' }, { status: 404 })
      return Response.json(routes[url])
    }),
  )
  return calls
}

/** Every log line written while `fn` runs, serialised. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const lines: string[] = []
  const methods = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
  const spies = methods.map((method) =>
    vi.spyOn(payload.logger, method).mockImplementation(((...args: unknown[]) => {
      // Log arguments may be circular (driver errors): serialise what can be, never throw.
      const seen = new WeakSet<object>()
      try {
        lines.push(
          JSON.stringify(args, (_key, value: unknown) => {
            if (value instanceof Error) return `${value.name}: ${value.message}`
            if (value && typeof value === 'object') {
              if (seen.has(value)) return '[circular]'
              seen.add(value)
            }
            return value
          }),
        )
      } catch {
        lines.push(args.map(String).join(' '))
      }
    }) as never),
  )
  try {
    return { result: await fn(), logs: lines.join('\n') }
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
}

function importFrom(
  org: Organization,
  provider: string,
  body: unknown,
  session?: Session,
  dryRun = false,
) {
  return providerRoute(
    new Request(
      `http://localhost/api/orgs/${org.id}/import/providers/${provider}${dryRun ? '?dryRun=1' : ''}`,
      {
        method: 'POST',
        headers: {
          Origin: env.NEXT_PUBLIC_SERVER_URL,
          'content-type': 'application/json',
          ...(session ? { cookie: session.cookie } : {}),
        },
        body: JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ orgId: String(org.id), provider }) },
  )
}

const statuspageBody = (resources = ['components', 'incidents', 'maintenance', 'subscribers']) => ({
  credentials: { apiKey: STATUSPAGE_KEY, pageId: 'kctbh9vrtdwd' },
  resources,
})

const betterStackBody = (resources = ['monitors', 'components', 'incidents', 'maintenance']) => ({
  credentials: { apiToken: BETTERSTACK_TOKEN, statusPageId: '123' },
  resources,
})

const instatusBody = (
  resources = ['components', 'incidents', 'maintenance', 'subscribers'],
  pageId = 'acme-instatus',
) => ({ credentials: { apiKey: INSTATUS_KEY, pageId }, resources })

const checklyBody = (accountId = CHECKLY_ACCOUNT) => ({
  credentials: { apiKey: CHECKLY_KEY, accountId },
  resources: ['monitors'],
})

const count = (
  collection: 'monitors' | 'status-pages' | 'incidents' | 'maintenance' | 'status-page-subscribers',
  org: Organization,
) =>
  payload
    .count({ collection, where: { organization: { equals: org.id } }, overrideAccess: true })
    .then((r) => r.totalDocs)

const idOf = (value: unknown): string =>
  String(
    value && typeof value === 'object' && 'id' in value ? (value as { id: unknown }).id : value,
  )

/** Component (row) ids of a page by their public name. */
const rowIds = (page: StatusPage): Map<string, string> =>
  new Map(
    (page.groups ?? []).flatMap((group) =>
      (group.monitors ?? []).map((row) => [String(row.name), String(row.id)] as const),
    ),
  )

let orgA: Organization
let orgB: Organization
let orgC: Organization
let orgD: Organization
let orgE: Organization
let owner: Session
let member: Session
let viewer: Session

describe('provider imports', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    const mk = (name: string, slug: string) =>
      payload.create({ collection: 'organizations', data: { name, slug: `${slug}-${run}` } })
    orgA = await mk('Prov A', 'prov-a')
    orgB = await mk('Prov B', 'prov-b')
    orgC = await mk('Prov C', 'prov-c')
    orgD = await mk('Prov D', 'prov-d')
    orgE = await mk('Prov E', 'prov-e')
    owner = await createMember('owner', [
      [orgA, 'owner'],
      [orgB, 'owner'],
      [orgC, 'owner'],
      [orgD, 'owner'],
      [orgE, 'owner'],
    ])
    member = await createMember('member', [[orgC, 'member']])
    viewer = await createMember('viewer', [[orgA, 'viewer']])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    vi.unstubAllGlobals()
  })

  describe('access', () => {
    it('requires a session and monitor:create', async () => {
      const calls = stubApi(statuspageRoutes())
      expect((await importFrom(orgA, 'statuspage', statuspageBody())).status).toBe(401)
      expect((await importFrom(orgA, 'statuspage', statuspageBody(), viewer)).status).toBe(403)
      // Nothing was read from the provider either.
      expect(calls).toHaveLength(0)
      expect(await count('status-pages', orgA)).toBe(0)
    })

    it('answers 404 for an unknown provider and 400 without resources or credentials', async () => {
      stubApi(statuspageRoutes())
      expect((await importFrom(orgA, 'pingdom', statuspageBody(), owner)).status).toBe(404)
      expect((await importFrom(orgA, 'statuspage', statuspageBody([]), owner)).status).toBe(400)
      const missing = await importFrom(
        orgA,
        'statuspage',
        { credentials: { pageId: 'kctbh9vrtdwd' }, resources: ['components'] },
        owner,
      )
      expect(missing.status).toBe(400)
    })

    it('is refused in demo mode', async () => {
      const saved = process.env.DEMO_MODE
      process.env.DEMO_MODE = 'true'
      resetEnvCache()
      try {
        const calls = stubApi(statuspageRoutes())
        const res = await importFrom(orgA, 'statuspage', statuspageBody(), owner)
        expect(res.status).toBe(403)
        expect(calls).toHaveLength(0)
      } finally {
        if (saved === undefined) delete process.env.DEMO_MODE
        else process.env.DEMO_MODE = saved
        resetEnvCache()
      }
    })

    it('reports a rejected key without logging it or writing anything', async () => {
      stubApi(statuspageRoutes(), 401)
      const { result, logs } = await captureLogs(() =>
        importFrom(orgA, 'statuspage', statuspageBody(), owner),
      )
      expect(result.status).toBe(400)
      const body = (await result.json()) as { errors: { message: string }[] }
      expect(body.errors[0].message).toMatch(/Atlassian Statuspage rejected the API key/)
      expect(JSON.stringify(body)).not.toContain(STATUSPAGE_KEY)
      expect(logs).not.toContain(STATUSPAGE_KEY)
      expect(await count('status-pages', orgA)).toBe(0)
    })

    it('members import, but parts their role may not create are skipped', async () => {
      // A member holds status-page, maintenance and subscriber rights: everything is imported.
      stubApi(statuspageRoutes())
      const res = await importFrom(orgC, 'statuspage', statuspageBody(), member, true)
      expect(res.status).toBe(200)
      const report = (await res.json()) as ImportReport
      expect(report.statusPages.create).toBe(1)
      expect(report.subscribers.create).toBe(4)
      // Writes go through access control: a member of another org cannot target this one.
      stubApi(statuspageRoutes())
      expect((await importFrom(orgA, 'statuspage', statuspageBody(), member)).status).toBe(403)
    })
  })

  describe('Atlassian Statuspage', () => {
    it('previews counts and every skipped item with a reason, without writing', async () => {
      const calls = stubApi(statuspageRoutes())
      const res = await importFrom(orgA, 'statuspage', statuspageBody(), owner, true)
      expect(res.status).toBe(200)
      const report = (await res.json()) as ImportReport
      expect(report.format).toBe('statuspage')
      expect(report.dryRun).toBe(true)
      expect(report.statusPages.create).toBe(1)
      expect(report.incidents.create).toBe(2)
      expect(report.maintenance).toMatchObject({
        create: 1,
        skipped: [
          {
            name: 'Network maintenance',
            reason: 'Finished maintenance windows are not imported',
          },
        ],
      })
      expect(report.subscribers.create).toBe(4)
      expect(report.subscribers.skipped.map((item) => item.reason).sort()).toEqual(
        [
          'Duplicate subscription',
          'Not a valid sms address',
          'Quarantined by the source (deliveries bounced)',
          'slack subscriptions are not supported',
        ].sort(),
      )
      // Addresses are masked in the report.
      expect(JSON.stringify(report)).not.toContain('gone@customer.example')
      expect(report.warnings.some((w) => w.includes('imported unpublished'))).toBe(true)

      // The key went to the Statuspage API only, in the Authorization header.
      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) {
        expect(call.url.startsWith(SP)).toBe(true)
        expect(call.url).not.toContain(STATUSPAGE_KEY)
        expect(call.authorization).toBe(`OAuth ${STATUSPAGE_KEY}`)
      }
      expect(await count('status-pages', orgA)).toBe(0)
      expect(await count('incidents', orgA)).toBe(0)
    })

    it('only reads and imports the chosen resources', async () => {
      const calls = stubApi(statuspageRoutes())
      const res = await importFrom(orgA, 'statuspage', statuspageBody(['components']), owner, true)
      const report = (await res.json()) as ImportReport
      expect(report.statusPages.create).toBe(1)
      expect(report.incidents.create).toBe(0)
      expect(report.subscribers.create).toBe(0)
      expect(calls.some((call) => call.url.includes('/subscribers'))).toBe(false)
      expect(calls.some((call) => call.url.includes('/incidents'))).toBe(false)
    })

    it('imports page, components, incident history, maintenance and subscribers', async () => {
      stubApi(statuspageRoutes())
      const { result: res, logs } = await captureLogs(() =>
        importFrom(orgA, 'statuspage', statuspageBody(), owner),
      )
      expect(res.status).toBe(201)
      const report = (await res.json()) as ImportReport
      expect(report.statusPages.created).toHaveLength(1)
      expect(logs).not.toContain(STATUSPAGE_KEY)

      const page = await payload.findByID({
        collection: 'status-pages',
        id: report.statusPages.created![0],
        depth: 0,
        overrideAccess: true,
      })
      expect(page.title).toBe('Acme Cloud')
      expect(page.slug.startsWith('acmecloud')).toBe(true)
      expect(page.published).toBe(false)
      expect(page.description).toBe('Live status of the Acme Cloud platform')
      expect(page.homepageUrl).toBe('https://acme-cloud.example')
      expect(page.contactUrl).toBe('https://acme-cloud.example/support')
      expect(page.groups?.map((g) => [g.name, g.monitors?.map((row) => row.name)])).toEqual([
        ['Services', ['Website']],
        ['Core platform', ['API', 'Dashboard']],
      ])
      expect(page.groups?.[1].monitors?.[0]).toMatchObject({
        type: 'static',
        description: 'REST and GraphQL API',
      })
      const rows = rowIds(page)

      const { docs: incidents } = await payload.find({
        collection: 'incidents',
        where: { statusPage: { equals: page.id } },
        sort: 'createdAt',
        depth: 0,
        overrideAccess: true,
      })
      expect(incidents.map((i: Incident) => i.title)).toEqual([
        'API returning errors',
        'Slow dashboard',
      ])
      const [outage, ongoing] = incidents as Incident[]
      expect(new Date(outage.createdAt).toISOString()).toBe('2026-09-14T08:02:11.000Z')
      expect(outage.status).toBe('resolved')
      expect(outage.active).toBe(false)
      expect(outage.updates?.map((u) => u.status)).toEqual([
        'investigating',
        'identified',
        'resolved',
      ])
      expect(outage.updates?.[0].message).toBe(
        'We are investigating elevated error rates on the API.',
      )
      // Impacts point at the imported component; the deleted component is dropped.
      expect(outage.updates?.[0].components).toEqual([
        expect.objectContaining({ component: rows.get('API'), impact: 'major_outage' }),
      ])
      expect(outage.affectedComponents).toEqual([
        expect.objectContaining({ component: rows.get('API'), impact: 'operational' }),
      ])
      expect(ongoing.status).toBe('monitoring')
      expect(ongoing.active).toBe(true)
      expect(ongoing.affectedComponents).toEqual([
        expect.objectContaining({
          component: rows.get('Dashboard'),
          impact: 'degraded_performance',
        }),
      ])

      const { docs: windows } = await payload.find({
        collection: 'maintenance',
        where: { organization: { equals: orgA.id } },
        depth: 0,
        overrideAccess: true,
      })
      expect(windows).toHaveLength(1)
      expect(windows[0] as Maintenance).toMatchObject({
        title: 'Database upgrade',
        strategy: 'single',
        timezone: 'UTC',
        dateRange: { start: '2099-01-10T02:00', end: '2099-01-10T04:30' },
      })
      expect(windows[0].description).toMatch(/upgrade the primary database/)
      expect((windows[0].statusPages ?? []).map(idOf)).toEqual([String(page.id)])

      const { docs: subscribers } = await payload.find({
        collection: 'status-page-subscribers',
        where: { statusPage: { equals: page.id } },
        sort: 'target',
        depth: 0,
        overrideAccess: true,
      })
      const byTarget = new Map(
        (subscribers as StatusPageSubscriber[]).map((s) => [s.target, s] as const),
      )
      expect([...byTarget.keys()].sort()).toEqual(
        [
          '+14155550123',
          'https://hooks.customer.example/statuspage',
          'ops.lead@customer.example',
          'status@partner.example',
        ].sort(),
      )
      for (const subscriber of subscribers as StatusPageSubscriber[]) {
        expect(subscriber.source).toBe('import')
        expect(subscriber.confirmedAt).toBeTruthy()
      }
      expect(byTarget.get('ops.lead@customer.example')?.components).toEqual([rows.get('API')])
      expect(byTarget.get('status@partner.example')?.components ?? []).toEqual([])
      expect(
        [...(byTarget.get('https://hooks.customer.example/statuspage')?.components ?? [])].sort(),
      ).toEqual([rows.get('Dashboard'), rows.get('Website')].sort())
      // Opt-ins are not re-sent and the history is not announced again.
      const { totalDocs: deliveries } = await payload.count({
        collection: 'subscriber-notifications',
        where: { statusPage: { equals: page.id } },
        overrideAccess: true,
      })
      expect(deliveries).toBe(0)

      // The key is stored nowhere.
      const stored = JSON.stringify({ page, incidents, windows, subscribers, report })
      expect(stored).not.toContain(STATUSPAGE_KEY)
      const { docs: audit } = await payload.find({
        collection: 'audit-logs',
        where: {
          and: [{ organization: { equals: orgA.id } }, { action: { equals: 'import.completed' } }],
        },
        depth: 0,
        overrideAccess: true,
      })
      expect(audit).toHaveLength(1)
      expect(JSON.stringify(audit)).not.toContain(STATUSPAGE_KEY)
    })

    it('rolls back everything when a write fails', async () => {
      stubApi(statuspageRoutes())
      const create = payload.create.bind(payload)
      vi.spyOn(payload, 'create').mockImplementation((async (options: { collection: string }) => {
        if (options.collection === 'status-page-subscribers') throw new Error('disk full')
        return create(options as never)
      }) as never)
      const res = await importFrom(orgB, 'statuspage', statuspageBody(), owner)
      expect(res.status).toBeGreaterThanOrEqual(400)
      vi.restoreAllMocks()
      expect(await count('status-page-subscribers', orgB)).toBe(0)
      // Adapters with transactions (Postgres, MongoDB replica sets) roll the whole import back;
      // without them the documents written so far remain (docs/Import-and-Export.md).
      const probe = await payload.db.beginTransaction()
      if (probe) {
        await payload.db.rollbackTransaction(probe)
        expect(await count('status-pages', orgB)).toBe(0)
        expect(await count('incidents', orgB)).toBe(0)
        expect(await count('maintenance', orgB)).toBe(0)
      }
    })
  })

  describe('Better Stack', () => {
    it('imports monitors, the status page with linked components, incidents and maintenance', async () => {
      const calls = stubApi(betterStackRoutes())
      const res = await importFrom(orgC, 'betterstack', betterStackBody(), owner)
      expect(res.status).toBe(201)
      const report = (await res.json()) as ImportReport
      expect(report.format).toBe('betterstack')
      // Pagination was followed, with the token on every call.
      expect(calls.some((call) => call.url === `${BS}/monitors?page=2`)).toBe(true)
      for (const call of calls) expect(call.authorization).toBe(`Bearer ${BETTERSTACK_TOKEN}`)

      expect(report.monitors.create).toBe(4)
      expect(report.monitors.skipped).toEqual([
        { name: 'NTP', reason: 'Monitor type "UDP" is not supported by Marmot yet' },
      ])
      expect(report.warnings.some((w) => w.includes('"API health": interval raised'))).toBe(true)
      expect(report.maintenance.skipped).toEqual([
        { name: 'Old maintenance', reason: 'Finished maintenance windows are not imported' },
      ])

      const monitors = (
        await payload.find({
          collection: 'monitors',
          where: { id: { in: report.monitors.created } },
          depth: 0,
          limit: 0,
          overrideAccess: true,
        })
      ).docs as Monitor[]
      const byName = new Map(monitors.map((m) => [m.name, m] as const))
      expect(byName.get('Shop homepage')).toMatchObject({
        type: 'http',
        url: 'https://shop.example.com',
        interval: 30,
        timeout: 15,
        method: 'GET',
        active: true,
        expiryNotification: true,
        headers: '{"X-Probe":"marmot"}',
      })
      expect(byName.get('API health')).toMatchObject({
        type: 'http',
        interval: 20,
        method: 'HEAD',
        active: false,
        ignoreTls: true,
        maxRedirects: 0,
        domainExpiryNotification: true,
        acceptedStatusCodes: ['200', '204'],
      })
      expect(byName.get('Cart has no error')).toMatchObject({
        type: 'keyword',
        keyword: 'Internal Server Error',
        invertKeyword: true,
      })
      expect(byName.get('Database port')).toMatchObject({
        type: 'port',
        hostname: 'db.example.com',
        port: 5432,
        timeout: 3,
      })

      const page = await payload.findByID({
        collection: 'status-pages',
        id: report.statusPages.created![0],
        depth: 0,
        overrideAccess: true,
      })
      expect(page).toMatchObject({
        title: 'Example Shop',
        theme: 'dark',
        published: false,
        homepageUrl: 'https://shop.example.com',
        googleAnalyticsId: 'G-ABC123',
      })
      expect(page.slug.startsWith('example-shop')).toBe(true)
      expect(
        page.groups?.map((g) => [g.name, g.monitors?.map((row) => [row.type, row.name])]),
      ).toEqual([
        ['Storefront', [['monitor', 'Shop']]],
        [
          'Backend',
          [
            ['monitor', 'Public API'],
            ['static', 'Nightly exports'],
          ],
        ],
      ])
      const shopRow = page.groups?.[0].monitors?.[0]
      expect(idOf(shopRow?.monitor)).toBe(String(byName.get('Shop homepage')?.id))
      expect(shopRow?.showChart).toBe(true)

      const { docs: incidents } = await payload.find({
        collection: 'incidents',
        where: { statusPage: { equals: page.id } },
        depth: 0,
        overrideAccess: true,
      })
      expect(incidents).toHaveLength(1)
      const incident = incidents[0] as Incident
      expect(incident).toMatchObject({ title: 'Checkout failures', status: 'resolved' })
      expect(incident.updates?.map((u) => [u.status, u.postedAt])).toEqual([
        ['investigating', '2026-09-02T12:00:00.000Z'],
        ['resolved', '2026-09-02T13:15:00.000Z'],
      ])
      expect(incident.updates?.[0].components).toEqual([
        expect.objectContaining({ component: String(shopRow?.id), impact: 'major_outage' }),
      ])

      const { docs: windows } = await payload.find({
        collection: 'maintenance',
        where: { organization: { equals: orgC.id } },
        depth: 0,
        overrideAccess: true,
      })
      expect(windows).toHaveLength(1)
      expect(windows[0]).toMatchObject({
        title: 'Backend upgrade',
        dateRange: { start: '2099-02-01T01:00', end: '2099-02-01T02:00' },
      })
      expect((windows[0].monitors ?? []).map(idOf)).toEqual([String(byName.get('API health')?.id)])
      expect((windows[0].statusPages ?? []).map(idOf)).toEqual([String(page.id)])
    })

    it('keeps status page rows static when monitors are not imported', async () => {
      stubApi(betterStackRoutes())
      const res = await importFrom(
        orgB,
        'betterstack',
        betterStackBody(['components']),
        owner,
        true,
      )
      const report = (await res.json()) as ImportReport
      expect(report.monitors.create).toBe(0)
      expect(report.statusPages.create).toBe(1)
      expect(report.incidents.create).toBe(0)
    })

    it('refuses pagination links to another host', async () => {
      const routes = betterStackRoutes()
      routes[`${BS}/monitors`] = {
        data: [],
        pagination: { next: 'https://attacker.example/steal' },
      }
      const calls = stubApi(routes)
      const res = await importFrom(orgB, 'betterstack', betterStackBody(['monitors']), owner, true)
      expect(res.status).toBe(502)
      expect(calls.every((call) => call.url.startsWith(BS))).toBe(true)
    })
  })

  describe('Instatus', () => {
    it('previews counts and every skipped item with a reason, without writing', async () => {
      const calls = stubApi(instatusRoutes())
      const res = await importFrom(orgD, 'instatus', instatusBody(), owner, true)
      expect(res.status).toBe(200)
      const report = (await res.json()) as ImportReport
      expect(report.format).toBe('instatus')
      expect(report.statusPages.create).toBe(1)
      expect(report.incidents.create).toBe(3)
      expect(report.maintenance.create).toBe(1)
      expect(report.maintenance.skipped).toEqual([
        { name: 'Network maintenance', reason: 'Finished maintenance windows are not imported' },
        { name: 'Unscheduled window', reason: 'No start and end time' },
      ])
      expect(report.subscribers.create).toBe(4)
      expect(report.subscribers.skipped.map((item) => item.reason).sort()).toEqual(
        [
          'Duplicate subscription',
          'Not a valid sms address',
          'Not confirmed by the subscriber',
          'slack subscriptions are not supported',
        ].sort(),
      )
      expect(JSON.stringify(report)).not.toContain('pending@customer.example')

      // The key went to the Instatus API only, as a bearer token.
      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) {
        expect(call.url.startsWith(IS)).toBe(true)
        expect(call.url).not.toContain(INSTATUS_KEY)
        expect(call.authorization).toBe(`Bearer ${INSTATUS_KEY}`)
      }
      // Only the chosen page was read.
      expect(calls.some((call) => call.url.includes('ckp0page000other'))).toBe(false)
      expect(await count('status-pages', orgD)).toBe(0)
    })

    it('only reads the chosen resources and reports an unknown page', async () => {
      const calls = stubApi(instatusRoutes())
      const res = await importFrom(orgD, 'instatus', instatusBody(['components']), owner, true)
      const report = (await res.json()) as ImportReport
      expect(report.statusPages.create).toBe(1)
      expect(report.incidents.create).toBe(0)
      for (const path of ['/incidents', '/maintenances', '/subscribers']) {
        expect(calls.some((call) => call.url.includes(path))).toBe(false)
      }

      stubApi(instatusRoutes())
      const missing = await importFrom(
        orgD,
        'instatus',
        instatusBody(['components'], 'no-such-page'),
        owner,
        true,
      )
      expect(missing.status).toBe(400)
      const body = (await missing.json()) as { errors: { message: string }[] }
      expect(body.errors[0].message).toMatch(/Instatus did not find that page/)
    })

    it('imports page, components, incident history, maintenance and subscribers', async () => {
      stubApi(instatusRoutes())
      const { result: res, logs } = await captureLogs(() =>
        importFrom(orgD, 'instatus', instatusBody(), owner),
      )
      expect(res.status).toBe(201)
      const report = (await res.json()) as ImportReport
      expect(logs).not.toContain(INSTATUS_KEY)

      const page = await payload.findByID({
        collection: 'status-pages',
        id: report.statusPages.created![0],
        depth: 0,
        overrideAccess: true,
      })
      expect(page).toMatchObject({
        title: 'Acme Hosting',
        published: false,
        homepageUrl: 'https://acme-hosting.example',
        contactUrl: 'mailto:support@acme-hosting.example',
        googleAnalyticsId: 'G-INSTA123',
        customCSS: '.header { border-bottom: 1px solid #eee; }',
      })
      expect(page.slug.startsWith('acme-instatus')).toBe(true)
      expect(page.groups?.map((g) => [g.name, g.monitors?.map((row) => row.name)])).toEqual([
        ['Services', ['Website']],
        ['Core platform', ['API', 'Dashboard']],
      ])
      expect(page.groups?.[1].monitors?.[0]).toMatchObject({
        type: 'static',
        description: 'REST and webhooks API',
      })
      const rows = rowIds(page)

      const { docs } = await payload.find({
        collection: 'incidents',
        where: { statusPage: { equals: page.id } },
        sort: 'createdAt',
        depth: 0,
        overrideAccess: true,
      })
      const incidents = docs as Incident[]
      expect(incidents.map((i) => i.title)).toEqual([
        'Login errors',
        'API outage',
        'Slow dashboard',
      ])
      const [login, outage, slow] = incidents

      // Updates are sorted by time; each keeps the component statuses it set.
      expect(new Date(outage.createdAt).toISOString()).toBe('2026-09-10T10:00:00.000Z')
      expect(outage.status).toBe('resolved')
      expect(outage.active).toBe(false)
      expect(outage.updates?.map((u) => [u.status, u.message])).toEqual([
        ['investigating', 'We are investigating failing API requests.'],
        ['identified', 'A faulty deploy was identified and rolled back.'],
        ['resolved', 'The API has recovered.'],
      ])
      expect(outage.updates?.[0].components).toEqual([
        expect.objectContaining({ component: rows.get('API'), impact: 'major_outage' }),
      ])
      expect(outage.updates?.[1].components).toEqual([
        expect.objectContaining({ component: rows.get('API'), impact: 'partial_outage' }),
      ])

      // Without per-update statuses the affected components belong to the first update; the
      // component that no longer exists is dropped.
      expect(slow.status).toBe('monitoring')
      expect(slow.active).toBe(true)
      expect(slow.updates?.[0].components).toEqual([
        expect.objectContaining({
          component: rows.get('Dashboard'),
          impact: 'degraded_performance',
        }),
      ])

      // A resolved incident whose updates stop early gets its resolution at `resolved`.
      expect(login.status).toBe('resolved')
      expect(login.updates?.map((u) => [u.status, u.postedAt])).toEqual([
        ['investigating', '2026-08-20T14:00:00.000Z'],
        ['resolved', '2026-08-20T14:40:00.000Z'],
      ])
      expect(login.affectedComponents).toEqual([
        expect.objectContaining({ component: rows.get('Website'), impact: 'operational' }),
      ])

      const { docs: windows } = await payload.find({
        collection: 'maintenance',
        where: { organization: { equals: orgD.id } },
        depth: 0,
        overrideAccess: true,
      })
      expect(windows).toHaveLength(1)
      expect(windows[0] as Maintenance).toMatchObject({
        title: 'Database upgrade',
        strategy: 'single',
        timezone: 'UTC',
        // `duration` is in minutes.
        dateRange: { start: '2099-01-10T02:00', end: '2099-01-10T04:30' },
      })
      expect(windows[0].description).toMatch(/upgrade the primary database/)
      expect((windows[0].statusPages ?? []).map(idOf)).toEqual([String(page.id)])

      const { docs: subscribers } = await payload.find({
        collection: 'status-page-subscribers',
        where: { statusPage: { equals: page.id } },
        depth: 0,
        overrideAccess: true,
      })
      const byTarget = new Map(
        (subscribers as StatusPageSubscriber[]).map((s) => [s.target, s] as const),
      )
      expect([...byTarget.keys()].sort()).toEqual(
        [
          '+14155550123',
          'https://hooks.customer.example/instatus',
          'ops.lead@customer.example',
          'status@partner.example',
        ].sort(),
      )
      for (const subscriber of subscribers as StatusPageSubscriber[]) {
        expect(subscriber.source).toBe('import')
        expect(subscriber.confirmedAt).toBeTruthy()
      }
      expect(byTarget.get('ops.lead@customer.example')?.components).toEqual([rows.get('API')])
      expect(byTarget.get('status@partner.example')?.components ?? []).toEqual([])
      expect(
        [...(byTarget.get('https://hooks.customer.example/instatus')?.components ?? [])].sort(),
      ).toEqual([rows.get('Dashboard'), rows.get('Website')].sort())
      const { totalDocs: deliveries } = await payload.count({
        collection: 'subscriber-notifications',
        where: { statusPage: { equals: page.id } },
        overrideAccess: true,
      })
      expect(deliveries).toBe(0)
      expect(JSON.stringify({ page, incidents, windows, subscribers, report })).not.toContain(
        INSTATUS_KEY,
      )
    })
  })

  describe('Checkly', () => {
    it('imports API, URL, TCP and ICMP checks and skips the other types with a reason', async () => {
      const calls = stubApi(checklyRoutes())
      const { result: res, logs } = await captureLogs(() =>
        importFrom(orgE, 'checkly', checklyBody(), owner),
      )
      expect(res.status).toBe(201)
      const report = (await res.json()) as ImportReport
      expect(report.format).toBe('checkly')
      expect(logs).not.toContain(CHECKLY_KEY)
      for (const call of calls) {
        expect(call.url.startsWith(CK)).toBe(true)
        expect(call.authorization).toBe(`Bearer ${CHECKLY_KEY}`)
        expect(call.account).toBe(CHECKLY_ACCOUNT)
      }

      expect(report.monitors.create).toBe(5)
      expect(report.monitors.skipped).toEqual([
        {
          name: 'Staging API',
          reason: 'Its target uses Checkly environment variables, which Marmot cannot resolve',
        },
        { name: 'Checkout flow', reason: 'Monitor type "Browser" is not supported by Marmot yet' },
        {
          name: 'Signup journey',
          reason: 'Monitor type "Multistep" is not supported by Marmot yet',
        },
        {
          name: 'Nightly backup',
          reason: 'Monitor type "Heartbeat" is not supported by Marmot yet',
        },
        {
          name: 'E2E suite',
          reason: 'Monitor type "Playwright Check Suite" is not supported by Marmot yet',
        },
      ])
      expect(report.warnings).toEqual(
        expect.arrayContaining([
          '"Public API health": 1 assertion has no Marmot equivalent and was not imported',
          '"Create order": interval raised from 10s to the minimum of 20s',
          '"Create order": 1 assertion has no Marmot equivalent and was not imported',
          '"Create order": setup and teardown scripts are not imported',
          '"Database port": 1 assertion has no Marmot equivalent and was not imported',
        ]),
      )
      expect(report.statusPages.create).toBe(0)

      const monitors = (
        await payload.find({
          collection: 'monitors',
          where: { id: { in: report.monitors.created } },
          depth: 0,
          limit: 0,
          overrideAccess: true,
        })
      ).docs as Monitor[]
      const byName = new Map(monitors.map((m) => [m.name, m] as const))
      expect(byName.get('Public API health')).toMatchObject({
        type: 'http',
        url: 'https://api.example.com/health?verbose=1',
        method: 'GET',
        interval: 300,
        maxRetries: 2,
        retryInterval: 60,
        timeout: 20,
        degradedAfter: 5000,
        active: true,
        headers: '{"X-Probe":"marmot"}',
        authMethod: 'basic',
        basicAuthUser: 'probe',
      })
      expect(
        (byName.get('Public API health')?.assertions ?? []).map((a) => [
          a.kind,
          a.target ?? null,
          a.comparator,
          a.value ?? null,
        ]),
      ).toEqual([
        ['status', null, 'eq', '200'],
        ['jsonBody', 'status', 'eq', 'ok'],
        ['header', 'content-type', 'contains', 'json'],
      ])
      expect(byName.get('Create order')).toMatchObject({
        type: 'http',
        method: 'POST',
        body: '{"sku":"test-001","quantity":1}',
        httpBodyEncoding: 'json',
        interval: 20,
        timeout: 20,
        active: false,
        ignoreTls: true,
        maxRedirects: 0,
        authMethod: 'none',
      })
      expect(byName.get('Database port')).toMatchObject({
        type: 'port',
        hostname: 'db.example.com',
        port: 5432,
        interval: 60,
        timeout: 5,
      })
      expect(byName.get('Edge router')).toMatchObject({
        type: 'ping',
        hostname: '203.0.113.10',
        interval: 600,
      })
      expect(byName.get('Marketing site')).toMatchObject({ type: 'http', interval: 120 })
      expect(
        (byName.get('Marketing site')?.assertions ?? []).map((a) => [
          a.kind,
          a.comparator,
          a.value,
        ]),
      ).toEqual([['status', 'lt', '400']])
      expect(JSON.stringify({ monitors, report })).not.toContain(CHECKLY_KEY)
    })

    it('follows pagination and refuses an invalid account ID', async () => {
      const first = Array.from({ length: 100 }, (_, index) => ({
        id: `icmp-${index}`,
        checkType: 'ICMP',
        name: `Host ${index}`,
        activated: true,
        frequency: 10,
        request: { hostname: `10.0.0.${index + 1}` },
      }))
      const calls = stubApi({
        [`${CK}/checks?limit=100&page=1`]: first,
        [`${CK}/checks?limit=100&page=2`]: fixture('checkly', 'checks'),
      })
      const res = await importFrom(orgB, 'checkly', checklyBody(), owner, true)
      expect(res.status).toBe(200)
      const report = (await res.json()) as ImportReport
      expect(report.monitors.create).toBe(105)
      expect(calls.map((call) => call.url)).toEqual([
        `${CK}/checks?limit=100&page=1`,
        `${CK}/checks?limit=100&page=2`,
      ])

      const none = stubApi(checklyRoutes())
      const bad = await importFrom(orgB, 'checkly', checklyBody('not an id'), owner, true)
      expect(bad.status).toBe(400)
      expect(none).toHaveLength(0)
    })
  })
})
