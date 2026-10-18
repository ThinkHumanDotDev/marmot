import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { httpSuiteSchema, type HttpSuite } from '@/lib/validation/http-suite'
import type { Monitor } from '@/payload-types'

import './http-suite'
import { closedTcpPort, makeContext, makeMonitor } from './test-helpers'
import { getMonitorType } from './registry'

const PASSWORD = 'hunter2-very-secret'
const TOKEN = 'tok_9f8e7d6c5b4a'

/** A tiny API: log in for a token, read the profile with it, log out, plus an item resource. */
let server: http.Server
let base: string
let calls: string[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      calls.push(`${req.method} ${url.pathname}`)
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
        res
          .writeHead(status, { 'content-type': 'application/json', ...headers })
          .end(JSON.stringify(value))
      if (url.pathname === '/login') {
        const { password } = JSON.parse(body || '{}') as { password?: string }
        // The token is echoed in the body (as login APIs do) and must not survive in the log.
        if (password === PASSWORD) return json(200, { data: { token: TOKEN, user: 'monitor' } })
        return json(401, { error: 'bad password', password })
      }
      if (url.pathname === '/me') {
        if (req.headers.authorization === `Bearer ${TOKEN}`) {
          return json(200, { name: 'Monitor', token: TOKEN })
        }
        return json(401, { error: 'invalid token', got: req.headers.authorization })
      }
      if (url.pathname === '/logout') return json(204, {})
      if (url.pathname === '/items' && req.method === 'POST') {
        return json(201, { id: 42 }, { location: '/items/42' })
      }
      if (url.pathname === '/items/42') return json(200, { id: 42, name: 'probe' })
      return json(404, { error: 'not found' })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  calls = []
})

const suite = (input: unknown): HttpSuite => httpSuiteSchema.parse(input) as HttpSuite

function loginSuite(password = PASSWORD) {
  return suite({
    vars: { base },
    secrets: { password },
    steps: [
      {
        key: 'login',
        name: 'log in',
        method: 'POST',
        url: '{{ vars.base }}/login',
        body: '{"password": "{{ secrets.password }}"}',
        store: { token: { from: '$.data.token', secret: true } },
      },
      {
        key: 'profile',
        name: 'get profile',
        url: '{{ vars.base }}/me',
        headers: { Authorization: 'Bearer {{ steps.login.token }}' },
        assertions: [{ kind: 'jsonBody', target: '$.name', comparator: 'eq', value: 'Monitor' }],
      },
      {
        key: 'logout',
        name: 'log out',
        method: 'POST',
        url: '{{ vars.base }}/logout',
        headers: { Authorization: 'Bearer {{ vars.token }}' },
        acceptedStatusCodes: '200-299',
        alwaysRun: true,
      },
    ],
  })
}

async function run(httpSuite: HttpSuite, over: Partial<Monitor> = {}) {
  const ctx = makeContext(
    makeMonitor({ type: 'http-suite', httpSuite: httpSuite as never, timeout: 5, ...over }),
  )
  let error: Error | null = null
  try {
    await getMonitorType('http-suite')!.check(ctx)
  } catch (err) {
    error = err as Error
  }
  return { ctx, error }
}

/** Everything the worker would store from this check, as one string. */
const stored = (ctx: Awaited<ReturnType<typeof run>>['ctx'], error: Error | null) =>
  JSON.stringify({
    msg: ctx.heartbeat.msg,
    error: error?.message,
    steps: ctx.steps,
    response: ctx.response,
  })

