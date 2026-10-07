import { describe, expect, it } from 'vitest'

import type { CheckResult, MonitorDoc } from '../cli/core/client'
import type { Plan } from '../cli/core/plan'
import { checksExitCode, failedAssertions, keysFromFile, verdictFor, type CheckRow } from './checks'
import { annotation, getInput, outputBlock, type ActionIo } from './github'
import { InputError, parseList, readInputs } from './inputs'
import { runAction } from './main'
import { applyMarkdown, cell, checksMarkdown, planDiff } from './summary'

const CONNECTION = {
  INPUT_URL: 'https://status.example.com',
  'INPUT_API-KEY': 'mk_x',
  INPUT_ORG: '1',
}

const result = (fields: Partial<CheckResult>): CheckResult => ({
  status: 'up',
  ok: true,
  msg: '200 - OK',
  ping: 50,
  startedAt: '2026-10-07T12:00:00.000Z',
  elapsedMs: 60,
  statusCode: 200,
  maintenance: false,
  details: {},
  ...fields,
})

const row = (fields: Partial<CheckRow>): CheckRow => ({
  ref: 'api',
  id: 1,
  key: 'api',
  name: 'API',
  status: 'up',
  ping: 50,
  statusCode: 200,
  message: '200 - OK',
  assertions: [],
  verdict: 'pass',
  note: null,
  ...fields,
})

describe('action inputs', () => {
  it('reads inputs the way the runner passes them', () => {
    expect(getInput({ 'INPUT_API-KEY': ' mk_1 ' }, 'api-key')).toBe('mk_1')
    expect(getInput({ INPUT_FAIL_ON_DEGRADED: 'x' }, 'fail on degraded')).toBe('x')
    expect(parseList('api, web\n#12  db\n')).toEqual(['api', 'web', '#12', 'db'])
  })

  it('defaults to run mode and falls back to the CLI environment variables', () => {
    const inputs = readInputs({
      MARMOT_URL: 'https://m.example.com',
      MARMOT_API_KEY: 'mk_env',
      MARMOT_ORG: '7',
      INPUT_MONITORS: 'api',
    })
    expect(inputs).toMatchObject({
      url: 'https://m.example.com',
      apiKey: 'mk_env',
      org: '7',
      mode: 'run',
      monitors: ['api'],
      failOnDegraded: false,
    })
  })

  it('plans by default on pull requests and applies on push', () => {
    const apply = { ...CONNECTION, INPUT_MODE: 'apply', INPUT_CONFIG: 'marmot.yaml' }
    expect(readInputs({ ...apply, GITHUB_EVENT_NAME: 'pull_request' })).toMatchObject({
      dryRun: true,
      dryRunEvent: 'pull_request',
    })
    expect(readInputs({ ...apply, GITHUB_EVENT_NAME: 'push' }).dryRun).toBe(false)
    expect(
      readInputs({ ...apply, GITHUB_EVENT_NAME: 'pull_request', 'INPUT_DRY-RUN': 'false' }).dryRun,
    ).toBe(false)
    expect(
      readInputs({ ...apply, GITHUB_EVENT_NAME: 'push', 'INPUT_DRY-RUN': 'true' }),
    ).toMatchObject({ dryRun: true, dryRunEvent: null })
  })

  it('rejects incomplete or invalid inputs', () => {
    expect(() => readInputs({ ...CONNECTION })).toThrow(InputError)
    expect(() => readInputs({ ...CONNECTION, INPUT_MODE: 'apply' })).toThrow(/config/)
    expect(() => readInputs({ ...CONNECTION, INPUT_MODE: 'deploy' })).toThrow(/deploy/)
    expect(() => readInputs({ INPUT_MONITORS: 'api' })).toThrow(/MARMOT_URL/)
    expect(() =>
      readInputs({ ...CONNECTION, INPUT_MONITORS: 'api', 'INPUT_FAIL-ON-DEGRADED': 'maybe' }),
    ).toThrow(/fail-on-degraded/)
  })
})

