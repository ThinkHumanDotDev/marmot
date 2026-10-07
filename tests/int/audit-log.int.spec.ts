import { createLocalReq, getPayload, type CollectionSlug, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import type { Role } from '@/access/permissions'
import { GET as exportAuditLogs } from '@/app/api/orgs/[orgId]/audit-logs/export/route'
import { GET as listAuditLogs } from '@/app/api/orgs/[orgId]/audit-logs/route'
import { POST as cloneMonitor } from '@/app/api/orgs/[orgId]/monitors/[id]/clone/route'
import { POST as pauseMonitor } from '@/app/api/orgs/[orgId]/monitors/[id]/pause/route'
import { POST as resumeMonitor } from '@/app/api/orgs/[orgId]/monitors/[id]/resume/route'
import { AUDITED, NOT_AUDITED } from '@/collections/audit'
import { env } from '@/env'
import { defaultMonitorValues } from '@/lib/validation/monitor'
import type { AuditLog, Monitor, Organization, User } from '@/payload-types'
import { onAuditEvent, type AuditEventRecord } from '@/server/audit/bus'
import { apiKeyActor, AUDIT_ACTOR_CONTEXT } from '@/server/audit/context'
import { REDACTED } from '@/server/audit/diff'

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+audit-${run}@marmot.test`
const PASSWORD = 'password-123'
const SLACK_HOOK = `https://hooks.slack.com/services/T000/B000/secret-${run}`

type Session = { user: User; cookie: string }

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

/** Browser-like request: Payload only honours the cookie when `Origin` passes its CSRF allowlist. */
function request(session: Session, method = 'GET', url = 'http://localhost/api/test'): Request {
  return new Request(url, {
    method,
    headers: {
      Origin: env.NEXT_PUBLIC_SERVER_URL,
      cookie: session.cookie,
      'User-Agent': `vitest-audit/${run}`,
    },
  })
}

const asRequestUser = async (user: User) => ({
  ...(await payload.findByID({ collection: 'users', id: user.id, depth: 0 })),
  collection: 'users' as const,
})

async function rowsFor(entityType: string, entityId: string | number): Promise<AuditLog[]> {
  const { docs } = await payload.find({
    collection: 'audit-logs',
    where: {
      and: [{ entityType: { equals: entityType } }, { entityId: { equals: String(entityId) } }],
    },
    sort: '-createdAt',
    depth: 0,
    limit: 100,
  })
  return docs as AuditLog[]
}

let org: Organization
let owner: Session
let admin: Session
let member: Session
let viewer: Session
let monitor: Monitor

describe('audit log', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    org = await payload.create({
      collection: 'organizations',
      data: { name: 'Audit org', slug: `audit-${run}` },
    })
    owner = await createMember('owner', org, 'owner')
    admin = await createMember('admin', org, 'admin')
    member = await createMember('member', org, 'member')
    viewer = await createMember('viewer', org, 'viewer')
    monitor = (await payload.create({
      collection: 'monitors',
      data: {
        ...defaultMonitorValues('http'),
        name: 'Audited API',
        url: 'http://localhost:3000/api/health',
        organization: org.id,
      } as never,
      user: await asRequestUser(admin.user),
      overrideAccess: false,
      depth: 0,
    })) as Monitor
  })

  afterAll(async () => {
    if (org) {
      await payload.delete({ collection: 'monitors', where: { organization: { equals: org.id } } })
      await payload.delete({
        collection: 'notifications',
        where: { organization: { equals: org.id } },
      })
      await payload.delete({ collection: 'organizations', where: { id: { equals: org.id } } })
    }
    await payload.delete({
      collection: 'users',
      where: { email: { like: `+audit-${run}@marmot.test` } },
    })
  })

  it('decides audit coverage for every collection', () => {
    const slugs = payload.config.collections
      .map((collection) => collection.slug as CollectionSlug)
      .filter((slug) => !slug.startsWith('payload-'))
    for (const slug of slugs) {
      const audited = slug in AUDITED
      const excluded = slug in NOT_AUDITED
      expect(audited !== excluded, `${slug}: add it to AUDITED or NOT_AUDITED`).toBe(true)
    }
  })

  it('records monitor creation with a snapshot and the acting member', async () => {
    const [created] = await rowsFor('monitor', monitor.id)
    expect(created).toMatchObject({
      action: 'monitor.created',
      actorType: 'user',
      actorRef: String(admin.user.id),
      actorLabel: admin.user.email,
      organization: org.id,
      entityLabel: 'Audited API',
      after: expect.objectContaining({ name: 'Audited API', active: true }),
    })
  })

  it('records pause and resume through the API with actor, diff and client details', async () => {
    const paused = await pauseMonitor(request(admin, 'POST'), {
      params: Promise.resolve({ orgId: String(org.id), id: String(monitor.id) }),
    })
    expect(paused.status).toBe(200)

    const [row] = await rowsFor('monitor', monitor.id)
    expect(row).toMatchObject({
      action: 'monitor.paused',
      actorType: 'user',
      actorRef: String(admin.user.id),
      actorLabel: admin.user.email,
      changedFields: ['active'],
      before: { active: true },
      after: { active: false },
      userAgent: `vitest-audit/${run}`,
    })

    const resumed = await resumeMonitor(request(admin, 'POST'), {
      params: Promise.resolve({ orgId: String(org.id), id: String(monitor.id) }),
    })
    expect(resumed.status).toBe(200)
    expect((await rowsFor('monitor', monitor.id))[0]).toMatchObject({
      action: 'monitor.resumed',
      after: { active: true },
    })
  })

  it('records clones with their source', async () => {
    const res = await cloneMonitor(request(admin, 'POST'), {
      params: Promise.resolve({ orgId: String(org.id), id: String(monitor.id) }),
    })
    expect(res.status).toBe(201)
    const copy = (await res.json()) as Monitor
    const [row] = await rowsFor('monitor', copy.id)
    expect(row).toMatchObject({
      action: 'monitor.cloned',
      metadata: { sourceId: String(monitor.id), sourceName: 'Audited API' },
    })
  })

  it('names an API key or other non-user actor', async () => {
    await payload.update({
      collection: 'monitors',
      id: monitor.id,
      data: { active: false },
      context: {
        [AUDIT_ACTOR_CONTEXT]: apiKeyActor({ id: 99, name: 'CI key', prefix: 'abcd1234' }),
      },
      depth: 0,
    })
    expect((await rowsFor('monitor', monitor.id))[0]).toMatchObject({
      action: 'monitor.paused',
      actorType: 'apiKey',
      actorRef: '99',
      actorLabel: 'CI key',
      actor: null,
    })
  })

  it('ignores status-cache writes of the worker', async () => {
    const before = (await rowsFor('monitor', monitor.id)).length
    await payload.update({
      collection: 'monitors',
      id: monitor.id,
      data: { status: { lastStatus: 'up', lastPing: 42 } },
      context: { skipEngineSync: true },
      depth: 0,
    })
    expect((await rowsFor('monitor', monitor.id)).length).toBe(before)
  })

  it('never stores secret values, but records that a secret changed', async () => {
    const channel = await payload.create({
      collection: 'notifications',
      data: {
        organization: org.id,
        name: 'Ops Slack',
        type: 'slack',
        config: { webhookUrl: SLACK_HOOK },
      } as never,
      user: await asRequestUser(owner.user),
      overrideAccess: false,
      depth: 0,
    })
    await payload.update({
      collection: 'notifications',
      id: channel.id,
      data: { config: { webhookUrl: `${SLACK_HOOK}-rotated` } } as never,
      user: await asRequestUser(owner.user),
      overrideAccess: false,
      depth: 0,
    })

    const rows = await rowsFor('notification', channel.id)
    expect(rows.map((row) => row.action)).toEqual(['notification.updated', 'notification.created'])
    expect(JSON.stringify(rows)).not.toContain('secret-')
    expect(rows[0]).toMatchObject({
      changedFields: ['config.webhookUrl'],
      before: { 'config.webhookUrl': REDACTED },
      after: { 'config.webhookUrl': REDACTED },
    })
  })

  it('writes rows with the transaction and publishes them only after the commit', async () => {
    const seen: AuditEventRecord[] = []
    const unsubscribe = onAuditEvent((event) => {
      if (event.entityId === String(monitor.id)) seen.push(event)
    })
    try {
      const before = (await rowsFor('monitor', monitor.id)).length
      const req = await createLocalReq({ user: await asRequestUser(owner.user) }, payload)
      const transactionID = await payload.db.beginTransaction()
      if (transactionID) req.transactionID = transactionID
      await payload.update({
        collection: 'monitors',
        id: monitor.id,
        data: { name: 'Never saved' },
        req,
        depth: 0,
      })
      expect(seen).toEqual([])
      if (!transactionID) return // MongoDB without a replica set: no transactions to roll back.
      await payload.db.rollbackTransaction(transactionID)
      expect((await rowsFor('monitor', monitor.id)).length).toBe(before)
      expect(seen).toEqual([])

      await payload.update({
        collection: 'monitors',
        id: monitor.id,
        data: { name: 'Renamed API' },
        user: await asRequestUser(owner.user),
        depth: 0,
      })
      expect(seen.map((event) => event.action)).toEqual(['monitor.updated'])
      expect(seen[0]).toMatchObject({ changedFields: ['name'], after: { name: 'Renamed API' } })
    } finally {
      unsubscribe()
    }
  })

  it('records instance settings changes as instance-level rows', async () => {
    const current = await payload.findGlobal({ slug: 'instance-settings', depth: 0 })
    const days = current.tlsExpiryNotifyDays ?? [7, 14, 21]
    try {
      await payload.updateGlobal({
        slug: 'instance-settings',
        data: { tlsExpiryNotifyDays: [2, 9] },
        depth: 0,
      })
      const { docs } = await payload.find({
        collection: 'audit-logs',
        where: { action: { equals: 'instance_settings.updated' } },
        sort: '-createdAt',
        limit: 1,
        depth: 0,
      })
      expect(docs[0]).toMatchObject({
        organization: null,
        actorType: 'system',
        changedFields: ['tlsExpiryNotifyDays'],
        after: { tlsExpiryNotifyDays: [2, 9] },
      })
    } finally {
      await payload.updateGlobal({
        slug: 'instance-settings',
        data: { tlsExpiryNotifyDays: days },
        depth: 0,
      })
    }
  })

  describe('API', () => {
    const list = (session: Session, query = '') =>
      listAuditLogs(
        request(session, 'GET', `http://localhost/api/orgs/${String(org.id)}/audit-logs${query}`),
        { params: Promise.resolve({ orgId: String(org.id) }) },
      )

    it('serves owners and admins but not members or viewers by default', async () => {
      expect((await list(owner)).status).toBe(200)
      expect((await list(admin)).status).toBe(200)
      expect((await list(member)).status).toBe(403)
      expect((await list(viewer)).status).toBe(403)
    })

    it('honours a permission override for members', async () => {
      await payload.update({
        collection: 'organizations',
        id: org.id,
        data: { permissionOverrides: { 'audit-log:read': 'member' } },
        depth: 0,
      })
      try {
        const res = await list(member)
        expect(res.status).toBe(200)
        const body = (await res.json()) as { totalDocs: number }
        expect(body.totalDocs).toBeGreaterThan(0)
        expect((await list(viewer)).status).toBe(403)
      } finally {
        await payload.update({
          collection: 'organizations',
          id: org.id,
          data: { permissionOverrides: {} },
          depth: 0,
        })
      }
    })

    it('filters by action prefix, actor and resource', async () => {
      const res = await list(
        admin,
        `?action=monitor.&entityType=monitor&entityId=${String(monitor.id)}&actorType=user` +
          `&actorId=${String(admin.user.id)}`,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { docs: AuditEventRecord[] }
      const actions = body.docs.map((doc) => doc.action)
      expect(actions).toEqual(['monitor.resumed', 'monitor.paused', 'monitor.created'])
      expect(body.docs.every((doc) => doc.actorId === String(admin.user.id))).toBe(true)

      expect((await list(admin, '?actorType=robot')).status).toBe(400)
      expect((await list(admin, '?scope=instance')).status).toBe(403)
    })

    it('exports CSV without secrets', async () => {
      const res = await exportAuditLogs(
        request(owner, 'GET', `http://localhost/api/orgs/${String(org.id)}/audit-logs/export`),
        { params: Promise.resolve({ orgId: String(org.id) }) },
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/csv')
      const csv = await res.text()
      expect(csv.split('\r\n')[0]).toMatch(/^createdAt,action,actorType,actorId,actorLabel/)
      expect(csv).toContain('monitor.paused')
      expect(csv).toContain('notification.updated')
      expect(csv).not.toContain('secret-')
    })
  })
})