describe('http-suite monitor type', () => {
  it('passes a login → profile → logout suite and passes the token on', async () => {
    const { ctx, error } = await run(loginSuite())
    expect(error).toBeNull()
    expect(ctx.heartbeat.status).toBe('up')
    expect(ctx.heartbeat.msg).toBe('3 steps passed')
    expect(calls).toEqual(['POST /login', 'GET /me', 'POST /logout'])
    expect(ctx.steps?.map((s) => [s.key, s.outcome, s.statusCode])).toEqual([
      ['login', 'passed', 200],
      ['profile', 'passed', 200],
      ['logout', 'passed', 204],
    ])
    expect(ctx.steps?.[0]?.stored).toEqual(['token'])
    expect(ctx.steps?.[1]?.assertions.some((a) => a.kind === 'jsonBody' && a.passed)).toBe(true)
    // Per-step timing, placed one after the other.
    for (const step of ctx.steps ?? []) expect(step.duration).toBeGreaterThanOrEqual(0)
    expect(ctx.steps![1]!.start).toBeGreaterThanOrEqual(ctx.steps![0]!.start)
    expect(typeof ctx.heartbeat.ping).toBe('number')
    expect(stored(ctx, error)).not.toContain(TOKEN)
    expect(stored(ctx, error)).not.toContain(PASSWORD)
  })

  it('fails at the step that is refused and still runs the cleanup step', async () => {
    const httpSuite = loginSuite()
    // A wrong token: the profile step gets 401.
    httpSuite.steps[1]!.headers = [{ name: 'Authorization', value: 'Bearer not-the-token' }]
    const { ctx, error } = await run(httpSuite)
    expect(error?.message).toBe('step 2 "get profile": status 401')
    expect(calls).toEqual(['POST /login', 'GET /me', 'POST /logout'])
    expect(ctx.steps?.map((s) => s.outcome)).toEqual(['passed', 'failed', 'passed'])
    // The response log shows the failing step.
    expect(ctx.response?.statusCode).toBe(401)
    expect(ctx.heartbeat.statusCode).toBe(401)
    expect(stored(ctx, error)).not.toContain(TOKEN)
    // The header value the step sent is scrubbed where the target echoes it.
    expect(stored(ctx, error)).not.toContain('not-the-token')
  })

  it('skips non-cleanup steps after a failure and redacts a rejected secret', async () => {
    const { ctx, error } = await run(loginSuite('wrong-password-123'))
    expect(error?.message).toBe('step 1 "log in": status 401')
    // The profile step is skipped; logout needs `vars.token`, which login never stored.
    expect(calls).toEqual(['POST /login'])
    expect(ctx.steps?.map((s) => s.outcome)).toEqual(['failed', 'skipped', 'skipped'])
    expect(ctx.steps?.[2]?.msg).toBe('skipped: vars.token is not available')
    // The server echoes the password it got; the stored body has it redacted.
    expect(ctx.response?.body).toContain('[redacted]')
    expect(stored(ctx, error)).not.toContain('wrong-password-123')
  })

  it('stores values from headers and uses them in later URLs and assertions', async () => {
    const { ctx, error } = await run(
      suite({
        vars: { base },
        steps: [
          {
            key: 'create',
            method: 'POST',
            url: `${base}/items`,
            body: '{"name": "probe"}',
            store: { location: 'header:location', id: '$.id' },
          },
          {
            key: 'read',
            url: '{{ vars.base }}{{ steps.create.location }}',
            assertions: [
              { kind: 'jsonBody', target: '$.id', comparator: 'eq', value: '{{ vars.id }}' },
            ],
          },
        ],
      }),
    )
    expect(error).toBeNull()
    expect(calls).toEqual(['POST /items', 'GET /items/42'])
    expect(ctx.steps?.[1]?.url).toBe(`${base}/items/42`)
    expect(ctx.steps?.[1]?.assertions.find((a) => a.kind === 'jsonBody')?.expected).toBe('42')
  })

  it('fails when a value to store is missing', async () => {
    const { ctx, error } = await run(
      suite({
        steps: [{ key: 'one', url: `${base}/items/42`, store: { token: '$.data.token' } }],
      }),
    )
    expect(error?.message).toBe(
      'step 1 "one": could not store token: "$.data.token" matched nothing',
    )
    expect(ctx.steps?.[0]?.outcome).toBe('failed')
  })

  it('reports an unreachable target with the step name', async () => {
    const port = await closedTcpPort()
    const { ctx, error } = await run(
      suite({ steps: [{ key: 'ping', name: 'health', url: `http://127.0.0.1:${port}/` }] }),
    )
    expect(error?.message).toMatch(/^step 1 "health": .*ECONNREFUSED/)
    expect(ctx.steps?.[0]).toMatchObject({ outcome: 'failed', statusCode: null })
    expect(ctx.response).toBeNull()
  })

  it('refuses a monitor without steps', async () => {
    const { error } = await run(suite({ steps: [] }))
    expect(error?.message).toBe('The suite has no steps')
  })
})
