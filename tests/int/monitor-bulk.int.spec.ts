import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import type { Role } from '@/access/permissions'
import { POST as bulkRoute } from '@/app/api/orgs/[orgId]/monitors/bulk/route'
import { env } from '@/env'
import type { BulkResponse } from '@/lib/monitor-bulk'
import { defaultMonitorValues } from '@/lib/validation/monitor'
import type { AuditLog, Monitor, Organization, User } from '@/payload-types'
import { generateApiKey } from '@/server/api-keys'
import { setOnDemandTransport, type OnDemandTransport } from '@/server/engine/on-demand'
import { runMonitorBulkAction } from '@/server/monitors/bulk'
import { monitorBulkBody } from '@/server/monitors/bulk-schema'
import type { RequestUser } from '@/server/monitors/http'
import type { RateLimiter } from '@/server/security/rate-limit'

/**
 * Bulk monitor actions (#124): `POST /api/orgs/:orgId/monitors/bulk`. Covers permissions, per-id
 * results, one audit row per changed monitor, tag and channel edits, queued checks with the
 * organization's on-demand budget and the API key write budget.
 */
let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+bulk-${run}@marmot.test`
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

const orgUrl = (org: Organization) => `http://localhost/api/orgs/${String(org.id)}/monitors/bulk`

function sessionRequest(org: Organization, body: unknown, session?: Session): Request {
  return new Request(orgUrl(org), {
    method: 'POST',
    headers: {
      Origin: env.NEXT_PUBLIC_SERVER_URL,
      'content-type': 'application/json',
      ...(session ? { cookie: session.cookie } : {}),
    },
    body: JSON.stringify(body),
  })
}

async function bulk(org: Organization, body: unknown, session?: Session) {
  const res = await bulkRoute(sessionRequest(org, body, session), {
    params: Promise.resolve({ orgId: String(org.id) }),
  })
  return { status: res.status, body: (await res.json()) as BulkResponse & { errors?: unknown } }
}

async function createMonitor(org: Organization, name: string, data: Partial<Monitor> = {}) {
  return payload.create({
    collection: 'monitors',
    data: {
      ...defaultMonitorValues('http'),
      name,
      url: 'http://localhost:3000/api/health',
      organization: org.id,
      active: true,
      ...data,
    } as never,
    depth: 0,
  })
}

const reload = (id: Id) => payload.findByID({ collection: 'monitors', id, depth: 0 })

async function auditRows(id: Id): Promise<AuditLog[]> {
  const { docs } = await payload.find({
    collection: 'audit-logs',
    where: {
      and: [{ entityType: { equals: 'monitor' } }, { entityId: { equals: String(id) } }],
    },
    sort: '-createdAt',
    depth: 0,
    limit: 50,
  })
  return docs as AuditLog[]
}

const resultOf = (response: BulkResponse, id: Id) =>
  response.results.find((result) => result.id === String(id))

let orgA: Organization
let orgB: Organization
let member: Session
let viewer: Session

