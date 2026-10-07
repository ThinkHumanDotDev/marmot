import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import { can, type Role } from '@/access/permissions'
import { GET as listKeys } from '@/app/api/orgs/[orgId]/api-keys/route'
import { POST as adhocCheck } from '@/app/api/orgs/[orgId]/checks/route'
import { PATCH as changeRole } from '@/app/api/orgs/[orgId]/members/[userId]/route'
import { POST as checkMonitor } from '@/app/api/orgs/[orgId]/monitors/[id]/check/route'
import { GET as getMonitor } from '@/app/api/orgs/[orgId]/monitors/[id]/route'
import { GET as listMonitors, POST as createMonitor } from '@/app/api/orgs/[orgId]/monitors/route'
import { GET as listStatusPages } from '@/app/api/orgs/[orgId]/status-pages/route'
import { GET as openApiRoute } from '@/app/api/openapi.json/route'
import { GET as listWebhooks, POST as createWebhook } from '@/app/api/orgs/[orgId]/webhooks/route'
import { env, resetEnvCache } from '@/env'
import { defaultMonitorValues } from '@/lib/validation/monitor'
import type { AuditLog, Monitor, Organization, User } from '@/payload-types'
import { generateApiKey } from '@/server/api-keys'
import { buildManagementOpenApi, OPERATIONS, requiredScope } from '@/server/api/openapi'
import { apiKeyPrincipal, consumeApiKeyBudget, orgRouteOf } from '@/server/auth/request-auth'
import { resolveCheckActor } from '@/server/monitors/checks'
import type { RateLimiter } from '@/server/security/rate-limit'
import { isLocalLoginDisabled } from '@/server/sso/local-login'

let payload: Payload

const run = Date.now().toString(36)
const email = (name: string) => `${name}+mgmt-${run}@marmot.test`

let orgA: Organization
let orgB: Organization
let owner: User
let readKey: string
let writeKey: string
let foreignKey: string

async function mintKey(org: Organization, scope: 'read' | 'write', name = scope) {
  const generated = generateApiKey()
  await payload.create({
    collection: 'api-keys',
    overrideAccess: true,
    data: {
      organization: org.id,
      name,
      scope,
      keyHash: generated.keyHash,
      prefix: generated.prefix,
    },
  })
  return generated.key
}

