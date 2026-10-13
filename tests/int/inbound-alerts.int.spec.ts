import { readFileSync } from 'node:fs'
import path from 'node:path'

import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import type { Role } from '@/access/permissions'
import { POST as inboundRoute } from '@/app/api/inbound/[token]/route'
import { POST as inboundEmailRoute } from '@/app/api/inbound-email/route'
import { GET as listRoute, POST as createRoute } from '@/app/api/orgs/[orgId]/integrations/route'
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as patchRoute,
} from '@/app/api/orgs/[orgId]/integrations/[id]/route'
import { GET as eventsRoute } from '@/app/api/orgs/[orgId]/integrations/[id]/events/route'
import { POST as rotateRoute } from '@/app/api/orgs/[orgId]/integrations/[id]/rotate-token/route'
import { env, resetEnvCache } from '@/env'
import {
  parseInboundEmail,
  parseInboundPayload,
  ruleMatches,
  type IntegrationEventRow,
  type IntegrationRow,
} from '@/lib/inbound-alerts'
import type {
  DeclaredIncident,
  Incident,
  IntegrationAlert,
  Monitor,
  Organization,
  PushEvent,
  StatusPage,
  User,
} from '@/payload-types'
import { setDeclaredJobSink } from '@/server/declared-incidents'
import { closeIntegrationLocks } from '@/server/integrations/ingest'

/**
 * Inbound alert integrations (#152): RBAC of the management API, token authentication, rate limit
 * and size cap of `POST /api/inbound/:token`, the recorded Alertmanager / Grafana / generic
 * fixtures, rule mapping, firing → resolved transitions on components, declared and status-page
 * incidents and push monitors, dedupe of retries (also concurrent ones), and email-to-incident.
 */

let payload: Payload
const run = Date.now().toString(36)
const email = (name: string) => `${name}+inb-${run}@marmot.test`
const PASSWORD = 'password-123'
const DOMAIN = 'alerts.marmot.test'
const EMAIL_SECRET = `inbound-secret-${run}-xxxxxxxx`
const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(path.resolve(__dirname, `../fixtures/inbound/${name}.json`), 'utf8'),
  ) as unknown

type Session = { user: User; cookie: string }
type Id = string | number

const ENV_KEYS = [
  'INBOUND_ALERT_RATE_LIMIT',
  'INBOUND_ALERT_MAX_BYTES',
  'INBOUND_EMAIL_DOMAIN',
  'INBOUND_EMAIL_WEBHOOK_SECRET',
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetEnvCache()
}

async function createMember(name: string, org: Organization, role: Role): Promise<Session> {
  const user = await payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name },
  })
  await addOrgMembership({ payload, userId: user.id, orgId: org.id, role })
  const { token } = await payload.login({
    collection: 'users',
    data: { email: email(name), password: PASSWORD },
  })
  return { user, cookie: `payload-token=${token}` }
}

