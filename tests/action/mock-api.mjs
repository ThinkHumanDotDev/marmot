#!/usr/bin/env node
// A stand-in for Marmot's management API, for testing the GitHub Action (action/action.yml) in
// .github/workflows/action.yml without starting the app. It answers the few routes the action calls
// for organization 1 with the API key `mk_test`: the monitor list, "check now" (#98), tags and
// notification channels. Usage: node tests/action/mock-api.mjs [port] (default 4010).
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 4010)
const KEY = 'mk_test'

const status = (lastStatus) => ({ lastStatus, lastCheckAt: '2026-10-07T12:00:00.000Z' })
const monitors = [
  {
    id: 1,
    key: 'api',
    name: 'API',
    type: 'http',
    url: 'https://api.example.com/health',
    active: true,
    status: status('up'),
  },
  {
    id: 2,
    key: 'website',
    name: 'Website',
    type: 'http',
    url: 'https://www.example.com',
    active: true,
    status: status('up'),
  },
  {
    id: 3,
    key: 'checkout',
    name: 'Checkout',
    type: 'http',
    url: 'https://shop.example.com/checkout',
    active: true,
    status: status('up'),
  },
  {
    id: 4,
    key: 'search',
    name: 'Search',
    type: 'http',
    url: 'https://search.example.com',
    active: true,
    status: status('up'),
  },
]

const base = {
  startedAt: '2026-10-07T12:00:00.000Z',
  elapsedMs: 120,
  blocked: false,
  maintenance: false,
  tls: null,
  details: {},
  recorded: true,
  heartbeat: null,
}
const results = {
  1: { ...base, status: 'up', ok: true, msg: '200 - OK', ping: 87, statusCode: 200 },
  2: {
    ...base,
    status: 'degraded',
    ok: true,
    msg: '200 - OK (slower than 1000 ms)',
    ping: 1450,
    statusCode: 200,
  },
  3: {
    ...base,
    status: 'down',
    ok: false,
    msg: 'Assertion failed: status equals 200 (got 502)',
    ping: 230,
    statusCode: 502,
    details: {
      assertions: [
        {
          kind: 'status',
          target: null,
          comparator: 'equals',
          expected: '200',
          actual: '502',
          passed: false,
        },
      ],
    },
  },
  4: {
    ...base,
    status: 'maintenance',
    ok: true,
    msg: 'Under maintenance',
    ping: null,
    statusCode: null,
    maintenance: true,
  },
}

const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const error = (res, code, message) => send(res, code, { errors: [{ message }] })

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`)
  if (url.pathname === '/health') return send(res, 200, { ok: true })
  if (req.headers.authorization !== `Bearer ${KEY}`) return error(res, 401, 'Invalid API key.')
  const match = url.pathname.match(/^\/api\/orgs\/1(\/.*)$/)
  if (!match) return error(res, 404, 'Not found.')
  const path = match[1]

  if (req.method === 'GET' && path === '/monitors') {
    const key = url.searchParams.get('key')
    return send(res, 200, {
      docs: key ? monitors.filter((m) => m.key === key) : monitors,
      hasNextPage: false,
    })
  }
  const check = path.match(/^\/monitors\/([^/]+)\/check$/)
  if (req.method === 'POST' && check) {
    const result = results[check[1]]
    return result ? send(res, 200, result) : error(res, 404, 'Monitor not found.')
  }
  if (req.method === 'GET' && (path === '/tags' || path === '/notifications')) {
    return send(res, 200, { docs: [] })
  }
  return error(res, 404, 'Not found.')
}).listen(port, () => process.stdout.write(`mock Marmot API on http://localhost:${port}\n`))