function keyRequest(
  url: string,
  key: string | null,
  init: { method?: string; body?: unknown } = {},
) {
  return new Request(url, {
    method: init.method ?? 'GET',
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
}

const orgUrl = (org: Organization, rest: string) => `http://localhost/api/orgs/${org.id}/${rest}`
async function keyDoc(key: string) {
  const { docs } = await payload.find({
    collection: 'api-keys',
    where: { prefix: { equals: key.split('_')[1] } },
    depth: 0,
    limit: 1,
  })
  return docs[0]
}

const params = (orgId: string | number, extra: Record<string, string> = {}) =>
  Promise.resolve({ orgId: String(orgId), id: '', userId: '', ...extra })

const httpMonitor = (name: string) => ({
  ...defaultMonitorValues('http'),
  name,
  url: 'http://localhost:3000/api/health',
  active: false,
})

describe('management API with API keys', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    orgA = await payload.create({
      collection: 'organizations',
      data: { name: 'Mgmt A', slug: `mgmt-a-${run}` },
    })
    orgB = await payload.create({
      collection: 'organizations',
      data: { name: 'Mgmt B', slug: `mgmt-b-${run}` },
    })
    owner = await payload.create({
      collection: 'users',
      data: { email: email('owner'), password: 'password-123', name: 'Owner' },
    })
    await addOrgMembership({ payload, userId: owner.id, orgId: orgA.id, role: 'owner' as Role })
    readKey = await mintKey(orgA, 'read')
    writeKey = await mintKey(orgA, 'write')
    foreignKey = await mintKey(orgB, 'write')
  })

  afterAll(async () => {
    const orgIds = [orgA?.id, orgB?.id].filter(Boolean)
    if (orgIds.length) {
      await payload.delete({ collection: 'monitors', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'api-keys', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'audit-logs', where: { organization: { in: orgIds } } })
      await payload.delete({ collection: 'organizations', where: { id: { in: orgIds } } })
    }
    await payload.delete({
      collection: 'users',
      where: { email: { like: `+mgmt-${run}@marmot.test` } },
    })
  })

  it('read keys list and fetch monitors of their organization', async () => {
    const monitor = (await payload.create({
      collection: 'monitors',
      overrideAccess: true,
      depth: 0,
      data: { ...httpMonitor('seeded'), organization: orgA.id } as never,
    })) as Monitor

    const list = await listMonitors(keyRequest(orgUrl(orgA, 'monitors'), readKey), {
      params: params(orgA.id),
    })
    expect(list.status).toBe(200)
    const body = (await list.json()) as { docs: Monitor[]; totalDocs: number }
    expect(body.docs.map((d) => d.id)).toContain(monitor.id)

    const one = await getMonitor(keyRequest(orgUrl(orgA, `monitors/${monitor.id}`), readKey), {
      params: params(orgA.id, { id: String(monitor.id) }),
    })
    expect(one.status).toBe(200)
    expect(((await one.json()) as Monitor).name).toBe('seeded')

    const pages = await listStatusPages(keyRequest(orgUrl(orgA, 'status-pages'), readKey), {
      params: params(orgA.id),
    })
    expect(pages.status).toBe(200)
  })

  it('read keys may not write', async () => {
    const res = await createMonitor(
      keyRequest(orgUrl(orgA, 'monitors'), readKey, { method: 'POST', body: httpMonitor('x') }),
      { params: params(orgA.id) },
    )
    expect(res.status).toBe(403)
  })

  it('write keys create monitors, audited once with the key as actor', async () => {
    const res = await createMonitor(
      keyRequest(orgUrl(orgA, 'monitors'), writeKey, {
        method: 'POST',
        body: httpMonitor('from ci'),
      }),
      { params: params(orgA.id) },
    )
    expect(res.status).toBe(201)
    const created = (await res.json()) as Monitor
    expect(String(created.organization)).toBe(String(orgA.id))

    // One row per change, written by the collection hooks (#225) with the key as the actor.
    const writeKeyDoc = await keyDoc(writeKey)
    const { docs } = await payload.find({
      collection: 'audit-logs',
      where: {
        and: [
          { organization: { equals: orgA.id } },
          { entityType: { equals: 'monitor' } },
          { entityId: { equals: String(created.id) } },
        ],
      },
      depth: 0,
    })
    expect(docs.map((d) => d.action)).toEqual(['monitor.created'])
    const row = docs[0] as AuditLog
    expect(row.actorType).toBe('apiKey')
    expect(row.actorRef).toBe(String(writeKeyDoc.id))
    expect(row.actorLabel).toBe('write')
    expect(row.actor ?? null).toBeNull()
  })

  it('write keys trigger on-demand checks; read keys may not', async () => {
    const paused = (await payload.create({
      collection: 'monitors',
      overrideAccess: true,
      depth: 0,
      data: { ...httpMonitor('paused'), organization: orgA.id } as never,
    })) as Monitor
    const checkUrl = orgUrl(orgA, `monitors/${paused.id}/check`)
    const ctx = { params: params(orgA.id, { id: String(paused.id) }) }

    const asReader = await checkMonitor(keyRequest(checkUrl, readKey, { method: 'POST' }), ctx)
    expect(asReader.status).toBe(403)
    // Authenticated and authorised: the paused monitor is what stops it (no worker needed).
    const asWriter = await checkMonitor(keyRequest(checkUrl, writeKey, { method: 'POST' }), ctx)
    expect(asWriter.status).toBe(409)

    const adhoc = await adhocCheck(
      keyRequest(orgUrl(orgA, 'checks'), readKey, { method: 'POST', body: httpMonitor('t') }),
      { params: params(orgA.id) },
    )
    expect(adhoc.status).toBe(403)

    const resolved = await resolveCheckActor(
      payload,
      keyRequest(checkUrl, writeKey, { method: 'POST' }),
      orgA.id,
      ['monitor:update'],
    )
    expect(resolved.response).toBeUndefined()
    expect('actor' in resolved && resolved.actor).toMatchObject({
      kind: 'api-key',
      apiKey: { scope: 'write' },
    })
  })

  it('keeps working in SSO-only mode (keys are not password logins)', async () => {
    const before = process.env.OIDC_DISABLE_LOCAL_LOGIN
    Object.assign(process.env, { OIDC_DISABLE_LOCAL_LOGIN: 'true' })
    resetEnvCache()
    try {
      expect(isLocalLoginDisabled()).toBe(true)
      const list = await listMonitors(keyRequest(orgUrl(orgA, 'monitors'), readKey), {
        params: params(orgA.id),
      })
      expect(list.status).toBe(200)
      const created = await createMonitor(
        keyRequest(orgUrl(orgA, 'monitors'), writeKey, {
          method: 'POST',
          body: httpMonitor('sso only'),
        }),
        { params: params(orgA.id) },
      )
      expect(created.status).toBe(201)
    } finally {
      if (before === undefined) delete process.env.OIDC_DISABLE_LOCAL_LOGIN
      else process.env.OIDC_DISABLE_LOCAL_LOGIN = before
      resetEnvCache()
    }
  })

  it('webhooks follow the permissions: admin-only by default, keys where the org lowered them', async () => {
    const url = orgUrl(orgA, 'webhooks')
    const byDefault = await listWebhooks(keyRequest(url, writeKey), { params: params(orgA.id) })
    expect(byDefault.status).toBe(403)

    await payload.update({
      collection: 'organizations',
      id: orgA.id,
      overrideAccess: true,
      data: { permissionOverrides: { 'webhook:read': 'viewer' } },
    })
    try {
      const lowered = await listWebhooks(keyRequest(url, readKey), { params: params(orgA.id) })
      expect(lowered.status).toBe(200)
      expect(JSON.stringify(await lowered.json())).not.toMatch(/"secret"/)
      // `webhook:manage` is still admin: a write key (member) may not create endpoints.
      const create = await createWebhook(
        keyRequest(url, writeKey, {
          method: 'POST',
          body: { url: 'https://hooks.example.com/marmot', events: ['monitor.down'] },
        }),
        { params: params(orgA.id) },
      )
      expect(create.status).toBe(403)
    } finally {
      await payload.update({
        collection: 'organizations',
        id: orgA.id,
        overrideAccess: true,
        data: { permissionOverrides: {} },
      })
    }
  })

  it('refuses keys of another organization, unknown keys and anonymous requests', async () => {
    const foreign = await listMonitors(keyRequest(orgUrl(orgA, 'monitors'), foreignKey), {
      params: params(orgA.id),
    })
    expect(foreign.status).toBe(403)

    const unknown = await listMonitors(keyRequest(orgUrl(orgA, 'monitors'), generateApiKey().key), {
      params: params(orgA.id),
    })
    expect(unknown.status).toBe(401)
    expect(unknown.headers.get('www-authenticate')).toMatch(/^Bearer/)

    const anonymous = await listMonitors(keyRequest(orgUrl(orgA, 'monitors'), null), {
      params: params(orgA.id),
    })
    expect(anonymous.status).toBe(401)
  })

  it('never lets keys manage keys or members, even write keys', async () => {
    const keys = await listKeys(keyRequest(orgUrl(orgA, 'api-keys'), writeKey), {
      params: params(orgA.id),
    })
    expect(keys.status).toBe(403)

    const role = await changeRole(
      keyRequest(orgUrl(orgA, `members/${owner.id}`), writeKey, {
        method: 'PATCH',
        body: { role: 'viewer' },
      }),
      { params: params(orgA.id, { userId: String(owner.id) }) },
    )
    expect(role.status).toBe(403)

    // Collection access agrees, whatever the role the key maps to.
    const principal = apiKeyPrincipal({
      organizationId: orgA.id,
      scope: 'write',
      apiKey: { id: 1, prefix: 'abcd1234', name: 'k', createdAt: '', updatedAt: '' } as never,
    })
    expect(can(principal, orgA.id, 'monitor:create')).toBe(true)
    expect(can(principal, orgA.id, 'member:invite')).toBe(false)
    expect(can(principal, orgA.id, 'api-key:create')).toBe(false)
  })

  it('rate limits per key, writes separately', async () => {
    let allLeft = 3
    let writeLeft = 1
    const limiter = (name: string, left: () => number, spend: () => void): RateLimiter => ({
      name,
      points: 3,
      duration: 60,
      consume: async () => {
        const allowed = left() > 0
        if (allowed) spend()
        return {
          allowed,
          limit: 3,
          remaining: left(),
          retryAfterSeconds: allowed ? 0 : 42,
          degraded: false,
        }
      },
    })
    const limiters = {
      all: limiter(
        'all',
        () => allLeft,
        () => allLeft--,
      ),
      write: limiter(
        'write',
        () => writeLeft,
        () => writeLeft--,
      ),
    }
    const req = keyRequest(orgUrl(orgA, 'monitors'), writeKey, { method: 'POST' })
    expect(await consumeApiKeyBudget(req, 'k', true, limiters)).toBeNull()
    const writeLimited = await consumeApiKeyBudget(req, 'k', true, limiters)
    expect(writeLimited?.status).toBe(429)
    expect(writeLimited?.headers.get('retry-after')).toBe('42')
    expect(await consumeApiKeyBudget(req, 'k', false, limiters)).toBeNull()
    expect((await consumeApiKeyBudget(req, 'k', false, limiters))?.status).toBe(429)
  })

  it('only treats /api/orgs/:orgId/… as organization routes', () => {
    expect(orgRouteOf(new Request('http://x/api/orgs/7/monitors/3'))).toEqual({
      orgId: '7',
      section: 'monitors',
    })
    expect(orgRouteOf(new Request('http://x/api/orgs/slug-available?slug=a'))).toBeNull()
    expect(orgRouteOf(new Request('http://x/api/monitors'))).toBeNull()
  })
})