describe('check verdicts', () => {
  it('fails on down, pending (retries left) and unknown statuses', () => {
    expect(verdictFor(result({ status: 'up' }), [], false).verdict).toBe('pass')
    expect(verdictFor(result({ status: 'down' }), [], false).verdict).toBe('fail')
    expect(verdictFor(result({ status: 'pending' }), [], false)).toMatchObject({
      verdict: 'fail',
      note: expect.stringContaining('retries'),
    })
    expect(verdictFor(result({ status: 'weird' }), [], false).verdict).toBe('fail')
  })

  it('fails on degraded only with fail-on-degraded', () => {
    expect(verdictFor(result({ status: 'degraded' }), [], false)).toMatchObject({
      verdict: 'pass',
      note: expect.stringContaining('fail-on-degraded'),
    })
    expect(verdictFor(result({ status: 'degraded' }), [], true).verdict).toBe('fail')
  })

  it('skips monitors in maintenance', () => {
    expect(verdictFor(result({ status: 'maintenance' }), [], true).verdict).toBe('skip')
    expect(verdictFor(result({ status: 'up', maintenance: true }), [], true).verdict).toBe('skip')
  })

  it('fails on failed assertions even when the status is up', () => {
    const lines = failedAssertions(
      result({
        details: {
          assertions: [
            {
              kind: 'status',
              target: null,
              comparator: 'equals',
              expected: '200',
              actual: '200',
              passed: true,
            },
            {
              kind: 'header',
              target: 'content-type',
              comparator: 'contains',
              expected: 'json',
              actual: 'text/html',
              passed: false,
            },
            {
              kind: 'jsonBody',
              target: '$.x',
              comparator: 'equals',
              expected: '1',
              actual: null,
              passed: false,
              error: 'invalid expression',
            },
          ],
        },
      }),
    )
    expect(lines).toEqual([
      'Assertion failed: header content-type contains json (got text/html)',
      'Assertion could not be evaluated: jsonBody $.x: invalid expression',
    ])
    expect(verdictFor(result({ status: 'up' }), lines, false).verdict).toBe('fail')
    expect(failedAssertions(result({ assertions: 'nope' }))).toEqual([])
  })

  it('exits non-zero when any check failed', () => {
    expect(checksExitCode([row({}), row({ verdict: 'skip' })])).toBe(0)
    expect(checksExitCode([row({}), row({ verdict: 'fail' })])).toBe(1)
    expect(checksExitCode([])).toBe(0)
  })

  it('takes the keys of active, checkable monitors from a monitors file', () => {
    const yaml = `version: 1
monitors:
  - { key: api, name: API, type: http, url: https://a.example.com, bearerToken: '\${NOT_SET}' }
  - { key: paused, name: Paused, type: http, active: false }
  - { key: cron, name: Cron, type: push }
  - { key: group, name: Group, type: group }
`
    expect(keysFromFile(yaml)).toEqual(['api', 'group'])
  })
})

