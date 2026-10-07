import { describe, expect, it } from 'vitest'

import { defaultMonitorValues } from '@/lib/validation/monitor'

import { applyPlan, type ApplyApi } from './apply'
import type { MonitorDoc } from './client'
import { exportMonitors, secretVariableName, toYaml } from './export'
import { hasChanges, planMonitors, type RemoteState } from './plan'
import {
  interpolateEnv,
  monitorsDocumentJsonSchema,
  parseSpecText,
  readSpecDocument,
  SpecError,
} from './spec'

/** A stored monitor document as the API returns it (`depth: 0`). */
const doc = (id: number, fields: Partial<MonitorDoc> & { name: string }): MonitorDoc => ({
  ...defaultMonitorValues((fields.type as never) ?? 'http'),
  url: 'https://example.com',
  id,
  key: null,
  type: 'http',
  status: { lastStatus: 'up' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...fields,
})

const state = (monitors: MonitorDoc[], extra: Partial<RemoteState> = {}): RemoteState => ({
  monitors,
  notifications: [
    { id: 1, name: 'Ops Slack' },
    { id: 2, name: 'Pager' },
  ],
  tags: [{ id: 7, name: 'prod' }],
  ...extra,
})

const fromYaml = (yaml: string, env: Record<string, string> = {}) =>
  readSpecDocument(parseSpecText(yaml), env).document

describe('monitors document', () => {
  it('reads YAML and checks keys, types and unknown fields', () => {
    expect(() =>
      fromYaml(`
monitors:
  - { key: a, name: A, type: http, url: https://a.test }
  - { key: a, name: B, type: nope, colour: red }
  - { name: C, type: http }
`),
    ).toThrow(SpecError)
    try {
      fromYaml(`
monitors:
  - { key: a, name: A, type: http, url: https://a.test }
  - { key: a, name: B, type: nope, colour: red }
  - { key: "-x", name: C, type: http }
`)
    } catch (error) {
      const paths = (error as SpecError).issues.map((issue) => issue.path)
      expect(paths).toEqual([
        'monitors[1].key',
        'monitors[1].type',
        'monitors[1].colour',
        'monitors[2].key',
      ])
    }
  })

  it('interpolates ${VAR}, ${VAR:-default} and $${ escapes, and reports unset variables', () => {
    const issues: { path: string; message: string }[] = []
    expect(
      interpolateEnv(
        { a: 'Bearer ${TOKEN}', b: ['${MISSING:-fallback}', 'cost $${HOME}'], c: '${NOPE}' },
        { TOKEN: 's3cret' },
        '',
        issues,
      ),
    ).toEqual({ a: 'Bearer s3cret', b: ['fallback', 'cost ${HOME}'], c: '${NOPE}' })
    expect(issues).toEqual([{ path: 'c', message: 'The environment variable NOPE is not set.' }])
  })

  it('converts a Marmot export: ids become keys and channel names', () => {
    const document = readSpecDocument({
      format: 'marmot',
      version: 1,
      notifications: [{ id: 11, name: 'Ops Slack' }],
      monitors: [
        {
          ...defaultMonitorValues('group'),
          id: 1,
          name: 'Backend',
          parent: null,
          notifications: [],
        },
        {
          ...defaultMonitorValues('http'),
          id: 2,
          key: 'api',
          name: 'API',
          url: 'https://api.test',
          parent: 1,
          notifications: [11],
          tags: [{ tag: 99, value: null }],
        },
      ],
    }).document
    expect(document.monitors.map((m) => [m.key, m.parent ?? null, m.notifications])).toEqual([
      ['backend', null, []],
      ['api', 'backend', ['Ops Slack']],
    ])
  })

  it('publishes a JSON Schema with the form fields and name references', () => {
    const schema = monitorsDocumentJsonSchema() as {
      properties: {
        monitors: { items: { properties: Record<string, unknown>; required: string[] } }
      }
    }
    const entry = schema.properties.monitors.items
    expect(entry.required.sort()).toEqual(['key', 'name', 'type'])
    expect(Object.keys(entry.properties)).toEqual(
      expect.arrayContaining(['url', 'interval', 'parent', 'tags']),
    )
  })
})

describe('planMonitors', () => {
  it('creates entries without a match and lists only non-default fields', () => {
    const { plan } = planMonitors(
      fromYaml(`
monitors:
  - key: api
    name: API
    type: http
    url: https://api.test/health
    interval: 30
    tags: [prod, { tag: region, value: eu }]
`),
      state([]),
    )
    expect(plan.summary).toEqual({ create: 1, update: 0, delete: 0, unchanged: 0 })
    expect(plan.createTags).toEqual(['region'])
    expect(plan.changes[0].fields.map((f) => f.field)).toEqual([
      'name',
      'type',
      'key',
      'tags',
      'url',
      'interval',
    ])
    expect(hasChanges(plan)).toBe(true)
  })

  it('updates only the fields that differ and masks credentials', () => {
    const current = doc(5, {
      key: 'api',
      name: 'API',
      url: 'https://api.test/health',
      authMethod: 'basic',
      basicAuthUser: 'u',
      basicAuthPass: 'old',
      notifications: [1],
    })
    const { plan } = planMonitors(
      fromYaml(`
monitors:
  - key: api
    name: API
    type: http
    url: https://api.test/health
    interval: 120
    authMethod: basic
    basicAuthUser: u
    basicAuthPass: new
    notifications: [Pager, Ops Slack]
`),
      state([current]),
    )
    expect(plan.changes).toHaveLength(1)
    expect(plan.changes[0]).toMatchObject({ action: 'update', id: 5, adopted: false })
    expect(plan.changes[0].fields).toEqual([
      {
        field: 'notifications',
        before: ['Ops Slack'],
        after: ['Ops Slack', 'Pager'],
        secret: false,
      },
      { field: 'interval', before: 60, after: 120, secret: false },
      { field: 'basicAuthPass', before: 'old', after: 'new', secret: true },
    ])
  })

  it('leaves channels and the paused state alone when the file omits them', () => {
    const current = doc(5, { key: 'api', name: 'API', active: false, notifications: [2] })
    const { plan } = planMonitors(
      fromYaml('monitors: [{ key: api, name: API, type: http, url: "https://example.com" }]'),
      state([current]),
    )
    expect(plan.changes[0].action).toBe('unchanged')
    expect(hasChanges(plan)).toBe(false)
  })

  it('adopts the one unkeyed monitor with the same name and type, recording the key', () => {
    const { plan } = planMonitors(
      fromYaml('monitors: [{ key: site, name: Site, type: http, url: "https://example.com" }]'),
      state([doc(3, { name: 'Site' }), doc(4, { name: 'Site', type: 'keyword', keyword: 'ok' })]),
    )
    expect(plan.changes[0]).toMatchObject({ action: 'update', id: 3, adopted: true })
    expect(plan.changes[0].fields).toEqual([
      { field: 'key', before: null, after: 'site', secret: false },
    ])
  })

  it('deletes keyed monitors missing from the file only with prune, never unkeyed ones', () => {
    const monitors = [doc(1, { key: 'old', name: 'Old' }), doc(2, { name: 'Manual one' })]
    const document = fromYaml('monitors: []')
    const kept = planMonitors(document, state(monitors)).plan
    expect(kept.summary.delete).toBe(0)
    expect(kept.warnings[0]).toContain('old')
    const pruned = planMonitors(document, state(monitors), { prune: true }).plan
    expect(pruned.changes.map((c) => [c.action, c.key, c.id])).toEqual([['delete', 'old', 1]])
  })

  it('validates with the API schema and checks references', () => {
    expect.assertions(1)
    try {
      planMonitors(
        fromYaml(`
monitors:
  - { key: a, name: A, type: http, url: "", interval: 5 }
  - { key: b, name: B, type: http, url: "https://b.test", parent: d, notifications: [Nope] }
  - { key: c, name: C, type: http, url: "https://c.test", parent: ghost }
  - { key: d, name: D, type: http, url: "https://d.test" }
`),
        state([]),
      )
    } catch (error) {
      expect((error as SpecError).issues).toEqual([
        { path: 'monitors[0].interval', message: 'At least 20 seconds' },
        { path: 'monitors[0].url', message: 'URL is required' },
        { path: 'monitors[1].notifications', message: 'No notification channel named “Nope”.' },
        {
          path: 'monitors[2].parent',
          message: 'No monitor with the key “ghost” in the file or in Marmot.',
        },
        { path: 'monitors[1].parent', message: 'The parent “d” is not a group monitor.' },
      ])
    }
  })

  it('reports channels as unmanaged when the key cannot list them', () => {
    const current = doc(5, { key: 'api', name: 'API', notifications: [2] })
    const { plan } = planMonitors(
      fromYaml(
        'monitors: [{ key: api, name: API, type: http, url: "https://example.com", notifications: [] }]',
      ),
      state([current], { notifications: null }),
    )
    expect(plan.changes[0].action).toBe('unchanged')
    expect(plan.warnings).toHaveLength(1)
  })
})

describe('export round trip', () => {
  const server = state([
    doc(1, { key: 'backend', name: 'Backend', type: 'group', url: null }),
    doc(2, {
      name: 'API',
      parent: 1,
      url: 'https://api.test',
      interval: 30,
      notifications: [1],
      tags: [{ tag: 7, value: 'eu' }],
      active: false,
      bearerToken: 'secret',
      authMethod: 'bearer',
    }),
  ])

  it('writes only non-default fields, with references by name and generated keys', () => {
    const { document, generatedKeys } = exportMonitors(server)
    expect(generatedKeys).toEqual(['api'])
    expect(document.monitors[1]).toEqual({
      key: 'api',
      name: 'API',
      type: 'http',
      parent: 'backend',
      active: false,
      tags: [{ tag: 'prod', value: 'eu' }],
      notifications: ['Ops Slack'],
      url: 'https://api.test',
      interval: 30,
      authMethod: 'bearer',
      bearerToken: 'secret',
    })
  })

  it('plans no change other than recording generated keys, then nothing at all', () => {
    const yaml = toYaml(exportMonitors(server).document)
    const first = planMonitors(readSpecDocument(parseSpecText(yaml)).document, server).plan
    expect(first.changes.map((c) => [c.action, c.fields.map((f) => f.field)])).toEqual([
      ['unchanged', []],
      ['update', ['key']],
    ])
    const keyed = state(server.monitors.map((m) => (m.id === 2 ? { ...m, key: 'api' } : m)))
    const second = planMonitors(
      readSpecDocument(parseSpecText(toYaml(exportMonitors(keyed).document))).document,
      keyed,
    ).plan
    expect(hasChanges(second)).toBe(false)
  })

  it('redacts credentials as environment references that read back', () => {
    const result = exportMonitors(server, { redactSecrets: true })
    expect(result.secretVariables).toEqual(['MARMOT_API_BEARER_TOKEN'])
    expect(result.document.monitors[1].bearerToken).toBe('${MARMOT_API_BEARER_TOKEN}')
    expect(secretVariableName('db-1', 'basicAuthPass')).toBe('MARMOT_DB_1_BASIC_AUTH_PASS')
    const reread = readSpecDocument(parseSpecText(toYaml(result.document)), {
      MARMOT_API_BEARER_TOKEN: 'secret',
    }).document
    expect(reread.monitors[1].bearerToken).toBe('secret')
  })
})

describe('applyPlan', () => {
  it('creates tags first, parents before children, then updates and deletes with ids', async () => {
    const calls: [string, ...unknown[]][] = []
    let next = 100
    const api: ApplyApi = {
      createTag: async (name) => {
        calls.push(['createTag', name])
        return { id: next++, name }
      },
      createMonitor: async (body) => {
        calls.push(['create', body.key, body.parent ?? null, body.tags, 'notifications' in body])
        return { id: next++, name: String(body.name), type: String(body.type) }
      },
      updateMonitor: async (id, body) => {
        calls.push(['update', id, body])
        return { id, name: '', type: '' }
      },
      deleteMonitor: async (id) => {
        calls.push(['delete', id])
        return {}
      },
    }
    const server = state([
      doc(1, { key: 'site', name: 'Site' }),
      doc(2, { key: 'gone', name: 'Gone' }),
    ])
    const prepared = planMonitors(
      fromYaml(`
monitors:
  - { key: child, name: Child, type: http, url: "https://c.test", parent: grp, tags: [new] }
  - { key: grp, name: Group, type: group, notifications: [Pager] }
  - { key: site, name: Site, type: http, url: "https://example.com", interval: 300 }
`),
      server,
      { prune: true },
    )
    const result = await applyPlan(api, prepared)
    expect(calls).toEqual([
      ['createTag', 'new'],
      ['create', 'grp', null, [], true],
      ['create', 'child', 101, [{ tag: 100, value: null }], false],
      ['update', 1, { interval: 300 }],
      ['delete', 2],
    ])
    expect(result.created.map((c) => c.key)).toEqual(['grp', 'child'])
  })
})