describe('bulk monitor actions', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    orgA = await payload.create({
      collection: 'organizations',
      data: { name: 'Bulk A', slug: `bulk-a-${run}` },
    })
    orgB = await payload.create({
      collection: 'organizations',
      data: { name: 'Bulk B', slug: `bulk-b-${run}` },
    })
    member = await createMember('member', orgA, 'member')
    viewer = await createMember('viewer', orgA, 'viewer')
  })

  afterAll(async () => {
    setOnDemandTransport(undefined)
    const orgIds = [orgA?.id, orgB?.id].filter(Boolean)
    if (orgIds.length) {
      await payload.delete({ collection: 'monitors', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'tags', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'notifications', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'api-keys', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
    }
    await payload.delete({
      collection: 'users',
      where: { email: { like: `+bulk-${run}@marmot.test` } },
    })
  })

  it('validates the body', () => {
    expect(monitorBulkBody.safeParse({ ids: [1], action: 'pause' }).success).toBe(true)
    expect(monitorBulkBody.safeParse({ ids: [], action: 'pause' }).success).toBe(false)
    expect(monitorBulkBody.safeParse({ ids: [1], action: 'explode' }).success).toBe(false)
    expect(monitorBulkBody.safeParse({ ids: [1], action: 'addTags' }).success).toBe(false)
    expect(
      monitorBulkBody.safeParse({ ids: [1], action: 'addTags', payload: { tags: [{ tag: 3 }] } })
        .success,
    ).toBe(true)
    expect(
      monitorBulkBody.safeParse({
        ids: Array.from({ length: 501 }, (_, i) => i + 1),
        action: 'pause',
      }).success,
    ).toBe(false)
  })

  it('refuses anonymous users and viewers', async () => {
    const monitor = await createMonitor(orgA, 'viewer target')
    expect((await bulk(orgA, { ids: [monitor.id], action: 'pause' })).status).toBe(401)
    expect((await bulk(orgA, { ids: [monitor.id], action: 'pause' }, viewer)).status).toBe(403)
    expect((await reload(monitor.id)).active).toBe(true)
  })

  it('pauses and resumes, one audit row per changed monitor, foreign ids not found', async () => {
    const one = await createMonitor(orgA, 'pause one')
    const two = await createMonitor(orgA, 'pause two')
    const already = await createMonitor(orgA, 'already paused', { active: false })
    const foreign = await createMonitor(orgB, 'foreign')

    const paused = await bulk(
      orgA,
      { ids: [one.id, String(two.id), already.id, foreign.id, one.id], action: 'pause' },
      member,
    )
    expect(paused.status).toBe(200)
    expect(paused.body.summary).toEqual({ changed: 2, unchanged: 1, failed: 1 })
    expect(paused.body.results).toHaveLength(4)
    expect(resultOf(paused.body, one.id)).toMatchObject({ ok: true })
    expect(resultOf(paused.body, one.id)).toHaveProperty('monitor.active', false)
    expect(resultOf(paused.body, already.id)).toMatchObject({ ok: true, unchanged: true })
    expect(resultOf(paused.body, foreign.id)).toMatchObject({ ok: false, error: 'notFound' })

    expect((await reload(one.id)).active).toBe(false)
    expect((await reload(two.id)).active).toBe(false)
    expect((await reload(foreign.id)).active).toBe(true)

    for (const monitor of [one, two]) {
      const rows = (await auditRows(monitor.id)).filter((row) => row.action === 'monitor.paused')
      expect(rows).toHaveLength(1)
      expect(String(rows[0].actor)).toBe(String(member.user.id))
      expect(rows[0].metadata).toMatchObject({ bulk: { action: 'pause', count: 4 } })
    }
    expect(
      (await auditRows(already.id)).filter((row) => row.action === 'monitor.paused'),
    ).toHaveLength(0)

    const resumed = await bulk(orgA, { ids: [one.id, two.id], action: 'resume' }, member)
    expect(resumed.body.summary).toEqual({ changed: 2, unchanged: 0, failed: 0 })
    expect((await reload(one.id)).active).toBe(true)
    expect(
      (await auditRows(two.id)).filter((row) => row.action === 'monitor.resumed'),
    ).toHaveLength(1)
  })

  it('needs monitor:delete to delete, honouring permission overrides', async () => {
    const doomed = await createMonitor(orgA, 'doomed')
    const kept = await createMonitor(orgA, 'kept')
    await payload.update({
      collection: 'organizations',
      id: orgA.id,
      data: { permissionOverrides: { 'monitor:delete': 'admin' } } as never,
    })
    try {
      const refused = await bulk(orgA, { ids: [doomed.id], action: 'delete' }, member)
      expect(refused.status).toBe(403)
      // Pausing still only needs monitor:update.
      expect((await bulk(orgA, { ids: [kept.id], action: 'pause' }, member)).status).toBe(200)
    } finally {
      await payload.update({
        collection: 'organizations',
        id: orgA.id,
        data: { permissionOverrides: {} } as never,
      })
    }

    const deleted = await bulk(orgA, { ids: [doomed.id], action: 'delete' }, member)
    expect(deleted.body.summary).toEqual({ changed: 1, unchanged: 0, failed: 0 })
    const { totalDocs } = await payload.count({
      collection: 'monitors',
      where: { id: { equals: doomed.id } },
    })
    expect(totalDocs).toBe(0)
    const rows = (await auditRows(doomed.id)).filter((row) => row.action === 'monitor.deleted')
    expect(rows).toHaveLength(1)
    expect(rows[0].metadata).toMatchObject({ bulk: { action: 'delete' } })
  })

  it('adds and removes tags, refusing tags of another organization', async () => {
    const prod = await payload.create({
      collection: 'tags',
      data: { name: `prod-${run}`, color: '#DC2626', organization: orgA.id },
    })
    const other = await payload.create({
      collection: 'tags',
      data: { name: `other-${run}`, color: '#2563EB', organization: orgB.id },
    })
    const tagged = await createMonitor(orgA, 'tagged', { tags: [{ tag: prod.id, value: 'eu' }] })
    const plain = await createMonitor(orgA, 'plain')

    const foreign = await bulk(
      orgA,
      { ids: [plain.id], action: 'addTags', payload: { tags: [{ tag: other.id }] } },
      member,
    )
    expect(foreign.status).toBe(400)
    expect((await reload(plain.id)).tags ?? []).toHaveLength(0)

    const added = await bulk(
      orgA,
      { ids: [tagged.id, plain.id], action: 'addTags', payload: { tags: [{ tag: prod.id }] } },
      member,
    )
    expect(added.body.summary).toEqual({ changed: 1, unchanged: 1, failed: 0 })
    expect(resultOf(added.body, plain.id)).toHaveProperty('monitor.tags', [
      { id: String(prod.id), name: prod.name, color: '#DC2626', value: null },
    ])
    // The existing row keeps its value.
    expect((await reload(tagged.id)).tags?.map((row) => row.value)).toEqual(['eu'])

    const removed = await bulk(
      orgA,
      { ids: [tagged.id, plain.id], action: 'removeTags', payload: { tags: [{ tag: prod.id }] } },
      member,
    )
    expect(removed.body.summary).toEqual({ changed: 2, unchanged: 0, failed: 0 })
    expect((await reload(tagged.id)).tags ?? []).toHaveLength(0)
    const rows = (await auditRows(plain.id)).filter((row) => row.action === 'monitor.updated')
    expect(rows.map((row) => row.changedFields)).toEqual(
      expect.arrayContaining([expect.arrayContaining(['tags'])]),
    )
  })

  it('attaches and detaches notification channels', async () => {
    const channel = await payload.create({
      collection: 'notifications',
      data: {
        name: `hook-${run}`,
        type: 'webhook',
        config: { url: 'https://example.com/hook' },
        organization: orgA.id,
      } as never,
    })
    const monitor = await createMonitor(orgA, 'channel target', { notifications: [] })

    const attached = await bulk(
      orgA,
      { ids: [monitor.id], action: 'addNotifications', payload: { notifications: [channel.id] } },
      member,
    )
    expect(attached.body.summary.changed).toBe(1)
    expect(resultOf(attached.body, monitor.id)).toHaveProperty('monitor.notifications', [
      String(channel.id),
    ])
    expect((await reload(monitor.id)).notifications?.map(String)).toEqual([String(channel.id)])

    const again = await bulk(
      orgA,
      { ids: [monitor.id], action: 'addNotifications', payload: { notifications: [channel.id] } },
      member,
    )
    expect(again.body.summary.unchanged).toBe(1)

    await bulk(
      orgA,
      {
        ids: [monitor.id],
        action: 'removeNotifications',
        payload: { notifications: [channel.id] },
      },
      member,
    )
    expect((await reload(monitor.id)).notifications ?? []).toHaveLength(0)
  })

  describe('check', () => {
    const add = vi.fn(async () => ({ id: 'job' }))

    beforeAll(() => {
      setOnDemandTransport({ queue: { add }, events: {} } as unknown as OnDemandTransport)
    })

    it('queues a recorded check per applicable monitor', async () => {
      const active = await createMonitor(orgA, 'check me')
      const paused = await createMonitor(orgA, 'paused check', { active: false })
      const push = await createMonitor(orgA, 'push check', {
        ...defaultMonitorValues('push'),
        name: 'push check',
        type: 'push',
        url: null,
      } as never)
      add.mockClear()

      const res = await bulk(
        orgA,
        { ids: [active.id, paused.id, push.id], action: 'check' },
        member,
      )
      expect(res.status).toBe(200)
      expect(resultOf(res.body, active.id)).toMatchObject({ ok: true })
      expect(resultOf(res.body, paused.id)).toMatchObject({ ok: false, error: 'notApplicable' })
      expect(resultOf(res.body, push.id)).toMatchObject({ ok: false, error: 'notApplicable' })
      expect(add).toHaveBeenCalledTimes(1)
      expect(add.mock.calls[0]).toEqual(
        expect.arrayContaining([
          'manual-check',
          expect.objectContaining({ monitorId: String(active.id), record: true }),
        ]),
      )
    })

    it('spends the organization on-demand budget per monitor', async () => {
      const first = await createMonitor(orgA, 'budget one')
      const second = await createMonitor(orgA, 'budget two')
      let left = 1
      const onDemand: RateLimiter = {
        name: 'test',
        points: 1,
        duration: 60,
        consume: async () => {
          const allowed = left-- > 0
          return {
            allowed,
            limit: 1,
            remaining: Math.max(0, left),
            retryAfterSeconds: allowed ? 0 : 60,
            degraded: false,
          }
        },
      }
      const user = {
        ...(await payload.findByID({ collection: 'users', id: member.user.id, depth: 0 })),
        collection: 'users' as const,
      } as RequestUser
      const result = await runMonitorBulkAction(
        {
          payload,
          request: sessionRequest(orgA, {}, member),
          user,
          orgId: orgA.id,
          limiters: { onDemand },
        },
        { ids: [first.id, second.id], action: 'check' },
      )
      expect(result).not.toBeInstanceOf(Response)
      const response = result as BulkResponse
      expect(resultOf(response, first.id)).toMatchObject({ ok: true })
      expect(resultOf(response, second.id)).toMatchObject({ ok: false, error: 'rateLimited' })
    })
  })

  describe('API keys', () => {
    let writeKey: string

    beforeAll(async () => {
      const generated = generateApiKey()
      await payload.create({
        collection: 'api-keys',
        overrideAccess: true,
        data: {
          organization: orgA.id,
          name: 'bulk',
          scope: 'write',
          keyHash: generated.keyHash,
          prefix: generated.prefix,
        },
      })
      writeKey = generated.key
    })

    const keyRequest = (org: Organization, body: unknown) =>
      bulkRoute(
        new Request(orgUrl(org), {
          method: 'POST',
          headers: { authorization: `Bearer ${writeKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ orgId: String(org.id) }) },
      )

    it('acts as the key, audited with the key as actor', async () => {
      const monitor = await createMonitor(orgA, 'key target')
      const res = await keyRequest(orgA, { ids: [monitor.id], action: 'pause' })
      expect(res.status).toBe(200)
      const rows = (await auditRows(monitor.id)).filter((row) => row.action === 'monitor.paused')
      expect(rows).toHaveLength(1)
      expect(rows[0].actorType).toBe('apiKey')
    })

    it('refuses more monitors than the key may write per minute', async () => {
      const ids = Array.from({ length: env.API_KEY_WRITE_RATE_LIMIT + 1 }, (_, i) => i + 1)
      const res = await keyRequest(orgA, { ids, action: 'pause' })
      expect(res.status).toBe(400)
    })

    it('spends one write per monitor of the key budget', async () => {
      const consume = vi.fn(async () => ({
        allowed: false,
        limit: 2,
        remaining: 0,
        retryAfterSeconds: 30,
        degraded: false,
      }))
      const apiKeyWrite: RateLimiter = { name: 'w', points: 10, duration: 60, consume }
      const principal = {
        id: 'api-key:1',
        collection: 'users',
        organizations: [{ organization: orgA.id, role: 'member' }],
        apiKey: { id: '1', prefix: 'x', name: 'k', scope: 'write', organization: orgA.id },
      } as unknown as RequestUser
      const result = await runMonitorBulkAction(
        {
          payload,
          request: sessionRequest(orgA, {}),
          user: principal,
          orgId: orgA.id,
          limiters: { apiKeyWrite },
        },
        { ids: [1, 2, 3], action: 'pause' },
      )
      expect(consume).toHaveBeenCalledWith('1', 2)
      expect(result).toBeInstanceOf(Response)
      expect((result as Response).status).toBe(429)
    })
  })
})