describe('job summary', () => {
  it('escapes table cells', () => {
    expect(cell('a | b\n<script>&')).toBe('a \\| b &lt;script&gt;&amp;')
    expect(cell('x'.repeat(400))).toHaveLength(300)
  })

  it('renders the checks table with totals', () => {
    const markdown = checksMarkdown(
      [
        row({}),
        row({
          ref: '#3',
          key: null,
          id: 3,
          name: 'Checkout',
          status: 'down',
          ping: null,
          statusCode: 502,
          message: 'Bad Gateway',
          assertions: ['Assertion failed: status equals 200 (got 502)'],
          verdict: 'fail',
        }),
        row({
          ref: 'nope',
          ping: null,
          statusCode: null,
          id: null,
          key: null,
          name: null,
          status: 'error',
          verdict: 'fail',
          message: 'No monitor',
        }),
      ],
      'https://status.example.com',
    )
    expect(markdown).toContain('**1 passed, 2 failed, 0 skipped**')
    expect(markdown).toContain(
      '| ✅ passed | API <code>api</code> | up | 50 ms · HTTP 200 | 200 - OK |',
    )
    expect(markdown).toContain(
      '| ❌ failed | Checkout <code>#3</code> | down | HTTP 502 | Bad Gateway<br>Assertion failed: status equals 200 (got 502) |',
    )
    expect(markdown).toContain('| ❌ failed | <code>nope</code> | error |  | No monitor |')
  })

  const plan: Plan = {
    createTags: ['prod'],
    changes: [
      {
        action: 'create',
        key: 'api',
        name: 'API',
        type: 'http',
        id: null,
        adopted: false,
        fields: [{ field: 'url', before: null, after: 'https://a', secret: false }],
      },
      {
        action: 'update',
        key: 'web',
        name: 'Web',
        type: 'http',
        id: 2,
        adopted: false,
        fields: [
          { field: 'interval', before: 60, after: 30, secret: false },
          { field: 'basicAuthPass', before: 'old', after: 'new', secret: true },
        ],
      },
      {
        action: 'delete',
        key: 'old',
        name: 'Old',
        type: 'http',
        id: 3,
        adopted: false,
        fields: [],
      },
    ],
    warnings: ['something to know'],
    summary: { create: 1, update: 1, delete: 1, unchanged: 0 },
  }

  it('renders the plan as a diff without secrets', () => {
    const diff = planDiff(plan)
    expect(diff.split('\n').slice(0, 7)).toEqual([
      '+ create tag prod',
      '+ create  api  "API" (http)',
      '      url: "https://a"',
      '! update  web  "Web" (http) #2',
      '      interval: 60 → 30',
      '      basicAuthPass: (sensitive value changed)',
      '- delete  old  "Old" (http) #3',
    ])
    expect(diff).not.toContain('new')
    const markdown = applyMarkdown(
      { plan, dryRun: true, dryRunNote: null, applied: null, error: null },
      'marmot.yaml',
    )
    expect(markdown).toContain('```diff\n+ create tag prod')
    expect(markdown).toContain('- something to know')
    expect(markdown).toContain('> Dry run: nothing was applied.')
  })

  it('uses a longer fence when a value contains backticks', () => {
    const tricky: Plan = {
      ...plan,
      createTags: [],
      changes: [
        {
          ...plan.changes[0],
          fields: [{ field: 'description', before: null, after: '```', secret: false }],
        },
      ],
    }
    const markdown = applyMarkdown(
      {
        plan: tricky,
        dryRun: false,
        dryRunNote: null,
        applied: { created: [], updated: [], deleted: [], tagsCreated: [] },
        error: null,
      },
      'm.yaml',
    )
    expect(markdown).toContain('````diff\n')
    expect(markdown).toContain('✅ Applied: 0 created, 0 updated, 0 deleted.')
  })

  it('formats workflow commands and outputs', () => {
    expect(annotation('error', 'a\nb 100%', 'API: down, now')).toBe(
      '::error title=API%3A down%2C now::a%0Ab 100%25\n',
    )
    expect(outputBlock('plan', 'line 1\nline 2', 'EOF')).toBe('plan<<EOF\nline 1\nline 2\nEOF\n')
  })
})

/** A fake runner and API: `routes` answer `METHOD /path` (below `/api/orgs/1`). */
function harness(
  env: Record<string, string>,
  routes: Record<string, (body: unknown) => { status?: number; json: unknown }>,
  files: Record<string, string> = {},
) {
  const written: Record<string, string> = {}
  const calls: string[] = []
  let stdout = ''
  const io: ActionIo = {
    env: { GITHUB_STEP_SUMMARY: '/summary.md', GITHUB_OUTPUT: '/output.txt', ...env },
    stdout: (text) => {
      stdout += text
    },
    readFile: async (path) => {
      if (!(path in files)) throw new Error('ENOENT')
      return files[path]
    },
    appendFile: async (path, text) => {
      written[path] = (written[path] ?? '') + text
    },
    sleep: async () => undefined,
    fetch: (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const route = `${init?.method ?? 'GET'} ${url.pathname.replace('/api/orgs/1', '')}`
      calls.push(route)
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer mk_x')
      const handler = routes[route]
      if (!handler) return Response.json({ errors: [{ message: 'Not found.' }] }, { status: 404 })
      const answer = handler(init?.body ? JSON.parse(String(init.body)) : undefined)
      return Response.json(answer.json, { status: answer.status ?? 200 })
    }) as typeof fetch,
  }
  return {
    io,
    calls,
    written,
    stdout: () => stdout,
    outputs: () => {
      const outputs: Record<string, string> = {}
      for (const match of (written['/output.txt'] ?? '').matchAll(
        /^(\S+)<<(\S+)\n([\s\S]*?)\n\2$/gm,
      )) {
        outputs[match[1]] = match[3]
      }
      return outputs
    },
  }
}

