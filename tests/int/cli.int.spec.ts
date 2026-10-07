/**
 * The `marmot` CLI (#116) end to end: commands run in-process (`run(argv, io)`) and their HTTP
 * requests are dispatched straight to the route handlers, authenticated with real API keys.
 */
import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@payload-config'
import * as checkRoute from '@/app/api/orgs/[orgId]/monitors/[id]/check/route'
import * as cloneRoute from '@/app/api/orgs/[orgId]/monitors/[id]/clone/route'
import * as importRoute from '@/app/api/orgs/[orgId]/import/route'
import * as heartbeatsRoute from '@/app/api/orgs/[orgId]/monitors/[id]/heartbeats/route'
import * as pauseRoute from '@/app/api/orgs/[orgId]/monitors/[id]/pause/route'
import * as monitorRoute from '@/app/api/orgs/[orgId]/monitors/[id]/route'
import * as monitorsRoute from '@/app/api/orgs/[orgId]/monitors/route'
import * as notificationsRoute from '@/app/api/orgs/[orgId]/notifications/route'
import * as statusPagesRoute from '@/app/api/orgs/[orgId]/status-pages/route'
import * as tagsRoute from '@/app/api/orgs/[orgId]/tags/route'
import { run } from '@/cli/run'
import type { CliIo } from '@/cli/context'
import { defaultMonitorValues } from '@/lib/validation/monitor'
import type { Monitor, Organization } from '@/payload-types'
import { generateApiKey } from '@/server/api-keys'

