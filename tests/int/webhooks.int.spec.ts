import { createHmac } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import type { Role } from '@/access/permissions'
import { GET as listRoute, POST as createRoute } from '@/app/api/orgs/[orgId]/webhooks/route'
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as patchRoute,
} from '@/app/api/orgs/[orgId]/webhooks/[id]/route'
import { GET as deliveriesRoute } from '@/app/api/orgs/[orgId]/webhooks/[id]/deliveries/route'
import { POST as redeliverRoute } from '@/app/api/orgs/[orgId]/webhooks/[id]/deliveries/[deliveryId]/redeliver/route'
import { POST as rotateRoute } from '@/app/api/orgs/[orgId]/webhooks/[id]/rotate-secret/route'
import { POST as testRoute } from '@/app/api/orgs/[orgId]/webhooks/[id]/test/route'
import { env, resetEnvCache } from '@/env'
import { webhookSubscribes } from '@/lib/webhook-events'
import type { WebhookDeliveryRow, WebhookEndpointRow } from '@/lib/webhooks'
import type {
  Heartbeat,
  Monitor,
  Organization,
  StatusPage,
  User,
  WebhookDelivery,
  WebhookEndpoint,
} from '@/payload-types'
import { emitHeartbeat } from '@/server/engine/hooks'
import { processWebhookDeliveryJob } from '@/server/webhooks/deliver'
import { emitWebhookEvent } from '@/server/webhooks/events'
import {
  setWebhookJobSink,
  WEBHOOK_DELIVERY_ATTEMPTS,
  WEBHOOK_JOB_OPTIONS,
  WEBHOOK_RETRY_BASE_DELAY_MS,
  type WebhookJob,
} from '@/server/webhooks/queue'
import { verifyWebhookSignature } from '@/server/webhooks/signature'

/**
 * Outbound event webhooks (#157) against a local HTTP receiver: RBAC and secrets, event matching,
 * signatures, retries with backoff, the automatic disable, the delivery log, redelivery, test
 * events and secret rotation.
 */

let payload: Payload
const run = Date.now().toString(36)
const email = (name: string) => `${name}+whint-${run}@marmot.test`
const PASSWORD = 'password-123'

type Session = { user: User; cookie: string }
type Id = string | number

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

/** The session's user with its current memberships, for Local API calls as that user. */
async function asUser(session: Session) {
  const user = await payload.findByID({ collection: 'users', id: session.user.id, depth: 0 })
  return { ...user, collection: 'users' as const }
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

// ---------------------------------------------------------------------------------------------
// Local receiver: `/ok` answers 200, `/fail` 500, `/gone` 404, `/long` 200 with a 5 KB body.

interface Received {
  path: string
  headers: http.IncomingHttpHeaders
  body: string
}

let server: http.Server
let receiverUrl: string
const received: Received[] = []

const receivedAt = (path: string) => received.filter((r) => r.path === path)

// Jobs the inline sink ran; `runJobs` false only collects them (retry tests drive them by hand).
const sunk: WebhookJob[] = []
let runJobs = true

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeout = 5_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** Independent receiver-side check, written from the documented algorithm. */
function verifyLikeDocs(secret: string, raw: string, header: string): boolean {
  const parts = header.split(',').map((part) => part.trim().split('='))
  const t = Number(parts.find(([key]) => key === 't')?.[1])
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > 300) return false
  const expected = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')
  return parts.some(([key, value]) => key === 'v1' && value === expected)
}

let orgA: Organization
let orgB: Organization
let owner: Session
let admin: Session
let member: Session
let viewer: Session
let outsider: Session
let page: StatusPage