const monitor = (id: number, key: string, name: string, extra: Partial<MonitorDoc> = {}) =>
  ({
    id,
    key,
    name,
    type: 'http',
    url: `https://${key}.example.com`,
    active: true,
    ...extra,
  }) as MonitorDoc

const MONITORS = [monitor(1, 'api', 'API'), monitor(2, 'web', 'Web')]

describe('runAction', () => {
  it('run: checks the listed monitors and passes when they are up', async () => {
    const h = harness(
      { ...CONNECTION, INPUT_MONITORS: 'api\n#2' },
      {
        'GET /monitors': () => ({ json: { docs: MONITORS, hasNextPage: false } }),
        'POST /monitors/1/check': () => ({ json: result({}) }),
        'POST /monitors/2/check': () => ({ json: result({ status: 'degraded', ping: 900 }) }),
      },
    )
    expect(await runAction(h.io)).toBe(0)
    expect(h.calls.filter((c) => c.endsWith('/check')).sort()).toEqual([
      'POST /monitors/1/check',
      'POST /monitors/2/check',
    ])
    expect(h.outputs()).toMatchObject({ result: 'passed', passed: '2', failed: '0' })
    expect(JSON.parse(h.outputs().json)).toHaveLength(2)
    expect(h.written['/summary.md']).toContain('**2 passed, 0 failed, 0 skipped**')
    expect(h.stdout()).toContain('::add-mask::mk_x')
    expect(h.stdout()).toContain('::warning title=Web::')
  })

  it('run: fails on a degraded check with fail-on-degraded, and on a down one', async () => {
    const routes = {
      'GET /monitors': () => ({ json: { docs: MONITORS, hasNextPage: false } }),
      'POST /monitors/1/check': () => ({ json: result({ status: 'degraded' }) }),
      'POST /monitors/2/check': () => ({
        json: result({ status: 'down', ok: false, msg: 'timeout' }),
      }),
    }
    const degraded = harness(
      { ...CONNECTION, INPUT_MONITORS: 'api', 'INPUT_FAIL-ON-DEGRADED': 'true' },
      routes,
    )
    expect(await runAction(degraded.io)).toBe(1)
    expect(degraded.outputs()).toMatchObject({ result: 'failed', failed: '1' })

    const down = harness({ ...CONNECTION, INPUT_MONITORS: 'web' }, routes)
    expect(await runAction(down.io)).toBe(1)
    expect(down.stdout()).toContain('::error title=Web%3A down::timeout')
  })

  it('run: retries rate-limited checks and reports unknown monitors and API errors', async () => {
    let attempts = 0
    const h = harness(
      { ...CONNECTION, INPUT_MONITORS: 'api web ghost' },
      {
        'GET /monitors': () => ({ json: { docs: MONITORS, hasNextPage: false } }),
        'POST /monitors/1/check': () =>
          ++attempts < 3
            ? { status: 429, json: { errors: [{ message: 'Too many requests.' }] } }
            : { json: result({}) },
        'POST /monitors/2/check': () => ({
          status: 409,
          json: { errors: [{ message: 'This monitor is paused.' }] },
        }),
      },
    )
    expect(await runAction(h.io)).toBe(1)
    expect(attempts).toBe(3)
    const rows = JSON.parse(h.outputs().json) as CheckRow[]
    expect(rows.map((r) => [r.ref, r.status, r.verdict])).toEqual([
      ['api', 'up', 'pass'],
      ['web', 'error', 'fail'],
      ['ghost', 'error', 'fail'],
    ])
    expect(rows[1].message).toBe('409 This monitor is paused.')
  })

  it('run: checks the monitors of the config file when monitors is empty', async () => {
    const h = harness(
      { ...CONNECTION, INPUT_CONFIG: 'marmot.yaml' },
      {
        'GET /monitors': () => ({ json: { docs: MONITORS, hasNextPage: false } }),
        'POST /monitors/1/check': () => ({ json: result({}) }),
      },
      {
        'marmot.yaml':
          'version: 1\nmonitors:\n  - { key: api, name: API, type: http }\n  - { key: web, name: Web, type: http, active: false }\n',
      },
    )
    expect(await runAction(h.io)).toBe(0)
    expect(h.calls).toContain('POST /monitors/1/check')
    expect(h.calls).not.toContain('POST /monitors/2/check')
  })

  it('reports a refused key in the summary and fails', async () => {
    const h = harness(
      { ...CONNECTION, INPUT_MONITORS: 'api' },
      {
        'GET /monitors': () => ({
          status: 401,
          json: { errors: [{ message: 'Invalid API key.' }] },
        }),
      },
    )
    expect(await runAction(h.io)).toBe(1)
    expect(h.written['/summary.md']).toContain('The Marmot API answered 401: Invalid API key.')
  })

  const applyRoutes = (created: unknown[]) => ({
    'GET /monitors': () => ({ json: { docs: [], hasNextPage: false } }),
    'GET /tags': () => ({ json: { docs: [] } }),
    'GET /notifications': () => ({ json: { docs: [] } }),
    'POST /monitors': (body: unknown) => {
      created.push(body)
      return { json: { id: 5, ...(body as object) } }
    },
  })
  const FILE = {
    'marmot.yaml':
      'version: 1\nmonitors:\n  - key: api\n    name: API\n    type: http\n    url: https://api.example.com\n',
  }

  it('apply: plans on pull requests without changing anything', async () => {
    const created: unknown[] = []
    const h = harness(
      {
        ...CONNECTION,
        INPUT_MODE: 'apply',
        INPUT_CONFIG: 'marmot.yaml',
        GITHUB_EVENT_NAME: 'pull_request',
      },
      applyRoutes(created),
      FILE,
    )
    expect(await runAction(h.io)).toBe(0)
    expect(created).toEqual([])
    expect(h.outputs()).toMatchObject({ changes: '1', 'dry-run': 'true' })
    expect(h.outputs().plan).toContain('+ create  api  "API" (http)')
    expect(h.written['/summary.md']).toContain('```diff\n+ create  api')
    expect(h.written['/summary.md']).toContain('pull_request')
  })

  it('apply: applies on push', async () => {
    const created: unknown[] = []
    const h = harness(
      {
        ...CONNECTION,
        INPUT_MODE: 'apply',
        INPUT_CONFIG: 'marmot.yaml',
        GITHUB_EVENT_NAME: 'push',
      },
      applyRoutes(created),
      FILE,
    )
    expect(await runAction(h.io)).toBe(0)
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ key: 'api', name: 'API', url: 'https://api.example.com' })
    expect(h.written['/summary.md']).toContain('✅ Applied: 1 created, 0 updated, 0 deleted.')
  })

  it('apply: fails on an invalid file or a refused change', async () => {
    const invalid = harness(
      { ...CONNECTION, INPUT_MODE: 'apply', INPUT_CONFIG: 'marmot.yaml' },
      applyRoutes([]),
      { 'marmot.yaml': 'version: 1\nmonitors:\n  - key: api\n    name: API\n    type: nope\n' },
    )
    expect(await runAction(invalid.io)).toBe(1)
    expect(invalid.written['/summary.md']).toContain('The monitors file is not valid:')

    const refused = harness(
      { ...CONNECTION, INPUT_MODE: 'apply', INPUT_CONFIG: 'marmot.yaml', 'INPUT_DRY-RUN': 'false' },
      {
        ...applyRoutes([]),
        'POST /monitors': () => ({
          status: 400,
          json: {
            errors: [
              {
                message: 'Invalid monitor.',
                data: { issues: [{ path: 'url', message: 'Bad URL' }] },
              },
            ],
          },
        }),
      },
      FILE,
    )
    expect(await runAction(refused.io)).toBe(1)
    expect(refused.written['/summary.md']).toContain('Apply stopped at api: Invalid monitor.')
    expect(refused.stdout()).toContain('url: Bad URL')

    const missing = harness({ ...CONNECTION, INPUT_MODE: 'apply', INPUT_CONFIG: 'nope.yaml' }, {})
    expect(await runAction(missing.io)).toBe(1)
    expect(missing.written['/summary.md']).toContain('Cannot read nope.yaml')
  })
})