type Handler = (
  request: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>
type RouteModule = Partial<Record<'GET' | 'POST' | 'PATCH' | 'DELETE', Handler>>

const ROUTES: [RegExp, string[], RouteModule][] = [
  [/^\/api\/orgs\/([^/]+)\/monitors$/, ['orgId'], monitorsRoute as unknown as RouteModule],
  [
    /^\/api\/orgs\/([^/]+)\/monitors\/([^/]+)$/,
    ['orgId', 'id'],
    monitorRoute as unknown as RouteModule,
  ],
  [
    /^\/api\/orgs\/([^/]+)\/monitors\/([^/]+)\/heartbeats$/,
    ['orgId', 'id'],
    heartbeatsRoute as unknown as RouteModule,
  ],
  [
    /^\/api\/orgs\/([^/]+)\/monitors\/([^/]+)\/pause$/,
    ['orgId', 'id'],
    pauseRoute as unknown as RouteModule,
  ],
  [
    /^\/api\/orgs\/([^/]+)\/notifications$/,
    ['orgId'],
    notificationsRoute as unknown as RouteModule,
  ],
  [/^\/api\/orgs\/([^/]+)\/tags$/, ['orgId'], tagsRoute as unknown as RouteModule],
  [/^\/api\/orgs\/([^/]+)\/status-pages$/, ['orgId'], statusPagesRoute as unknown as RouteModule],
  [
    /^\/api\/orgs\/([^/]+)\/monitors\/([^/]+)\/check$/,
    ['orgId', 'id'],
    checkRoute as unknown as RouteModule,
  ],
  [/^\/api\/orgs\/([^/]+)\/import$/, ['orgId'], importRoute as unknown as RouteModule],
  [
    /^\/api\/orgs\/([^/]+)\/monitors\/([^/]+)\/clone$/,
    ['orgId', 'id'],
    cloneRoute as unknown as RouteModule,
  ],
]

/** `fetch` that hands requests to the route handlers instead of the network. */
const routeFetch: typeof fetch = async (input, init) => {
  const request = new Request(input as string, init)
  const { pathname } = new URL(request.url)
  for (const [pattern, names, mod] of ROUTES) {
    const match = pattern.exec(pathname)
    if (!match) continue
    const handler = mod[request.method as keyof RouteModule]
    if (!handler) return new Response(null, { status: 405 })
    const params = Object.fromEntries(
      names.map((name, i) => [name, decodeURIComponent(match[i + 1])]),
    )
    return handler(request, { params: Promise.resolve(params) })
  }
  return Response.json({ errors: [{ message: 'Not Found' }] }, { status: 404 })
}

let payload: Payload
const run_ = Date.now().toString(36)
let org: Organization
let writeKey: string
let readKey: string
const files = new Map<string, string>()

async function cli(argv: string[], key = writeKey) {
  let stdout = ''
  let stderr = ''
  const io: CliIo = {
    env: {
      MARMOT_URL: 'http://localhost:3000',
      MARMOT_API_KEY: key,
      MARMOT_ORG: String(org.id),
      MARMOT_CONFIG: '/nonexistent/marmot-cli-test.json',
      API_TOKEN: 'from-env',
    },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    isTTY: false,
    interactive: false,
    fetch: routeFetch,
    readFile: async (path) => {
      const text = files.get(path)
      if (text === undefined) throw new Error('ENOENT')
      return text
    },
    writeFile: async (path, text) => void files.set(path, text),
    readStdin: async () => '',
    confirm: async () => false,
  }
  const code = await run(argv, io)
  return { code, stdout, stderr }
}

async function mintKey(scope: 'read' | 'write') {
  const generated = generateApiKey()
  await payload.create({
    collection: 'api-keys',
    overrideAccess: true,
    data: {
      organization: org.id,
      name: `cli ${scope}`,
      scope,
      keyHash: generated.keyHash,
      prefix: generated.prefix,
    },
  })
  return generated.key
}

const orgMonitors = async () =>
  (
    await payload.find({
      collection: 'monitors',
      where: { organization: { equals: org.id } },
      sort: 'name',
      depth: 0,
      limit: 0,
      pagination: false,
      overrideAccess: true,
    })
  ).docs as Monitor[]

const MONITORS_YAML = `
# yaml-language-server: $schema=./marmot.schema.json
version: 1
monitors:
  - key: backend
    name: Backend
    type: group
  - key: api
    name: API
    type: http
    url: http://localhost:3000/api/health
    interval: 30
    parent: backend
    notifications: [Ops webhook]
    tags: [prod, { tag: region, value: eu }]
    authMethod: bearer
    bearerToken: \${API_TOKEN}
  - key: docs
    name: Docs
    type: keyword
    url: http://localhost:3000/docs
    keyword: Marmot
    active: false
`

describe('marmot CLI against the management API', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    org = await payload.create({
      collection: 'organizations',
      data: { name: 'CLI org', slug: `cli-org-${run_}` },
    })
    writeKey = await mintKey('write')
    readKey = await mintKey('read')
    await payload.create({
      collection: 'notifications',
      overrideAccess: true,
      data: {
        organization: org.id,
        name: 'Ops webhook',
        type: 'webhook',
        config: { url: 'https://hooks.example.com/marmot', method: 'POST', contentType: 'json' },
        active: true,
      } as never,
    })
    // A monitor made in the UI, without a key.
    await payload.create({
      collection: 'monitors',
      overrideAccess: true,
      data: {
        ...defaultMonitorValues('http'),
        name: 'Legacy',
        url: 'http://localhost:3000/legacy',
        active: false,
        organization: org.id,
      } as never,
    })
    files.set('marmot.yaml', MONITORS_YAML)
  })

  afterAll(async () => {
    if (!org) return
    // One by one: deleting a group detaches its children, which a bulk delete may have removed.
    for (const monitor of await orgMonitors()) {
      await payload.delete({ collection: 'monitors', id: monitor.id, overrideAccess: true })
    }
    const { docs: tags } = await payload.find({
      collection: 'tags',
      where: { organization: { equals: org.id } },
      overrideAccess: true,
    })
    for (const tag of tags) {
      await payload.delete({ collection: 'tags', id: tag.id, overrideAccess: true })
    }
    for (const collection of ['notifications', 'api-keys', 'audit-logs'] as const) {
      await payload.delete({
        collection,
        where: { organization: { equals: org.id } },
        overrideAccess: true,
      })
    }
    await payload.delete({ collection: 'organizations', id: org.id, overrideAccess: true })
  })

  it('plans creates without changing anything, with exit code 3 for CI', async () => {
    const result = await cli(['monitors', 'plan', '-f', 'marmot.yaml', '--exit-code', '--no-color'])
    expect(result.stderr).toBe('')
    expect(result.code).toBe(3)
    expect(result.stdout).toContain('+ create  api  "API" (http)')
    expect(result.stdout).toContain('bearerToken: (sensitive value)')
    expect(result.stdout).not.toContain('from-env')
    expect(result.stdout).toContain('Plan: 3 to create, 0 to update, 0 to delete, 0 unchanged.')
    expect(await orgMonitors()).toHaveLength(1)
  })

  it('refuses to apply without -y outside a terminal', async () => {
    const result = await cli(['monitors', 'apply', '-f', 'marmot.yaml'])
    expect(result.code).toBe(2)
    expect(await orgMonitors()).toHaveLength(1)
  })

  it('applies the file: tags, parents, channels, credentials and keys', async () => {
    const result = await cli(['monitors', 'apply', '-f', 'marmot.yaml', '-y', '--json'])
    expect(result.code).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.summary).toEqual({ create: 3, update: 0, delete: 0, unchanged: 0 })
    expect(report.applied.tagsCreated).toEqual(['prod', 'region'])

    const monitors = await orgMonitors()
    const byKey = new Map(monitors.map((m) => [m.key, m]))
    const api = byKey.get('api')!
    expect(String(api.parent)).toBe(String(byKey.get('backend')!.id))
    expect(api.bearerToken).toBe('from-env')
    expect(api.interval).toBe(30)
    expect(api.notifications).toHaveLength(1)
    expect(api.tags).toHaveLength(2)
    expect(byKey.get('docs')!.active).toBe(false)
    expect(byKey.get(null)?.name).toBe('Legacy')
  })

  it('is idempotent: a second plan has no changes', async () => {
    const result = await cli(['monitors', 'plan', '-f', 'marmot.yaml', '--exit-code', '--json'])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).summary).toEqual({
      create: 0,
      update: 0,
      delete: 0,
      unchanged: 3,
    })
  })

  it('round-trips: import then apply only records keys, then nothing is left to do', async () => {
    const exported = await cli(['monitors', 'import', '-o', 'exported.yaml'])
    expect(exported.code).toBe(0)
    const yaml = files.get('exported.yaml')!
    expect(yaml).toContain('key: legacy')
    expect(yaml).toContain('parent: backend')

    const first = await cli(['monitors', 'apply', '-f', 'exported.yaml', '-y', '--json'])
    expect(first.code).toBe(0)
    const plan = JSON.parse(first.stdout)
    expect(plan.summary).toEqual({ create: 0, update: 1, delete: 0, unchanged: 3 })
    expect(plan.changes.find((c: { key: string }) => c.key === 'legacy')).toMatchObject({
      adopted: true,
      fields: [{ field: 'key', before: null, after: 'legacy' }],
    })

    const again = await cli(['monitors', 'import', '-o', 'exported-2.yaml'])
    expect(again.code).toBe(0)
    const second = await cli(['monitors', 'plan', '-f', 'exported-2.yaml', '--exit-code'])
    expect(second.code).toBe(0)
    expect(second.stdout).toContain('Plan: 0 to create, 0 to update, 0 to delete, 4 unchanged.')
  })

  it('updates changed fields and prunes keyed monitors missing from the file', async () => {
    files.set('marmot.yaml', MONITORS_YAML.replace('interval: 30', 'interval: 90'))
    const result = await cli([
      'monitors',
      'apply',
      '-f',
      'marmot.yaml',
      '--prune',
      '-y',
      '--no-color',
    ])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('interval: 30 → 90')
    expect(result.stdout).toContain('- delete  legacy')
    const monitors = await orgMonitors()
    expect(monitors.map((m) => m.key).sort()).toEqual(['api', 'backend', 'docs'])
    expect(monitors.find((m) => m.key === 'api')!.interval).toBe(90)
  })

  it('reports invalid files with exit code 2 and the schema messages', async () => {
    files.set('bad.yaml', 'monitors:\n  - { key: x, name: X, type: http, url: "", interval: 1 }\n')
    const result = await cli(['monitors', 'plan', '-f', 'bad.yaml'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('monitors[0].url: URL is required')
    expect(result.stderr).toContain('monitors[0].interval: At least 20 seconds')
  })

  it('plans with a read key but cannot apply with it', async () => {
    const plan = await cli(['monitors', 'plan', '-f', 'marmot.yaml', '--json'], readKey)
    expect(plan.code).toBe(0)
    expect(JSON.parse(plan.stdout).warnings[0]).toContain('cannot list notification channels')

    files.set('change.yaml', MONITORS_YAML.replace('interval: 30', 'interval: 120'))
    const apply = await cli(['monitors', 'apply', '-f', 'change.yaml', '-y'], readKey)
    expect(apply.code).toBe(1)
    expect(apply.stderr).toContain('read scope')
  })

  it('lists, shows, pauses and summarises monitors', async () => {
    const list = await cli(['monitors', 'list', '--json'])
    expect(list.code).toBe(0)
    expect(JSON.parse(list.stdout).map((m: Monitor) => m.key)).toEqual(['api', 'backend', 'docs'])

    const info = await cli(['monitors', 'info', 'api', '--no-color'])
    expect(info.code).toBe(0)
    expect(info.stdout).toContain('http://localhost:3000/api/health')

    const logs = await cli(['monitors', 'logs', 'api', '--json'])
    expect(logs.code).toBe(0)
    expect(JSON.parse(logs.stdout)).toEqual([])

    const pause = await cli(['monitors', 'pause', 'api'])
    expect(pause.code).toBe(0)
    expect((await orgMonitors()).find((m) => m.key === 'api')!.active).toBe(false)

    const status = await cli(['status', '--json', '--fail-on-down'])
    expect(status.code).toBe(0)
    expect(JSON.parse(status.stdout).total).toBe(2)

    const missing = await cli(['monitors', 'info', 'nope'])
    expect(missing.code).toBe(1)
  })

  it('needs a write key to run a check now', async () => {
    const result = await cli(['monitors', 'check', 'api'], readKey)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('read scope')
  })

  it('rejects unknown commands and flags with exit code 2', async () => {
    expect((await cli(['monitors', 'frobnicate'])).code).toBe(2)
    expect((await cli(['monitors', 'list', '--prune'])).code).toBe(2)
    expect((await cli(['status-pages', 'list', '--json'])).code).toBe(0)
  })

  describe('server support for monitors as code', () => {
    const call = (method: string, path: string, body?: unknown) =>
      routeFetch(`http://localhost:3000/api/orgs/${org.id}${path}`, {
        method,
        headers: { authorization: `Bearer ${writeKey}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })

    it('keeps keys unique per organization and valid', async () => {
      const base = { ...defaultMonitorValues('http'), name: 'Dup', url: 'http://localhost:3000/x' }
      const taken = await call('POST', '/monitors', { ...base, key: 'api' })
      expect(taken.status).toBe(400)
      expect(JSON.stringify(await taken.json())).toContain('already uses the key')
      const invalid = await call('POST', '/monitors', { ...base, key: 'no spaces' })
      expect(invalid.status).toBe(400)

      const api = (await orgMonitors()).find((m) => m.key === 'api')!
      const byKey = await (await call('GET', '/monitors?key=api')).json()
      expect(byKey.docs.map((m: Monitor) => m.id)).toEqual([api.id])
      // The key may be kept on update, and a copy does not inherit it.
      expect(
        (await call('PATCH', `/monitors/${api.id}`, { key: 'api', interval: 60 })).status,
      ).toBe(200)
      const copy = await (await call('POST', `/monitors/${api.id}/clone`)).json()
      expect(copy.key ?? null).toBeNull()
      await payload.delete({ collection: 'monitors', id: copy.id, overrideAccess: true })
    })

    it('lists and creates tags, refusing duplicate names', async () => {
      const list = await (await call('GET', '/tags')).json()
      expect(list.docs.map((tag: { name: string }) => tag.name)).toEqual(['prod', 'region'])
      expect((await call('POST', '/tags', { name: 'prod' })).status).toBe(409)
      expect((await call('POST', '/tags', { name: 'staging', color: 'red' })).status).toBe(400)
      expect((await call('POST', '/tags', { name: 'staging' })).status).toBe(201)
    })

    it('answers the latest heartbeats of a monitor of the organization, newest first', async () => {
      const api = (await orgMonitors()).find((m) => m.key === 'api')!
      for (const [minute, status] of [
        [1, 'up'],
        [2, 'down'],
        [3, 'up'],
      ] as const) {
        await payload.create({
          collection: 'heartbeats',
          overrideAccess: true,
          data: {
            monitor: api.id,
            organization: org.id,
            status,
            msg: `beat ${minute}`,
            important: status === 'down',
            time: new Date(Date.UTC(2026, 9, 7, 12, minute)).toISOString(),
          } as never,
        })
      }
      const logs = await cli(['monitors', 'logs', 'api', '--limit', '2', '--json'])
      expect(JSON.parse(logs.stdout).map((b: { msg: string }) => b.msg)).toEqual([
        'beat 3',
        'beat 2',
      ])
      const important = await (
        await call('GET', `/monitors/${api.id}/heartbeats?important=true`)
      ).json()
      expect(important.docs.map((b: { msg: string }) => b.msg)).toEqual(['beat 2'])
      expect((await call('GET', '/monitors/999999999/heartbeats')).status).toBe(404)
    })

    it('imports a Marmot export through the server, dropping keys already in use', async () => {
      files.set(
        'export.json',
        JSON.stringify({
          format: 'marmot',
          version: 1,
          exportedAt: new Date().toISOString(),
          organization: { name: 'Other', slug: 'other' },
          notifications: [],
          statusPages: [],
          templates: [],
          monitors: [
            {
              ...defaultMonitorValues('http'),
              id: 1,
              key: 'api',
              name: 'Imported API',
              url: 'http://localhost:3000/imported',
              notifications: [],
              pushToken: null,
            },
          ],
        }),
      )
      const result = await cli(['import', '-f', 'export.json', '--dry-run', '--json'])
      expect(result.code).toBe(0)
      const report = JSON.parse(result.stdout)
      expect(report.monitors.create).toBe(1)
      expect(report.warnings.join('\n')).toContain('the key "api" is already used')
    })
  })
})
