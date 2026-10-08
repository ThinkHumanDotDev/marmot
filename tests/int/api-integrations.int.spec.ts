import { getPayload, type Payload, type RequiredDataFromCollectionSlug } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import type { Role } from '@/access/permissions'
import { GET as badgeRoute } from '@/app/api/badge/[monitorId]/[...path]/route'
import { GET as metricsRoute } from '@/app/api/metrics/route'
import { GET as listKeys, POST as createKey } from '@/app/api/orgs/[orgId]/api-keys/route'
import { DELETE as deleteKey, PATCH as patchKey } from '@/app/api/orgs/[orgId]/api-keys/[id]/route'
import { POST as pushRoute } from '@/app/api/push/[token]/route'
import { env } from '@/env'
import type { ApiKey, Heartbeat, Monitor, Organization, User } from '@/payload-types'
import {
  apiKeyStatus,
  authenticateApiKey,
  extractApiKey,
  generateApiKey,
  hashApiKey,
} from '@/server/api-keys'
import { buildRegistry, monitorLabelValues } from '@/server/metrics/prometheus'
import { hasStatusPages } from '@/server/badges'

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+apiint-${run}@marmot.test`
const PASSWORD = 'password-123'

type Session = { user: User; cookie: string }

async function createMember(name: string, org: Organization | null, role: Role): Promise<Session> {
  const user = await payload.create({
    collection: 'users',
    data: { email: email(name), password: PASSWORD, name },
  })
  if (org) await addOrgMembership({ payload, userId: user.id, orgId: org.id, role })
  const { token } = await payload.login({
    collection: 'users',
    data: { email: email(name), password: PASSWORD },
  })
  return { user, cookie: `payload-token=${token}` }
}

/** Browser-like request: Payload only honours the cookie when `Origin` passes its CSRF allowlist. */
function request(
  url: string,
  init: {
    method?: string
    body?: unknown
    session?: Session
    headers?: Record<string, string>
  } = {},
): Request {
  return new Request(url, {
    method: init.method ?? 'GET',
    headers: {
      Origin: env.NEXT_PUBLIC_SERVER_URL,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.session ? { cookie: init.session.cookie } : {}),
      ...init.headers,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
}

const orgParams = (orgId: string | number, id?: string | number) =>
  Promise.resolve({ orgId: String(orgId), id: String(id ?? '') })

async function createPushMonitor(org: Organization, name: string, extra: Partial<Monitor> = {}) {
  return (await payload.create({
    collection: 'monitors',
    overrideAccess: true,
    depth: 0,
    data: {
      organization: org.id,
      name,
      type: 'push',
      interval: 60,
      retryInterval: 20,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 5,
      ...extra,
    } as RequiredDataFromCollectionSlug<'monitors'>,
  })) as Monitor
}

async function heartbeatsOf(monitor: Monitor): Promise<Heartbeat[]> {
  const { docs } = await payload.find({
    collection: 'heartbeats',
    where: { monitor: { equals: monitor.id } },
    sort: 'time',
    depth: 0,
    limit: 100,
    overrideAccess: true,
  })
  return docs as Heartbeat[]
}

const reload = (monitor: Monitor) =>
  payload.findByID({ collection: 'monitors', id: monitor.id, depth: 0 }) as Promise<Monitor>

let orgA: Organization
let orgB: Organization
let admin: Session
let member: Session
let outsider: Session

describe('API keys, push, metrics and badges', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    orgA = await payload.create({
      collection: 'organizations',
      data: { name: 'API A', slug: `api-a-${run}` },
    })
    orgB = await payload.create({
      collection: 'organizations',
      data: { name: 'API B', slug: `api-b-${run}` },
    })
    admin = await createMember('admin', orgA, 'admin')
    member = await createMember('member', orgA, 'member')
    outsider = await createMember('outsider', orgB, 'owner')
  })

  afterAll(async () => {
    const orgIds = [orgA?.id, orgB?.id].filter(Boolean)
    if (orgIds.length) {
      await payload.delete({ collection: 'monitors', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
    }
    await payload.delete({
      collection: 'users',
      where: { email: { like: `+apiint-${run}@marmot.test` } },
    })
  })

  describe('key format', () => {
    it('generates mk_<prefix>_<secret> keys and hashes them with sha256', () => {
      const generated = generateApiKey()
      expect(generated.key).toMatch(/^mk_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/)
      expect(generated.prefix).toHaveLength(8)
      expect(generated.keyHash).toBe(hashApiKey(generated.key))
      expect(generateApiKey().key).not.toBe(generated.key)
    })

    it('extracts keys from X-API-Key, Bearer and Basic headers', () => {
      const { key } = generateApiKey()
      expect(extractApiKey(new Headers({ 'x-api-key': key }))).toBe(key)
      expect(extractApiKey(new Headers({ authorization: `Bearer ${key}` }))).toBe(key)
      const basic = Buffer.from(`prometheus:${key}`).toString('base64')
      expect(extractApiKey(new Headers({ authorization: `Basic ${basic}` }))).toBe(key)
      expect(extractApiKey(new Headers({ authorization: 'Bearer nope' }))).toBeNull()
      expect(extractApiKey(new Headers({ authorization: 'JWT abc.def.ghi' }))).toBeNull()
      expect(extractApiKey(new Headers())).toBeNull()
    })

    it('computes active / inactive / expired', () => {
      const now = new Date('2030-01-01T00:00:00Z')
      expect(apiKeyStatus({ active: true, expiresAt: null }, now)).toBe('active')
      expect(apiKeyStatus({ active: false, expiresAt: null }, now)).toBe('inactive')
      expect(apiKeyStatus({ active: true, expiresAt: '2029-12-31T00:00:00Z' }, now)).toBe('expired')
    })
  })

  describe('api-keys routes', () => {
    let created: { id: string; key: string }

    it('admins create keys and receive the plaintext once', async () => {
      const res = await createKey(
        request(`http://localhost/api/orgs/${orgA.id}/api-keys`, {
          method: 'POST',
          body: { name: 'Prometheus', expiresInDays: 30 },
          session: admin,
        }),
        { params: orgParams(orgA.id) },
      )
      expect(res.status).toBe(201)
      const body = (await res.json()) as { doc: Record<string, unknown>; key: string }
      expect(body.key).toMatch(/^mk_/)
      expect(body.doc).toMatchObject({ name: 'Prometheus', active: true, status: 'active' })
      expect(body.doc.keyHash).toBeUndefined()
      expect(body.doc.expiresAt).toBeTruthy()
      created = { id: String(body.doc.id), key: body.key }

      // Only the hash is stored, and it never leaves the server through the list.
      const stored = (await payload.findByID({
        collection: 'api-keys',
        id: body.doc.id as string,
        depth: 0,
      })) as ApiKey
      expect(stored.keyHash).toBe(hashApiKey(body.key))
      expect(stored.prefix).toBe(body.key.split('_')[1])

      const list = await listKeys(
        request(`http://localhost/api/orgs/${orgA.id}/api-keys`, { session: admin }),
        { params: orgParams(orgA.id) },
      )
      expect(list.status).toBe(200)
      const { docs } = (await list.json()) as { docs: Record<string, unknown>[] }
      expect(docs.map((d) => d.id)).toContain(created.id)
      expect(docs.every((d) => d.keyHash === undefined && d.key === undefined)).toBe(true)
    })

    it('members and outsiders may not manage keys; anonymous is 401', async () => {
      const asMember = await createKey(
        request(`http://localhost/api/orgs/${orgA.id}/api-keys`, {
          method: 'POST',
          body: { name: 'nope' },
          session: member,
        }),
        { params: orgParams(orgA.id) },
      )
      expect(asMember.status).toBe(403)
      const asOutsider = await listKeys(
        request(`http://localhost/api/orgs/${orgA.id}/api-keys`, { session: outsider }),
        { params: orgParams(orgA.id) },
      )
      expect(asOutsider.status).toBe(403)
      const anonymous = await listKeys(request(`http://localhost/api/orgs/${orgA.id}/api-keys`), {
        params: orgParams(orgA.id),
      })
      expect(anonymous.status).toBe(401)
    })

    it('rejects an empty name and a past expiry', async () => {
      const noName = await createKey(
        request(`http://localhost/api/orgs/${orgA.id}/api-keys`, {
          method: 'POST',
          body: { name: '  ' },
          session: admin,
        }),
        { params: orgParams(orgA.id) },
      )
      expect(noName.status).toBe(400)
      const past = await createKey(
        request(`http://localhost/api/orgs/${orgA.id}/api-keys`, {
          method: 'POST',
          body: { name: 'old', expiresAt: '2000-01-01T00:00:00.000Z' },
          session: admin,
        }),
        { params: orgParams(orgA.id) },
      )
      expect(past.status).toBe(400)
    })

    it('REST clients cannot smuggle their own keyHash', async () => {
      const forged = generateApiKey()
      await expect(
        payload.create({
          collection: 'api-keys',
          data: {
            organization: orgA.id,
            name: 'forged',
            scope: 'write',
            keyHash: forged.keyHash,
            prefix: forged.prefix,
          },
          user: { ...admin.user, collection: 'users' },
          overrideAccess: false,
        }),
      ).rejects.toThrow()
    })

    it('authenticates the key, stamps lastUsedAt and refuses disabled, expired, deleted keys', async () => {
      const auth = await authenticateApiKey(
        payload,
        request('http://localhost/api/metrics', {
          headers: { authorization: `Bearer ${created.key}` },
        }),
      )
      expect(auth).not.toBeNull()
      expect(String(auth?.organizationId)).toBe(String(orgA.id))

      // lastUsedAt is written in the background; poll briefly.
      let stamped: ApiKey | null = null
      for (let i = 0; i < 20 && !stamped?.lastUsedAt; i++) {
        await new Promise((r) => setTimeout(r, 50))
        stamped = (await payload.findByID({
          collection: 'api-keys',
          id: created.id,
          depth: 0,
        })) as ApiKey
      }
      expect(stamped?.lastUsedAt).toBeTruthy()

      const disabled = await patchKey(
        request(`http://localhost/api/orgs/${orgA.id}/api-keys/${created.id}`, {
          method: 'PATCH',
          body: { active: false },
          session: admin,
        }),
        { params: orgParams(orgA.id, created.id) },
      )
      expect(disabled.status).toBe(200)
      expect(((await disabled.json()) as { doc: { status: string } }).doc.status).toBe('inactive')
      expect(
        await authenticateApiKey(payload, { headers: new Headers({ 'x-api-key': created.key }) }),
      ).toBeNull()

      await patchKey(
        request(`http://localhost/api/orgs/${orgA.id}/api-keys/${created.id}`, {
          method: 'PATCH',
          body: { active: true },
          session: admin,
        }),
        { params: orgParams(orgA.id, created.id) },
      )
      expect(
        await authenticateApiKey(payload, { headers: new Headers({ 'x-api-key': created.key }) }),
      ).not.toBeNull()
      // Expired keys are rejected even while active.
      expect(
        await authenticateApiKey(
          payload,
          { headers: new Headers({ 'x-api-key': created.key }) },
          { now: new Date(Date.now() + 31 * 86_400_000) },
        ),
      ).toBeNull()

      // Outsiders cannot revoke somebody else's key; the owner's admin can.
      const foreign = await deleteKey(
        request(`http://localhost/api/orgs/${orgB.id}/api-keys/${created.id}`, {
          method: 'DELETE',
          session: outsider,
        }),
        { params: orgParams(orgB.id, created.id) },
      )
      expect(foreign.status).toBe(404)
      const revoked = await deleteKey(
        request(`http://localhost/api/orgs/${orgA.id}/api-keys/${created.id}`, {
          method: 'DELETE',
          session: admin,
        }),
        { params: orgParams(orgA.id, created.id) },
      )
      expect(revoked.status).toBe(200)
      expect(
        await authenticateApiKey(payload, { headers: new Headers({ 'x-api-key': created.key }) }),
      ).toBeNull()
    })
  })

  describe('push endpoint', () => {
    let monitor: Monitor

    beforeAll(async () => {
      monitor = await createPushMonitor(orgA, `push-${run}`)
      expect(monitor.pushToken).toBeTruthy()
    })

    const push = (token: string, query = '') =>
      pushRoute(request(`http://localhost/api/push/${token}${query}`, { method: 'POST' }), {
        params: Promise.resolve({ token }),
      })

    it('records an UP heartbeat and stamps lastPushAt', async () => {
      const before = Date.now()
      const res = await push(monitor.pushToken!, '?status=up&msg=hello&ping=12.5')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })

      const beats = await heartbeatsOf(monitor)
      expect(beats).toHaveLength(1)
      expect(beats[0]).toMatchObject({ status: 'up', msg: 'hello', ping: 12.5, important: true })

      const fresh = await reload(monitor)
      expect(fresh.status?.lastStatus).toBe('up')
      expect(fresh.status?.lastPing).toBe(12.5)
      expect(new Date(fresh.status!.lastPushAt!).getTime()).toBeGreaterThanOrEqual(before - 1000)
      expect(fresh.status?.lastCheckAt).toBe(fresh.status?.lastPushAt)
    })

    it('records DOWN with the given message and defaults to up/OK', async () => {
      expect((await push(monitor.pushToken!, '?status=down&msg=disk%20full')).status).toBe(200)
      expect((await push(monitor.pushToken!)).status).toBe(200)
      const beats = await heartbeatsOf(monitor)
      expect(beats.map((b) => b.status)).toEqual(['up', 'down', 'up'])
      expect(beats[1].msg).toBe('disk full')
      expect(beats[2].msg).toBe('OK')
      expect(beats[2].ping).toBeNull()
      expect(beats[1].important).toBe(true)
    })

    it('feeds the stats rollups (uptime badge data) from the web process', async () => {
      const { getUptime } = await import('@/server/stats/uptime-calculator')
      const uptime = await getUptime(payload, monitor.id, '24h')
      expect(uptime).toBeGreaterThan(0)
      expect(uptime).toBeLessThan(1)
    })

    it('answers 404 for unknown and paused tokens, 400 for an invalid ping', async () => {
      expect((await push('nope')).status).toBe(404)
      const paused = await createPushMonitor(orgA, `paused-${run}`, { active: false })
      expect((await push(paused.pushToken!)).status).toBe(404)
      const invalid = await push(monitor.pushToken!, '?ping=-5')
      expect(invalid.status).toBe(400)
      expect(await heartbeatsOf(monitor)).toHaveLength(3)
    })
  })

  describe('metrics endpoint', () => {
    let key: string
    let monitor: Monitor

    beforeAll(async () => {
      const res = await createKey(
        request(`http://localhost/api/orgs/${orgA.id}/api-keys`, {
          method: 'POST',
          body: { name: 'metrics' },
          session: admin,
        }),
        { params: orgParams(orgA.id) },
      )
      key = ((await res.json()) as { key: string }).key
      monitor = await createPushMonitor(orgA, `metrics-${run}`, {
        hostname: 'db.internal',
        port: 5432,
      })
      await pushRoute(
        request(`http://localhost/api/push/${monitor.pushToken}?ping=40`, { method: 'POST' }),
        { params: Promise.resolve({ token: monitor.pushToken! }) },
      )
    })

    it('is 401 without a valid key', async () => {
      const anonymous = await metricsRoute(request('http://localhost/api/metrics'))
      expect(anonymous.status).toBe(401)
      expect(anonymous.headers.get('www-authenticate')).toContain('Bearer')
      const session = await metricsRoute(
        request('http://localhost/api/metrics', { session: admin }),
      )
      expect(session.status).toBe(401)
      const bogus = await metricsRoute(
        request('http://localhost/api/metrics', { headers: { 'x-api-key': generateApiKey().key } }),
      )
      expect(bogus.status).toBe(401)
    })

    it('exposes the organization monitors with Kuma-compatible names and labels', async () => {
      const res = await metricsRoute(
        request('http://localhost/api/metrics', { headers: { authorization: `Bearer ${key}` } }),
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/plain')
      const body = await res.text()
      const labels = `monitor_id="${monitor.id}",monitor_name="${monitor.name}",monitor_type="push",monitor_url="",monitor_hostname="db.internal",monitor_port="5432"`
      expect(body).toContain('# TYPE monitor_status gauge')
      expect(body).toContain(`monitor_status{${labels}} 1`)
      expect(body).toContain(`monitor_response_time{${labels}} 40`)
      expect(body).toContain(`monitor_uptime_ratio{${labels},window="24h"} 1`)
      expect(body).toContain(`monitor_uptime_ratio{${labels},window="30d"} 1`)
      // Certificate gauges are only emitted for monitors that carry certInfo (cert job, #24).
      expect(body).toContain('# TYPE monitor_cert_days_remaining gauge')
      expect(body).not.toContain(`monitor_cert_is_valid{${labels}}`)
    })

    it('exposes response-time quantiles only when asked (?quantiles=true, #95)', async () => {
      const plain = await metricsRoute(
        request('http://localhost/api/metrics', { headers: { authorization: `Bearer ${key}` } }),
      )
      expect(await plain.text()).not.toContain('monitor_response_time_quantile')

      const res = await metricsRoute(
        request('http://localhost/api/metrics?quantiles=true', {
          headers: { authorization: `Bearer ${key}` },
        }),
      )
      expect(res.status).toBe(200)
      const body = await res.text()
      const labels = `monitor_id="${monitor.id}",monitor_name="${monitor.name}",monitor_type="push",monitor_url="",monitor_hostname="db.internal",monitor_port="5432"`
      expect(body).toContain('# TYPE monitor_response_time_quantile gauge')
      // One push with ping=40: every quantile is that ping (bounded by the exact min/max).
      for (const quantile of ['0.5', '0.75', '0.9', '0.95', '0.99']) {
        expect(body).toContain(
          `monitor_response_time_quantile{${labels},window="24h",quantile="${quantile}"} 40`,
        )
      }
      expect(body).toContain(`window="30d",quantile="0.95"} 40`)
    })

    it('is scoped to the key organization', async () => {
      const other = await createKey(
        request(`http://localhost/api/orgs/${orgB.id}/api-keys`, {
          method: 'POST',
          body: { name: 'b' },
          session: outsider,
        }),
        { params: orgParams(orgB.id) },
      )
      const otherKey = ((await other.json()) as { key: string }).key
      const res = await metricsRoute(
        request('http://localhost/api/metrics', { headers: { 'x-api-key': otherKey } }),
      )
      expect(res.status).toBe(200)
      expect(await res.text()).not.toContain(`monitor_id="${monitor.id}"`)
    })

    it('buildRegistry emits cert gauges and skips monitors without a status', async () => {
      const withCert = {
        ...monitor,
        certInfo: { valid: true, daysRemaining: 42 },
      } as unknown as Monitor
      const fresh = { ...monitor, id: 'fresh', status: null } as unknown as Monitor
      const registry = buildRegistry({
        monitors: [withCert, fresh],
        uptime: new Map([[String(monitor.id), { '24h': 0.5 }]]),
      })
      const text = await registry.metrics()
      const labels = Object.entries(monitorLabelValues(withCert))
        .map(([k, v]) => `${k}="${v}"`)
        .join(',')
      expect(text).toContain(`monitor_cert_is_valid{${labels}} 1`)
      expect(text).toContain(`monitor_cert_days_remaining{${labels}} 42`)
      expect(text).toContain(`monitor_uptime_ratio{${labels},window="24h"} 0.5`)
      expect(text).not.toContain(`window="30d"`)
      expect(text).not.toContain('monitor_status{monitor_id="fresh"')
      expect(text).toContain('monitor_response_time{monitor_id="fresh"')
    })
  })

  describe('badge endpoint', () => {
    let key: string
    let otherKey: string
    let monitor: Monitor

    const badge = (id: string | number, path: string[], headers: Record<string, string> = {}) =>
      badgeRoute(
        request(`http://localhost/api/badge/${id}/${path.join('/')}?label=x`, { headers }),
        {
          params: Promise.resolve({ monitorId: String(id), path }),
        },
      )

    beforeAll(async () => {
      const mint = async (org: Organization, session: Session) => {
        const res = await createKey(
          request(`http://localhost/api/orgs/${org.id}/api-keys`, {
            method: 'POST',
            body: { name: 'badges' },
            session,
          }),
          { params: orgParams(org.id) },
        )
        return ((await res.json()) as { key: string }).key
      }
      key = await mint(orgA, admin)
      otherKey = await mint(orgB, outsider)
      monitor = await createPushMonitor(orgA, `badge-${run}`)
      await pushRoute(
        request(`http://localhost/api/push/${monitor.pushToken}?ping=77`, { method: 'POST' }),
        { params: Promise.resolve({ token: monitor.pushToken! }) },
      )
    })

    it('is 404 without an API key of the monitor organization (unless on a status page)', async () => {
      expect((await badge(monitor.id, ['status'])).status).toBe(404)
      expect((await badge(monitor.id, ['status'], { 'x-api-key': otherKey })).status).toBe(404)
      expect((await badge(999_999, ['status'], { 'x-api-key': key })).status).toBe(404)
    })

    it('renders every badge type with the organization key', async () => {
      const auth = { 'x-api-key': key }
      const status = await badge(monitor.id, ['status'], auth)
      expect(status.status).toBe(200)
      expect(status.headers.get('content-type')).toContain('image/svg+xml')
      expect(status.headers.get('cache-control')).toBe('public, max-age=300')
      expect(status.headers.get('access-control-allow-origin')).toBe('*')
      const svg = await status.text()
      expect(svg).toContain('<svg')
      expect(svg).toContain('>Up<')

      expect(await (await badge(monitor.id, ['uptime'], auth)).text()).toContain('100.0%')
      expect(await (await badge(monitor.id, ['uptime', '30d'], auth)).text()).toContain('100.0%')
      expect(await (await badge(monitor.id, ['ping', '24'], auth)).text()).toContain('77ms')
      expect(await (await badge(monitor.id, ['avg-response', '1y'], auth)).text()).toContain('77ms')
      expect(await (await badge(monitor.id, ['response'], auth)).text()).toContain('77ms')
      expect(await (await badge(monitor.id, ['cert-exp'], auth)).text()).toContain('No/Bad Cert')
    })

    it('rejects unknown badge types and durations', async () => {
      const auth = { 'x-api-key': key }
      expect((await badge(monitor.id, ['nope'], auth)).status).toBe(404)
      expect((await badge(monitor.id, ['status', '24h'], auth)).status).toBe(404)
      expect((await badge(monitor.id, ['uptime', '7d'], auth)).status).toBe(400)
    })

    it('serves badges of monitors on a published status page without a key', async () => {
      if (!hasStatusPages(payload)) {
        // Status pages (#11) are not in this build; the access rule falls back to API keys only.
        expect(await badge(monitor.id, ['status']).then((r) => r.status)).toBe(404)
        return
      }
      const page = await payload.create({
        collection: 'status-pages' as 'monitors',
        data: {
          organization: orgA.id,
          title: `Badge page ${run}`,
          slug: `badge-page-${run}`,
          published: true,
          groups: [{ name: 'Core', monitors: [{ monitor: monitor.id }] }],
        } as unknown as RequiredDataFromCollectionSlug<'monitors'>,
        depth: 0,
        overrideAccess: true,
      })
      try {
        expect((await badge(monitor.id, ['status'])).status).toBe(200)
        await payload.update({
          collection: 'status-pages' as 'monitors',
          id: page.id,
          data: { published: false } as unknown as Partial<Monitor>,
          overrideAccess: true,
        })
        expect((await badge(monitor.id, ['status'])).status).toBe(404)
      } finally {
        await payload.delete({ collection: 'status-pages' as 'monitors', id: page.id })
      }
    })
  })
})