function request(
  url: string,
  init: { method?: string; body?: unknown; session?: Session } = {},
): Request {
  return new Request(url, {
    method: init.method ?? 'GET',
    headers: {
      Origin: env.NEXT_PUBLIC_SERVER_URL,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.session ? { cookie: init.session.cookie } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
}

const BASE = 'http://localhost:3000/api/orgs'
const orgParams = (orgId: Id) => ({ params: Promise.resolve({ orgId: String(orgId) }) })
const idParams = (orgId: Id, id: Id) => ({
  params: Promise.resolve({ orgId: String(orgId), id: String(id) }),
})

let orgA: Organization
let orgB: Organization
let admin: Session
let member: Session
let viewer: Session
let outsider: Session
let page: StatusPage
let otherPage: StatusPage
let apiComponent: string
let pushMonitor: Monitor

interface Created {
  doc: IntegrationRow
  token: string
  url: string
  email: string | null
}

async function createIntegration(
  body: Record<string, unknown>,
  session: Session = admin,
  org: Organization = orgA,
) {
  const response = await createRoute(
    request(`${BASE}/${org.id}/integrations`, { method: 'POST', body, session }),
    orgParams(org.id),
  )
  return { status: response.status, json: (await response.json()) as Created & { error?: string } }
}

async function post(token: string, body: unknown, headers: Record<string, string> = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  const response = await inboundRoute(
    new Request(`http://localhost:3000/api/inbound/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: raw,
    }),
    { params: Promise.resolve({ token }) },
  )
  return {
    status: response.status,
    headers: response.headers,
    json: (await response.json()) as {
      ok: boolean
      results?: { dedupKey: string; status: string; outcome: string }[]
    },
  }
}

const incidentsOf = async (title: string) =>
  (
    await payload.find({
      collection: 'incidents',
      where: { and: [{ organization: { equals: orgA.id } }, { title: { equals: title } }] },
      depth: 0,
      overrideAccess: true,
    })
  ).docs as Incident[]

const declaredOf = async (title: string) =>
  (
    await payload.find({
      collection: 'declared-incidents',
      where: { and: [{ organization: { equals: orgA.id } }, { title: { equals: title } }] },
      depth: 0,
      overrideAccess: true,
    })
  ).docs as DeclaredIncident[]

const apiRule = {
  name: 'API outage',
  matchField: 'service',
  matchOperator: 'equals',
  matchValue: 'api',
  updateComponent: true,
  impact: 'partial_outage',
  incident: 'draft',
  severity: 'critical',
}

describe('inbound alert integrations', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    setDeclaredJobSink(async () => undefined)
    setEnv({ INBOUND_ALERT_RATE_LIMIT: '1000', INBOUND_ALERT_MAX_BYTES: '4096' })

    orgA = await payload.create({
      collection: 'organizations',
      data: { name: 'Inbound A', slug: `inb-a-${run}` },
    })
    orgB = await payload.create({
      collection: 'organizations',
      data: { name: 'Inbound B', slug: `inb-b-${run}` },
    })
    admin = await createMember('admin', orgA, 'admin')
    member = await createMember('member', orgA, 'member')
    viewer = await createMember('viewer', orgA, 'viewer')
    outsider = await createMember('outsider', orgB, 'owner')

    page = (await payload.create({
      collection: 'status-pages',
      data: {
        organization: orgA.id,
        title: 'Inbound status',
        slug: `inb-${run}`,
        published: true,
        groups: [{ name: 'Services', monitors: [{ type: 'static', name: 'API' }] }],
      },
      depth: 0,
      overrideAccess: true,
    })) as StatusPage
    apiComponent = String(page.groups?.[0]?.monitors?.[0]?.id)
    otherPage = (await payload.create({
      collection: 'status-pages',
      data: {
        organization: orgB.id,
        title: 'Other',
        slug: `inb-other-${run}`,
        groups: [{ name: 'Services', monitors: [{ type: 'static', name: 'Other' }] }],
      },
      depth: 0,
      overrideAccess: true,
    })) as StatusPage
    pushMonitor = (await payload.create({
      collection: 'monitors',
      overrideAccess: true,
      depth: 0,
      data: {
        organization: orgA.id,
        name: `inbound-push-${run}`,
        type: 'push',
        interval: 3600,
        retryInterval: 60,
        maxRetries: 0,
        resendInterval: 0,
        timeout: 5,
      } as RequiredDataFromCollectionSlug<'monitors'>,
    })) as Monitor
  })

  afterAll(async () => {
    setDeclaredJobSink(null)
    setEnv(savedEnv)
    await closeIntegrationLocks()
    const orgIds = [orgA?.id, orgB?.id].filter(Boolean)
    if (orgIds.length) {
      const where = { organization: { in: orgIds } }
      await payload.delete({ collection: 'integration-events', where, overrideAccess: true })
      await payload.delete({ collection: 'integration-alerts', where, overrideAccess: true })
      await payload.delete({ collection: 'integrations', where, overrideAccess: true })
      await payload.delete({ collection: 'declared-incidents', where, overrideAccess: true })
      await payload.delete({ collection: 'incidents', where, overrideAccess: true })
      await payload.delete({ collection: 'status-pages', where, overrideAccess: true })
      await payload.delete({
        collection: 'push-events',
        where: { monitor: { equals: pushMonitor.id } },
      })
      await payload.delete({
        collection: 'heartbeats',
        where: { monitor: { equals: pushMonitor.id } },
      })
      await payload.delete({ collection: 'monitors', where, overrideAccess: true })
      await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
    }
    await payload.delete({ collection: 'users', where: { email: { like: `+inb-${run}@` } } })
  })

  describe('parsers (recorded fixtures)', () => {
    it('reads Alertmanager alerts with labels, annotations and the fingerprint', () => {
      const { alerts } = parseInboundPayload('alertmanager', fixture('alertmanager-firing'))
      expect(alerts).toHaveLength(1)
      expect(alerts[0]).toMatchObject({
        dedupKey: '6f2b1c0d9e8a7b65',
        status: 'firing',
        title: 'API error rate above 5%',
        severity: 'critical',
      })
      expect(alerts[0].fields.service).toBe('api')
      const resolved = parseInboundPayload('alertmanager', fixture('alertmanager-resolved'))
      expect(resolved.alerts[0]).toMatchObject({ dedupKey: '6f2b1c0d9e8a7b65', status: 'resolved' })
    })

    it('reads Grafana unified and legacy alerts', () => {
      const unified = parseInboundPayload('grafana', fixture('grafana-unified')).alerts[0]
      expect(unified).toMatchObject({
        dedupKey: 'a1b2c3d4e5f60718',
        status: 'firing',
        title: 'Database disk at 92%',
      })
      expect(unified.fields.service).toBe('db')
      const legacy = parseInboundPayload('grafana', fixture('grafana-legacy')).alerts[0]
      expect(legacy).toMatchObject({ dedupKey: '17', status: 'firing', title: 'Checkout latency' })
      expect(legacy.fields.service).toBe('checkout')
      const ok = parseInboundPayload('grafana', {
        ...(fixture('grafana-legacy') as object),
        state: 'ok',
      })
      expect(ok.alerts[0].status).toBe('resolved')
    })

    it('maps generic JSON with paths and caps the number of alerts', () => {
      const mapping = {
        titlePath: '$.event.title',
        statusPath: 'event.state',
        dedupKeyPath: 'event.id',
        severityPath: 'event.priority',
        descriptionPath: 'event.details',
        resolvedValues: 'resolved',
      }
      const alert = parseInboundPayload('generic', fixture('generic'), mapping).alerts[0]
      expect(alert).toMatchObject({
        dedupKey: 'evt-4821',
        status: 'firing',
        title: 'Payments queue backlog',
        severity: 'P2',
      })
      expect(alert.fields['event.component']).toBe('payments')
      const many = parseInboundPayload(
        'generic',
        Array.from({ length: 150 }, (_, i) => ({ id: `a${i}`, title: 't' })),
      )
      expect(many.alerts).toHaveLength(100)
      expect(many.dropped).toBe(50)
      expect(() => parseInboundPayload('alertmanager', [1, 2])).toThrow()
    })

    it('gives an email alert and its recovery the same key, and matches rules', () => {
      const firing = parseInboundEmail({ subject: '[FIRING] Backup failed on nas' }, 'resolved')
      const resolved = parseInboundEmail({ subject: 'RESOLVED: Backup failed on nas' }, 'resolved')
      expect(firing.status).toBe('firing')
      expect(resolved.status).toBe('resolved')
      expect(resolved.dedupKey).toBe(firing.dedupKey)
      expect(
        ruleMatches(
          { matchField: 'subject', matchOperator: 'regex', matchValue: 'backup.*nas' },
          firing,
        ),
      ).toBe(true)
      expect(ruleMatches({ matchOperator: 'contains', matchValue: 'database' }, firing)).toBe(false)
      expect(ruleMatches({ matchValue: '', enabled: false }, firing)).toBe(false)
    })
  })

  describe('management API and RBAC', () => {
    it('lets members read, only admins create, and never returns the token again', async () => {
      const created = await createIntegration({
        name: 'RBAC',
        format: 'alertmanager',
        rules: [{ ...apiRule, statusPage: page.id, component: apiComponent }],
      })
      expect(created.status).toBe(201)
      expect(created.json.token).toMatch(/^mi[0-9a-f]{40}$/)
      expect(created.json.url).toBe(
        `${env.NEXT_PUBLIC_SERVER_URL}/api/inbound/${created.json.token}`,
      )
      const id = created.json.doc.id

      const asMember = await listRoute(
        request(`${BASE}/${orgA.id}/integrations`, { session: member }),
        orgParams(orgA.id),
      )
      expect(asMember.status).toBe(200)
      const text = await asMember.text()
      expect(text).toContain('RBAC')
      expect(text).not.toContain(created.json.token)
      expect(text).not.toContain('tokenHash')

      expect((await createIntegration({ name: 'x', format: 'generic' }, member)).status).toBe(403)
      const asViewer = await listRoute(
        request(`${BASE}/${orgA.id}/integrations`, { session: viewer }),
        orgParams(orgA.id),
      )
      expect(asViewer.status).toBe(403)
      const asOutsider = await getRoute(
        request(`${BASE}/${orgA.id}/integrations/${id}`, { session: outsider }),
        idParams(orgA.id, id),
      )
      expect(asOutsider.status).toBe(403)
      const crossOrg = await getRoute(
        request(`${BASE}/${orgB.id}/integrations/${id}`, { session: outsider }),
        idParams(orgB.id, id),
      )
      expect(crossOrg.status).toBe(404)
      const memberPatch = await patchRoute(
        request(`${BASE}/${orgA.id}/integrations/${id}`, {
          method: 'PATCH',
          body: { name: 'renamed' },
          session: member,
        }),
        idParams(orgA.id, id),
      )
      expect(memberPatch.status).toBe(403)

      const removed = await deleteRoute(
        request(`${BASE}/${orgA.id}/integrations/${id}`, { method: 'DELETE', session: admin }),
        idParams(orgA.id, id),
      )
      expect(removed.status).toBe(200)
    })

    it('refuses rules pointing at other organizations, unknown components or bad regexes', async () => {
      const foreign = await createIntegration({
        name: 'Foreign',
        format: 'alertmanager',
        rules: [{ ...apiRule, statusPage: otherPage.id, component: apiComponent }],
      })
      expect(foreign.status).toBe(400)
      const component = await createIntegration({
        name: 'Component',
        format: 'alertmanager',
        rules: [{ ...apiRule, statusPage: page.id, component: 'nope' }],
      })
      expect(component.status).toBe(400)
      const regex = await createIntegration({
        name: 'Regex',
        format: 'alertmanager',
        rules: [{ matchOperator: 'regex', matchValue: '([' }],
      })
      expect(regex.status).toBe(400)
      const noPage = await createIntegration({
        name: 'No page',
        format: 'alertmanager',
        rules: [{ updateComponent: true }],
      })
      expect(noPage.status).toBe(400)
    })
  })

  describe('POST /api/inbound/:token', () => {
    let token: string
    let integrationId: string

    beforeAll(async () => {
      const created = await createIntegration({
        name: 'Prometheus',
        format: 'alertmanager',
        rules: [
          { ...apiRule, statusPage: page.id, component: apiComponent },
          { name: 'Queue', matchField: 'service', matchValue: 'queue', incident: 'draft' },
          {
            name: 'Cron',
            matchField: 'alertname',
            matchValue: 'CronMissed',
            incident: 'none',
            monitor: pushMonitor.id,
          },
        ],
      })
      expect(created.status).toBe(201)
      token = created.json.token
      integrationId = created.json.doc.id
    })

    it('answers 404 for unknown, malformed and paused tokens', async () => {
      expect((await post(`mi${'0'.repeat(40)}`, fixture('alertmanager-firing'))).status).toBe(404)
      expect((await post('not-a-token', fixture('alertmanager-firing'))).status).toBe(404)
      const paused = await createIntegration({
        name: 'Paused',
        format: 'alertmanager',
        active: false,
      })
      expect((await post(paused.json.token, fixture('alertmanager-firing'))).status).toBe(404)
    })

    it('refuses bodies over the size limit and bodies that are not JSON', async () => {
      const big = { alerts: [], padding: 'x'.repeat(5_000) }
      expect((await post(token, big)).status).toBe(413)
      expect((await post(token, '{not json')).status).toBe(400)
    })

    it('opens a draft incident and sets the component on firing, and undoes both on resolved', async () => {
      const firing = await post(token, fixture('alertmanager-firing'))
      expect(firing.status).toBe(200)
      expect(firing.json.results).toEqual([
        { dedupKey: '6f2b1c0d9e8a7b65', status: 'firing', outcome: 'opened' },
      ])

      const [incident] = await incidentsOf('API error rate above 5%')
      expect(incident.active).toBe(true)
      expect(incident.affectedComponents).toEqual([
        expect.objectContaining({ component: apiComponent, impact: 'partial_outage' }),
      ])
      const [declared] = await declaredOf('API error rate above 5%')
      expect(declared).toMatchObject({ status: 'open', severity: 'critical' })
      expect(String(declared.statusPageIncident)).toBe(String(incident.id))

      // Alertmanager re-sends the group every `repeat_interval`, and retries failed deliveries.
      const again = await post(token, fixture('alertmanager-firing'))
      expect(again.json.results?.[0].outcome).toBe('duplicate')
      expect(await incidentsOf('API error rate above 5%')).toHaveLength(1)
      expect(await declaredOf('API error rate above 5%')).toHaveLength(1)

      const resolved = await post(token, fixture('alertmanager-resolved'))
      expect(resolved.json.results?.[0].outcome).toBe('resolved')
      const [after] = await incidentsOf('API error rate above 5%')
      expect(after.active).toBe(false)
      expect(after.status).toBe('resolved')
      expect(after.affectedComponents?.every((row) => row.impact === 'operational')).toBe(true)
      const [declaredAfter] = await declaredOf('API error rate above 5%')
      expect(declaredAfter.status).toBe('resolved')

      expect((await post(token, fixture('alertmanager-resolved'))).json.results?.[0].outcome).toBe(
        'duplicate',
      )

      const events = await eventsRoute(
        request(`${BASE}/${orgA.id}/integrations/${integrationId}/events`, { session: member }),
        idParams(orgA.id, integrationId),
      )
      const page1 = (await events.json()) as { docs: IntegrationEventRow[] }
      expect(page1.docs.length).toBeGreaterThanOrEqual(4)
      expect(page1.docs[0].results).toEqual([
        expect.objectContaining({ outcome: 'duplicate', status: 'resolved' }),
      ])
    })

    it('fires again after a resolve, opening a new incident', async () => {
      const body = fixture('alertmanager-firing') as { alerts: { fingerprint: string }[] }
      body.alerts[0].fingerprint = `refire-${run}`
      expect((await post(token, body)).json.results?.[0].outcome).toBe('opened')
      const resolved = structuredClone(body) as unknown as { alerts: { status: string }[] }
      resolved.alerts[0].status = 'resolved'
      expect((await post(token, resolved)).json.results?.[0].outcome).toBe('resolved')
      expect((await post(token, body)).json.results?.[0].outcome).toBe('opened')
      const { docs } = await payload.find({
        collection: 'integration-alerts',
        where: { dedupKey: { equals: `refire-${run}` } },
        overrideAccess: true,
      })
      expect(docs).toHaveLength(1)
      expect((docs[0] as IntegrationAlert).status).toBe('firing')
    })

    it('opens one incident for concurrent retries of the same alert', async () => {
      const body = {
        status: 'firing',
        alerts: [
          {
            status: 'firing',
            labels: { alertname: 'QueueStuck', service: 'queue' },
            annotations: { summary: `Queue stuck ${run}` },
            fingerprint: `concurrent-${run}`,
          },
        ],
      }
      const responses = await Promise.all([post(token, body), post(token, body), post(token, body)])
      expect(responses.map((r) => r.status)).toEqual([200, 200, 200])
      expect(responses.filter((r) => r.json.results?.[0].outcome === 'opened')).toHaveLength(1)
      expect(await declaredOf(`Queue stuck ${run}`)).toHaveLength(1)
      // Public components are opt-in: this rule has no `updateComponent`.
      expect(await incidentsOf(`Queue stuck ${run}`)).toHaveLength(0)
    })

    it('logs alerts no rule matches without acting on them', async () => {
      const body = {
        alerts: [
          {
            status: 'firing',
            labels: { alertname: 'Other', service: 'search' },
            annotations: { summary: `Unmatched ${run}` },
            fingerprint: `unmatched-${run}`,
          },
        ],
      }
      expect((await post(token, body)).json.results?.[0].outcome).toBe('unmatched')
      expect(await declaredOf(`Unmatched ${run}`)).toHaveLength(0)
    })

    it('drives a push monitor: failure while firing, success once resolved', async () => {
      const body = {
        alerts: [
          { status: 'firing', labels: { alertname: 'CronMissed' }, fingerprint: `cron-${run}` },
        ],
      }
      await post(token, body)
      await post(token, { alerts: [{ ...body.alerts[0], status: 'resolved' }] })
      const { docs } = await payload.find({
        collection: 'push-events',
        where: { monitor: { equals: pushMonitor.id } },
        sort: 'time',
        depth: 0,
      })
      expect((docs as PushEvent[]).map((event) => [event.kind, event.source])).toEqual([
        ['fail', 'integration'],
        ['success', 'integration'],
      ])
    })

    it('redacts secrets in the event log', async () => {
      const generic = await createIntegration({
        name: 'Generic',
        format: 'generic',
        generic: { titlePath: 'event.title', dedupKeyPath: 'event.id', statusPath: 'event.state' },
      })
      expect((await post(generic.json.token, fixture('generic'))).status).toBe(200)
      const { docs } = await payload.find({
        collection: 'integration-events',
        where: { integration: { equals: generic.json.doc.id } },
        overrideAccess: true,
      })
      expect(docs[0].payload).toContain('[redacted]')
      expect(docs[0].payload).not.toContain('dd-0123456789abcdef')
    })

    it('stops accepting the old token once rotated', async () => {
      const created = await createIntegration({ name: 'Rotate', format: 'alertmanager' })
      const response = await rotateRoute(
        request(`${BASE}/${orgA.id}/integrations/${created.json.doc.id}/rotate-token`, {
          method: 'POST',
          session: admin,
        }),
        idParams(orgA.id, created.json.doc.id),
      )
      const rotated = (await response.json()) as Created
      expect(rotated.token).not.toBe(created.json.token)
      expect((await post(created.json.token, { alerts: [] })).status).toBe(404)
      expect((await post(rotated.token, { alerts: [] })).status).toBe(200)
    })

    it('rate-limits requests per token', async () => {
      setEnv({ INBOUND_ALERT_RATE_LIMIT: '2' })
      try {
        const created = await createIntegration({ name: 'Limited', format: 'alertmanager' })
        const statuses: number[] = []
        for (let i = 0; i < 3; i += 1) {
          statuses.push((await post(created.json.token, { alerts: [] })).status)
        }
        expect(statuses).toEqual([200, 200, 429])
      } finally {
        setEnv({ INBOUND_ALERT_RATE_LIMIT: '1000' })
      }
    })
  })

  describe('email-to-incident', () => {
    it('opens and resolves a draft incident from mail to the integration address', async () => {
      setEnv({ INBOUND_EMAIL_DOMAIN: DOMAIN, INBOUND_EMAIL_WEBHOOK_SECRET: EMAIL_SECRET })
      try {
        const created = await createIntegration({
          name: 'Mail',
          format: 'generic',
          rules: [
            {
              matchField: 'subject',
              matchOperator: 'contains',
              matchValue: 'backup',
              incident: 'draft',
            },
          ],
        })
        expect(created.json.email).toBe(`${created.json.token}@${DOMAIN}`)
        const mail = (subject: string) =>
          inboundEmailRoute(
            new Request(`http://localhost/api/inbound-email?secret=${EMAIL_SECRET}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                to: created.json.email,
                subject,
                text: 'Job exited with 1',
                from: 'nas@example.com',
              }),
            }),
          )
        const title = `Backup failed ${run}`
        const first = await mail(`[ALERT] ${title}`)
        expect(((await first.json()) as { accepted: number }).accepted).toBe(1)
        await mail(`[ALERT] ${title}`)
        const declared = await declaredOf(title)
        expect(declared).toHaveLength(1)
        expect(declared[0].status).toBe('open')

        await mail(`RESOLVED: ${title}`)
        expect((await declaredOf(title))[0].status).toBe('resolved')
      } finally {
        setEnv({ INBOUND_EMAIL_DOMAIN: undefined, INBOUND_EMAIL_WEBHOOK_SECRET: undefined })
      }
    })
  })
})