async function createEndpoint(
  session: Session,
  body: Record<string, unknown>,
  org: Organization = orgA,
) {
  const response = await createRoute(
    request(`${BASE}/${org.id}/webhooks`, { method: 'POST', body, session }),
    orgParams(org.id),
  )
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

async function deliveriesOf(endpointId: Id): Promise<WebhookDelivery[]> {
  const { docs } = await payload.find({
    collection: 'webhook-deliveries',
    where: { endpoint: { equals: endpointId } },
    sort: '-createdAt',
    depth: 0,
    limit: 100,
    overrideAccess: true,
  })
  return docs as WebhookDelivery[]
}

/** The job of the newest delivery of `endpointId` (stray jobs of other events may be queued too). */
async function latestJob(endpointId: Id): Promise<WebhookJob> {
  const [row] = await deliveriesOf(endpointId)
  const job = sunk.find((entry) => entry.data.deliveryId === String(row.id))
  if (!job) throw new Error('no job queued for the delivery')
  return job
}

const loadEndpoint = (id: Id) =>
  payload.findByID({
    collection: 'webhook-endpoints',
    id,
    depth: 0,
    overrideAccess: true,
  }) as Promise<WebhookEndpoint>

describe('outbound webhooks', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const path = req.url ?? '/'
        received.push({ path, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
        if (path === '/fail') res.writeHead(500).end('boom')
        else if (path === '/gone') res.writeHead(404).end('no such hook')
        else if (path === '/long') {
          res.writeHead(200, { 'x-auth-token': 'abc' }).end('x'.repeat(5_000))
        } else res.writeHead(200, { 'x-auth-token': 'abc' }).end('{"ok":true}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    receiverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    setWebhookJobSink(async (jobs) => {
      sunk.push(...jobs)
      if (!runJobs) return
      for (const job of jobs) {
        await processWebhookDeliveryJob(payload, {
          data: job.data,
          attemptsMade: 0,
          opts: job.opts,
        }).catch(() => undefined)
      }
    })

    orgA = await payload.create({
      collection: 'organizations',
      data: { name: 'Hooks A', slug: `hooks-a-${run}` },
    })
    orgB = await payload.create({
      collection: 'organizations',
      data: { name: 'Hooks B', slug: `hooks-b-${run}` },
    })
    owner = await createMember('owner', orgA, 'owner')
    admin = await createMember('admin', orgA, 'admin')
    member = await createMember('member', orgA, 'member')
    viewer = await createMember('viewer', orgA, 'viewer')
    outsider = await createMember('outsider', orgB, 'owner')
    page = (await payload.create({
      collection: 'status-pages',
      data: { organization: orgA.id, title: 'Hooks status', slug: `hooks-${run}`, published: true },
      depth: 0,
      overrideAccess: true,
    })) as StatusPage
  })

  afterEach(() => {
    runJobs = true
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    setWebhookJobSink(null)
    delete process.env.WEBHOOK_DISABLE_AFTER_FAILURES
    delete process.env.MONITOR_DENY_PRIVATE_ADDRESSES
    resetEnvCache()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const orgIds = [orgA?.id, orgB?.id].filter(Boolean)
    if (orgIds.length) {
      await payload.delete({ collection: 'incidents', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'status-pages', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'monitors', where: { organization: { in: orgIds } } })
      // Deleting the organizations removes their endpoints and delivery logs (beforeDelete).
      await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
      const left = await payload.count({
        collection: 'webhook-endpoints',
        where: { organization: { in: orgIds } },
        overrideAccess: true,
      })
      expect(left.totalDocs).toBe(0)
    }
    await payload.delete({ collection: 'users', where: { email: { like: `+whint-${run}@` } } })
  })

  describe('access and secrets', () => {
    let endpointId: string

    it('lets admins create an endpoint and shows the secret once', async () => {
      const created = await createEndpoint(admin, {
        url: `${receiverUrl}/ok`,
        events: ['monitor.created'],
        description: 'CMDB sync',
      })
      expect(created.status).toBe(201)
      expect(String(created.json.secret)).toMatch(/^whsec_[A-Za-z0-9_-]{40,}$/)
      const doc = created.json.doc as WebhookEndpointRow
      expect(doc).not.toHaveProperty('secret')
      expect(doc.events).toEqual(['monitor.created'])
      endpointId = doc.id

      const listed = await listRoute(
        request(`${BASE}/${orgA.id}/webhooks`, { session: admin }),
        orgParams(orgA.id),
      )
      expect(listed.status).toBe(200)
      const body = await listed.json()
      expect(JSON.stringify(body)).not.toContain(String(created.json.secret))
      expect(body.eventGroups.length).toBeGreaterThan(5)

      // Local API as the admin: the secret field is stripped.
      const asAdmin = await payload.findByID({
        collection: 'webhook-endpoints',
        id: doc.id,
        user: await asUser(admin),
        overrideAccess: false,
      })
      expect(asAdmin).not.toHaveProperty('secret')
      expect(asAdmin).not.toHaveProperty('previousSecret')
    })

    it('hides endpoints and deliveries from members, viewers and other organizations', async () => {
      for (const session of [member, viewer]) {
        const response = await listRoute(
          request(`${BASE}/${orgA.id}/webhooks`, { session }),
          orgParams(orgA.id),
        )
        expect(response.status).toBe(403)
        const created = await createEndpoint(session, { url: `${receiverUrl}/ok`, events: ['*'] })
        expect(created.status).toBe(403)
        // Collection access refuses them outright (no organization grants `webhook:read`).
        await expect(
          payload.find({
            collection: 'webhook-endpoints',
            user: await asUser(session),
            overrideAccess: false,
          }),
        ).rejects.toThrow()
        const deliveries = await deliveriesRoute(
          request(`${BASE}/${orgA.id}/webhooks/${endpointId}/deliveries`, { session }),
          idParams(orgA.id, endpointId),
        )
        expect(deliveries.status).toBe(403)
      }

      expect(
        (
          await listRoute(
            request(`${BASE}/${orgA.id}/webhooks`, { session: outsider }),
            orgParams(orgA.id),
          )
        ).status,
      ).toBe(403)
      // Through their own organization's URL the endpoint of A does not exist.
      const foreign = await getRoute(
        request(`${BASE}/${orgB.id}/webhooks/${endpointId}`, { session: outsider }),
        idParams(orgB.id, endpointId),
      )
      expect(foreign.status).toBe(404)
    })

    it('validates the URL and the events', async () => {
      expect(
        (await createEndpoint(admin, { url: 'ftp://example.com/x', events: ['*'] })).status,
      ).toBe(400)
      expect((await createEndpoint(admin, { url: `${receiverUrl}/ok`, events: [] })).status).toBe(
        400,
      )
      expect(
        (await createEndpoint(admin, { url: `${receiverUrl}/ok`, events: ['monitor.exploded'] }))
          .status,
      ).toBe(400)

      process.env.MONITOR_DENY_PRIVATE_ADDRESSES = 'true'
      resetEnvCache()
      try {
        const blocked = await createEndpoint(admin, { url: `${receiverUrl}/ok`, events: ['*'] })
        expect(blocked.status).toBe(400)
        expect(String(blocked.json.error)).toContain('MONITOR_DENY_PRIVATE_ADDRESSES')
      } finally {
        delete process.env.MONITOR_DENY_PRIVATE_ADDRESSES
        resetEnvCache()
      }
    })

    it('matches exact types, group wildcards and *', () => {
      expect(webhookSubscribes(['incident.*'], 'incident.opened')).toBe(true)
      expect(webhookSubscribes(['incident.*'], 'incident_update.created')).toBe(false)
      expect(webhookSubscribes(['incident.*'], 'monitor.down')).toBe(false)
      expect(webhookSubscribes(['*'], 'member.removed')).toBe(true)
      expect(webhookSubscribes(['monitor.down'], 'monitor.up')).toBe(false)
      expect(webhookSubscribes([], 'webhook.test')).toBe(true)
    })

    it('records endpoint changes in the audit log without the secret', async () => {
      const rows = await waitFor(async () => {
        const { docs } = await payload.find({
          collection: 'audit-logs',
          where: {
            and: [
              { action: { equals: 'webhook_endpoint.created' } },
              { entityId: { equals: endpointId } },
            ],
          },
          overrideAccess: true,
        })
        return docs.length ? docs : null
      })
      expect(JSON.stringify(rows[0].after)).not.toMatch(/whsec_/)
    })
  })

  describe('incident events', () => {
    it('delivers signed incident.* payloads that verify with the documented algorithm', async () => {
      const created = await createEndpoint(owner, {
        url: `${receiverUrl}/incidents`,
        events: ['incident.*'],
      })
      expect(created.status).toBe(201)
      const secret = String(created.json.secret)
      const endpointId = (created.json.doc as WebhookEndpointRow).id

      const incident = await payload.create({
        collection: 'incidents',
        data: {
          organization: orgA.id,
          statusPage: page.id,
          title: 'API errors',
          updates: [
            {
              status: 'investigating',
              postedAt: new Date().toISOString(),
              message: 'Looking into it',
            },
          ],
        },
        user: await asUser(owner),
        overrideAccess: false,
      })

      const hits = await waitFor(async () => {
        const list = receivedAt('/incidents')
        return list.length >= 3 ? list : null
      })
      const types = hits.map((hit) => JSON.parse(hit.body).type).sort()
      expect(types).toEqual(['incident.created', 'incident.opened', 'incident.update_posted'])

      for (const hit of hits) {
        const signature = String(hit.headers['x-marmot-signature'])
        expect(signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
        expect(verifyWebhookSignature(secret, hit.body, signature)).toBe(true)
        expect(verifyLikeDocs(secret, hit.body, signature)).toBe(true)
        expect(verifyWebhookSignature('whsec_wrong', hit.body, signature)).toBe(false)
        expect(hit.headers['x-marmot-webhook-version']).toBe('1')
        expect(hit.headers['content-type']).toBe('application/json')
        const envelope = JSON.parse(hit.body)
        expect(Object.keys(envelope).sort()).toEqual(['createdAt', 'data', 'id', 'orgId', 'type'])
        expect(envelope.orgId).toBe(String(orgA.id))
        expect(envelope.id).toMatch(/^evt_/)
        expect(hit.headers['x-marmot-event']).toBe(envelope.type)
      }
      const opened = JSON.parse(
        hits.find((h) => JSON.parse(h.body).type === 'incident.opened')!.body,
      )
      expect(opened.data.incident).toMatchObject({ id: String(incident.id), title: 'API errors' })
      expect(opened.data.update).toMatchObject({
        status: 'investigating',
        message: 'Looking into it',
      })

      // Resolving posts another update: incident.resolved + incident.update_posted (+ updated).
      received.length = 0
      const fresh = await payload.findByID({ collection: 'incidents', id: incident.id, depth: 0 })
      await payload.update({
        collection: 'incidents',
        id: incident.id,
        data: {
          updates: [
            ...(fresh.updates ?? []),
            { status: 'resolved', postedAt: new Date().toISOString(), message: 'Fixed' },
          ],
        },
        user: await asUser(owner),
        overrideAccess: false,
      })
      const later = await waitFor(async () => {
        const list = receivedAt('/incidents')
        return list.length >= 3 ? list : null
      })
      expect(later.map((hit) => JSON.parse(hit.body).type).sort()).toEqual([
        'incident.resolved',
        'incident.update_posted',
        'incident.updated',
      ])

      // A monitor change is not an incident event.
      received.length = 0
      await payload.create({
        collection: 'monitors',
        data: {
          organization: orgA.id,
          name: 'Not an incident',
          type: 'push',
          interval: 60,
        } as RequiredDataFromCollectionSlug<'monitors'>,
        user: await asUser(owner),
        overrideAccess: false,
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(receivedAt('/incidents')).toHaveLength(0)

      const log = await deliveriesOf(endpointId)
      expect(log.length).toBe(6)
      expect(log.every((row) => row.state === 'succeeded' && row.attempts === 1)).toBe(true)
    })
  })

  describe('monitor state events', () => {
    it('sends monitor.down for a notifying beat and skips reminders', async () => {
      const created = await createEndpoint(owner, {
        url: `${receiverUrl}/monitors`,
        events: ['monitor.down', 'monitor.up'],
      })
      expect(created.status).toBe(201)
      const monitor = (await payload.create({
        collection: 'monitors',
        data: {
          organization: orgA.id,
          name: 'Checkout',
          type: 'http',
          url: 'https://user:hunter2@shop.example.com/health?token=abc',
          interval: 60,
        } as RequiredDataFromCollectionSlug<'monitors'>,
        depth: 0,
        overrideAccess: true,
      })) as Monitor
      const heartbeat = {
        id: 991,
        monitor: monitor.id,
        status: 'down',
        msg: 'HTTP 503',
        ping: 120,
        time: new Date().toISOString(),
      } as unknown as Heartbeat
      const base = {
        payload,
        monitor,
        heartbeat,
        previousStatus: 'up' as const,
        isFirstBeat: false,
        organizationId: orgA.id,
      }
      received.length = 0
      await emitHeartbeat({ ...base, notify: true, notificationEvent: 'reminder' })
      await emitHeartbeat({ ...base, notify: false, notificationEvent: null })
      await emitHeartbeat({ ...base, notify: true, notificationEvent: 'down' })

      const [hit] = await waitFor(async () => {
        const list = receivedAt('/monitors')
        return list.length ? list : null
      })
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(receivedAt('/monitors')).toHaveLength(1)
      const envelope = JSON.parse(hit.body)
      expect(envelope.type).toBe('monitor.down')
      expect(envelope.data).toMatchObject({
        monitor: { id: String(monitor.id), name: 'Checkout', type: 'http' },
        status: 'down',
        previousStatus: 'up',
        heartbeat: { msg: 'HTTP 503', ping: 120 },
      })
      // Credentials and query strings of the monitored URL never leave Marmot.
      expect(envelope.data.monitor.url).toBe('https://shop.example.com/health')
      expect(hit.body).not.toContain('hunter2')
    })
  })

  describe('retries, automatic disable and the delivery log', () => {
    it('retries with exponential backoff for about a day', () => {
      expect(WEBHOOK_JOB_OPTIONS.attempts).toBe(WEBHOOK_DELIVERY_ATTEMPTS)
      expect(WEBHOOK_JOB_OPTIONS.backoff).toMatchObject({ type: 'exponential' })
      let total = 0
      for (let attempt = 1; attempt < WEBHOOK_DELIVERY_ATTEMPTS; attempt += 1) {
        total += WEBHOOK_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)
      }
      expect(total).toBeGreaterThan(20 * 3600 * 1000)
      expect(total).toBeLessThanOrEqual(24 * 3600 * 1000)
    })

    it('retries a failing endpoint and disables it after the threshold, emailing admins', async () => {
      process.env.WEBHOOK_DISABLE_AFTER_FAILURES = '2'
      resetEnvCache()
      const sendEmail = vi.spyOn(payload, 'sendEmail').mockResolvedValue(undefined as never)
      runJobs = false

      const created = await createEndpoint(admin, {
        url: `${receiverUrl}/fail`,
        events: ['maintenance.*'],
      })
      const endpointId = (created.json.doc as WebhookEndpointRow).id

      const deliverOnce = async () => {
        sunk.length = 0
        const queued = await emitWebhookEvent(payload, {
          type: 'maintenance.started',
          orgId: orgA.id,
          data: { maintenance: { id: '1', title: 'DB upgrade' } },
        })
        expect(queued).toBe(1)
        const job = await latestJob(endpointId)
        expect(job.opts.attempts).toBe(WEBHOOK_DELIVERY_ATTEMPTS)
        expect(job.opts.backoff).toMatchObject({ type: 'exponential' })
        // First attempt: 500 → retrying, the job throws so BullMQ schedules the next attempt.
        await expect(
          processWebhookDeliveryJob(payload, { data: job.data, attemptsMade: 0, opts: job.opts }),
        ).rejects.toThrow('HTTP 500')
        const retrying = await payload.findByID({
          collection: 'webhook-deliveries',
          id: job.data.deliveryId,
          overrideAccess: true,
        })
        expect(retrying).toMatchObject({ state: 'retrying', attempts: 1, responseStatus: 500 })
        // Last attempt: failed for good.
        const result = await processWebhookDeliveryJob(payload, {
          data: job.data,
          attemptsMade: WEBHOOK_DELIVERY_ATTEMPTS - 1,
          opts: job.opts,
        })
        expect(result.outcome).toBe('failed')
        return job
      }

      await deliverOnce()
      let endpoint = await loadEndpoint(endpointId)
      expect(endpoint).toMatchObject({ active: true, consecutiveFailures: 1 })
      expect(sendEmail).not.toHaveBeenCalled()

      await deliverOnce()
      endpoint = await loadEndpoint(endpointId)
      expect(endpoint).toMatchObject({
        active: false,
        consecutiveFailures: 2,
        disabledReason: 'failures',
      })
      // Owner and admin of the organization, not the member or the viewer.
      const recipients = sendEmail.mock.calls.map(([message]) => (message as { to: string }).to)
      expect(recipients.sort()).toEqual([email('admin'), email('owner')].sort())
      expect((sendEmail.mock.calls[0][0] as { subject: string }).subject).toContain('/fail')

      // A disabled endpoint receives no new events; queued retries are cancelled.
      expect(
        await emitWebhookEvent(payload, { type: 'maintenance.started', orgId: orgA.id, data: {} }),
      ).toBe(0)
      const pending = await payload.create({
        collection: 'webhook-deliveries',
        data: {
          organization: orgA.id,
          endpoint: endpoint.id,
          eventId: 'evt_x',
          eventType: 'maintenance.started',
          trigger: 'event',
          state: 'retrying',
          body: { id: 'evt_x', type: 'maintenance.started', createdAt: '', orgId: '', data: {} },
        },
        overrideAccess: true,
      })
      expect(
        (await processWebhookDeliveryJob(payload, { data: { deliveryId: String(pending.id) } }))
          .outcome,
      ).toBe('cancelled')

      // The disable is in the audit log as webhook_endpoint.disabled.
      await waitFor(async () => {
        const { totalDocs } = await payload.count({
          collection: 'audit-logs',
          where: {
            and: [
              { action: { equals: 'webhook_endpoint.disabled' } },
              { entityId: { equals: String(endpointId) } },
            ],
          },
          overrideAccess: true,
        })
        return totalDocs > 0
      })

      // Re-enabling resets the failure streak.
      const patched = await patchRoute(
        request(`${BASE}/${orgA.id}/webhooks/${endpointId}`, {
          method: 'PATCH',
          body: { active: true },
          session: admin,
        }),
        idParams(orgA.id, endpointId),
      )
      expect(patched.status).toBe(200)
      expect((await patched.json()).doc).toMatchObject({
        active: true,
        consecutiveFailures: 0,
        disabledReason: null,
      })
      await payload.delete({
        collection: 'webhook-endpoints',
        id: endpointId,
        overrideAccess: true,
      })
    })

    it('fails a 4xx answer at once without retrying', async () => {
      runJobs = false
      const created = await createEndpoint(admin, {
        url: `${receiverUrl}/gone`,
        events: ['maintenance.cancelled'],
      })
      const endpointId = (created.json.doc as WebhookEndpointRow).id
      await emitWebhookEvent(payload, { type: 'maintenance.cancelled', orgId: orgA.id, data: {} })
      const job = await latestJob(endpointId)
      const result = await processWebhookDeliveryJob(payload, {
        data: job.data,
        attemptsMade: 0,
        opts: job.opts,
      })
      expect(result.outcome).toBe('failed')
      const [row] = await deliveriesOf(endpointId)
      expect(row).toMatchObject({ state: 'failed', attempts: 1, responseStatus: 404 })
      expect(row.responseBody).toBe('no such hook')
      expect((await loadEndpoint(endpointId)).consecutiveFailures).toBe(1)
    })

    it('refuses deliveries to blocked addresses without retrying', async () => {
      runJobs = false
      const created = await createEndpoint(admin, {
        url: `${receiverUrl}/ok`,
        events: ['maintenance.reminder'],
      })
      const endpointId = (created.json.doc as WebhookEndpointRow).id
      await emitWebhookEvent(payload, { type: 'maintenance.reminder', orgId: orgA.id, data: {} })
      const job = await latestJob(endpointId)
      process.env.MONITOR_DENY_PRIVATE_ADDRESSES = 'true'
      resetEnvCache()
      try {
        const result = await processWebhookDeliveryJob(payload, {
          data: job.data,
          attemptsMade: 0,
          opts: job.opts,
        })
        expect(result.outcome).toBe('failed')
      } finally {
        delete process.env.MONITOR_DENY_PRIVATE_ADDRESSES
        resetEnvCache()
      }
      const [row] = await deliveriesOf(endpointId)
      expect(row.state).toBe('failed')
      expect(row.error).toContain('MONITOR_DENY_PRIVATE_ADDRESSES')
      await payload.delete({
        collection: 'webhook-endpoints',
        id: endpointId,
        overrideAccess: true,
      })
    })

    it('logs requests and responses with secrets redacted and bodies truncated, and redelivers', async () => {
      const created = await createEndpoint(admin, {
        url: `${receiverUrl}/long`,
        events: ['tag.deleted'],
      })
      const endpointId = (created.json.doc as WebhookEndpointRow).id
      received.length = 0

      // Send test event: one attempt now, whatever the subscription.
      const tested = await testRoute(
        request(`${BASE}/${orgA.id}/webhooks/${endpointId}/test`, {
          method: 'POST',
          session: admin,
        }),
        idParams(orgA.id, endpointId),
      )
      expect(tested.status).toBe(200)
      const test = (await tested.json()).delivery as WebhookDeliveryRow
      expect(test).toMatchObject({ trigger: 'test', state: 'succeeded', eventType: 'webhook.test' })
      expect(test.responseBody!.length).toBeLessThanOrEqual(2049)
      expect(test.requestHeaders!['X-Marmot-Signature']).toMatch(/^t=\d+,v1=\[redacted\]$/)

      // The log as the admin; members cannot redeliver.
      const listed = await deliveriesRoute(
        request(`${BASE}/${orgA.id}/webhooks/${endpointId}/deliveries`, { session: admin }),
        idParams(orgA.id, endpointId),
      )
      const page = await listed.json()
      expect(page.docs[0].id).toBe(test.id)
      expect(page.docs[0].responseHeaders['x-auth-token']).toBe('[redacted]')

      const denied = await redeliverRoute(
        request(`${BASE}/${orgA.id}/webhooks/${endpointId}/deliveries/${test.id}/redeliver`, {
          method: 'POST',
          session: member,
        }),
        {
          params: Promise.resolve({ orgId: String(orgA.id), id: endpointId, deliveryId: test.id }),
        },
      )
      expect(denied.status).toBe(403)

      const redelivered = await redeliverRoute(
        request(`${BASE}/${orgA.id}/webhooks/${endpointId}/deliveries/${test.id}/redeliver`, {
          method: 'POST',
          session: admin,
        }),
        {
          params: Promise.resolve({ orgId: String(orgA.id), id: endpointId, deliveryId: test.id }),
        },
      )
      expect(redelivered.status).toBe(201)
      const again = (await redelivered.json()).delivery as WebhookDeliveryRow
      expect(again).toMatchObject({
        trigger: 'redelivery',
        state: 'succeeded',
        eventId: test.eventId,
        redeliveryOf: test.id,
      })
      expect(again.id).not.toBe(test.id)

      const hits = receivedAt('/long')
      expect(hits).toHaveLength(2)
      expect(hits[0].body).toBe(hits[1].body)
      expect(hits[0].headers['x-marmot-delivery']).not.toBe(hits[1].headers['x-marmot-delivery'])
    })

    it('rotates the secret and signs with both secrets for a grace period', async () => {
      const created = await createEndpoint(admin, {
        url: `${receiverUrl}/rotate`,
        events: ['tag.deleted'],
      })
      const oldSecret = String(created.json.secret)
      const endpointId = (created.json.doc as WebhookEndpointRow).id

      const rotated = await rotateRoute(
        request(`${BASE}/${orgA.id}/webhooks/${endpointId}/rotate-secret`, {
          method: 'POST',
          session: admin,
        }),
        idParams(orgA.id, endpointId),
      )
      expect(rotated.status).toBe(200)
      const body = await rotated.json()
      const newSecret = String(body.secret)
      expect(newSecret).not.toBe(oldSecret)
      expect(body.doc.previousSecretExpiresAt).toBeTruthy()

      received.length = 0
      await testRoute(
        request(`${BASE}/${orgA.id}/webhooks/${endpointId}/test`, {
          method: 'POST',
          session: admin,
        }),
        idParams(orgA.id, endpointId),
      )
      const [hit] = receivedAt('/rotate')
      const signature = String(hit.headers['x-marmot-signature'])
      expect(signature.match(/v1=/g)).toHaveLength(2)
      expect(verifyWebhookSignature(newSecret, hit.body, signature)).toBe(true)
      expect(verifyWebhookSignature(oldSecret, hit.body, signature)).toBe(true)
    })

    it('deletes an endpoint together with its delivery log', async () => {
      const created = await createEndpoint(admin, {
        url: `${receiverUrl}/ok`,
        events: ['tag.deleted'],
      })
      const endpointId = (created.json.doc as WebhookEndpointRow).id
      await testRoute(
        request(`${BASE}/${orgA.id}/webhooks/${endpointId}/test`, {
          method: 'POST',
          session: admin,
        }),
        idParams(orgA.id, endpointId),
      )
      expect(await deliveriesOf(endpointId)).toHaveLength(1)
      const deleted = await deleteRoute(
        request(`${BASE}/${orgA.id}/webhooks/${endpointId}`, { method: 'DELETE', session: admin }),
        idParams(orgA.id, endpointId),
      )
      expect(deleted.status).toBe(200)
      expect(await deliveriesOf(endpointId)).toHaveLength(0)
    })
  })
})