describe('management API OpenAPI document', () => {
  const ROOT = path.resolve(__dirname, '../../src/app/api/orgs')

  function routeFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) return routeFiles(full)
      return entry === 'route.ts' ? [full] : []
    })
  }

  it('describes every exported handler under /api/orgs, and nothing else', () => {
    const handlers = new Set<string>()
    for (const file of routeFiles(ROOT)) {
      const rel = path.relative(ROOT, path.dirname(file)).split(path.sep).join('/')
      const template = `/api/orgs/${rel}`.replace(/\[([^\]]+)\]/g, '{$1}')
      const source = readFileSync(file, 'utf8')
      for (const m of source.matchAll(
        /^export (?:async )?(?:function|const) (GET|POST|PUT|PATCH|DELETE)\b/gm,
      )) {
        handlers.add(`${m[1]} ${template}`)
      }
    }
    const documented = new Set(OPERATIONS.map((op) => `${op.method} ${op.path}`))
    expect([...handlers].filter((h) => !documented.has(h)).sort()).toEqual([])
    expect([...documented].filter((h) => !handlers.has(h)).sort()).toEqual([])
    expect(new Set(OPERATIONS.map((op) => op.operationId)).size).toBe(OPERATIONS.length)
  })

  it('marks key scopes the way authentication enforces them', () => {
    const find = (method: string, p: string) =>
      OPERATIONS.find((op) => op.method === method && op.path === p)!
    expect(requiredScope(find('GET', '/api/orgs/{orgId}/monitors'))).toBe('read')
    expect(requiredScope(find('POST', '/api/orgs/{orgId}/monitors'))).toBe('write')
    expect(requiredScope(find('GET', '/api/orgs/{orgId}/api-keys'))).toBeNull()
    expect(requiredScope(find('PATCH', '/api/orgs/{orgId}/members/{userId}'))).toBeNull()
  })

  it('is valid OpenAPI 3.1 with JSON Schema request bodies', async () => {
    const doc = buildManagementOpenApi(env.NEXT_PUBLIC_SERVER_URL) as {
      openapi: string
      paths: Record<
        string,
        Record<string, { requestBody?: { content: Record<string, { schema: { type?: string } }> } }>
      >
    }
    expect(doc.openapi).toBe('3.1.0')
    const create = doc.paths['/api/orgs/{orgId}/monitors'].post
    const schema = create.requestBody?.content['application/json'].schema as {
      type: string
      properties: Record<string, unknown>
    }
    expect(schema.type).toBe('object')
    expect(schema.properties).toHaveProperty('url')

    const res = openApiRoute()
    expect(res.status).toBe(200)
    expect(((await res.json()) as { info: { title: string } }).info.title).toMatch(/Marmot/)
  })
})
