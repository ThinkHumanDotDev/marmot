import { readFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'
import { POST as lookupComponents } from '@/app/api/orgs/[orgId]/status-page-components/route'
import { STATUS_PAGE_MIN_INTERVAL_SECONDS } from '@/lib/validation/status-page-monitor'
import type { Heartbeat, Monitor, Organization, User } from '@/payload-types'
import { processCheckJob, type ChecksQueue } from '@/server/engine'
import { effectiveIntervalMs } from '@/server/engine/scheduler'

/**
 * Third-party status page monitor (#125): a member adds a vendor's status page filtered to one
 * component; the monitor follows that component, honours the vendor's cache lifetime, and the
 * component lookup behind the form lists what the vendor publishes.
 */

const FIXTURES = path.join(process.cwd(), 'src/lib/__fixtures__/status-pages')
const summary = readFileSync(path.join(FIXTURES, 'atlassian-summary.json'), 'utf8')

const run = Date.now().toString(36)
const PASSWORD = 'password-123'

let payload: Payload
let server: http.Server
let base: string
let maxAge = 300
let org: Organization
let member: User

const queue = {
  upsertJobScheduler: vi.fn(async () => undefined),
  removeJobScheduler: vi.fn(async () => true),
} as unknown as ChecksQueue

async function check(monitor: Monitor): Promise<{ heartbeat: Heartbeat; monitor: Monitor }> {
  const result = await processCheckJob(
    payload,
    { data: { monitorId: String(monitor.id) } },
    { queue },
  )
  expect(result.outcome).toBe('processed')
  const updated = (await payload.findByID({
    collection: 'monitors',
    id: monitor.id,
    depth: 0,
    overrideAccess: true,
  })) as Monitor
  return { heartbeat: result.heartbeat as Heartbeat, monitor: updated }
}

async function memberRequest(body: unknown): Promise<Request> {
  const { token } = await payload.login({
    collection: 'users',
    data: { email: member.email, password: PASSWORD },
  })
  return new Request('http://localhost/api/test', {
    method: 'POST',
    headers: { Authorization: `JWT ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  payload = await getPayload({ config })
  server = http.createServer((req, res) => {
    if (req.url === '/api/v2/summary.json') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': `max-age=${maxAge}, public`,
      })
      res.end(summary)
      return
    }
    res.writeHead(404, { 'content-type': 'text/html' })
    res.end('<html></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  org = await payload.create({
    collection: 'organizations',
    data: { name: 'Vendor watch', slug: `vendor-watch-${run}` },
  })
  member = await payload.create({
    collection: 'users',
    data: { email: `member+vendor-${run}@marmot.test`, password: PASSWORD, name: 'Member' },
  })
  await addOrgMembership({ payload, userId: member.id, orgId: org.id, role: 'member' })
})

afterAll(async () => {
  server?.closeAllConnections()
  await new Promise((resolve) => server?.close(resolve))
  await payload.delete({
    collection: 'heartbeats',
    where: { organization: { equals: org.id } },
    overrideAccess: true,
  })
  await payload.delete({
    collection: 'monitors',
    where: { organization: { equals: org.id } },
    overrideAccess: true,
  })
  await payload.delete({ collection: 'users', where: { id: { equals: member.id } } })
  await payload.delete({ collection: 'organizations', where: { id: { equals: org.id } } })
})

describe('third-party status page monitor', () => {
  it('lists the vendor components for the form', async () => {
    const res = await lookupComponents(await memberRequest({ url: `${base}/` }), {
      params: Promise.resolve({ orgId: String(org.id) }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      provider: string
      pageName: string
      components: { id: string; name: string; indicator: string }[]
    }
    expect(body.provider).toBe('atlassian')
    expect(body.pageName).toBe('GitHub')
    expect(body.components.find((c) => c.id === 'br0l2tvcx85d')).toEqual({
      id: 'br0l2tvcx85d',
      name: 'Actions',
      indicator: 'major',
    })

    const invalid = await lookupComponents(await memberRequest({ url: 'ftp://nope' }), {
      params: Promise.resolve({ orgId: String(org.id) }),
    })
    expect(invalid.status).toBe(400)
  })

  it('goes DOWN when the followed component reports a major outage, and waits for the cache lifetime', async () => {
    // Fresh document: the membership was added after the user was created.
    const fresh = await payload.findByID({ collection: 'users', id: member.id, depth: 0 })
    const user = { ...fresh, collection: 'users' as const }
    const monitor = (await payload.create({
      collection: 'monitors',
      user,
      overrideAccess: false,
      depth: 0,
      data: {
        organization: org.id,
        name: 'GitHub Actions',
        type: 'status-page',
        url: base,
        statusPageComponents: [{ id: 'br0l2tvcx85d', name: 'Actions (renamed since)' }],
        interval: 60,
        retryInterval: 60,
        maxRetries: 0,
        resendInterval: 0,
        timeout: 10,
      },
    })) as Monitor

    // The configured interval is below the polite floor.
    expect(effectiveIntervalMs(monitor)).toBe(STATUS_PAGE_MIN_INTERVAL_SECONDS * 1000)

    const first = await check(monitor)
    expect(first.heartbeat.status).toBe('down')
    expect(first.heartbeat.msg).toBe(
      'Actions · Major outage: Disruption with some GitHub Actions workflows (https://stspg.io/abc123def)',
    )
    // `max-age=300` beats the 120 s floor and the 60 s interval.
    expect(first.monitor.status?.cacheSeconds).toBe(300)
    expect(effectiveIntervalMs(first.monitor)).toBe(300_000)

    // A shorter max-age falls back to the floor.
    maxAge = 30
    const second = await check(first.monitor)
    expect(second.monitor.status?.cacheSeconds).toBe(30)
    expect(effectiveIntervalMs(second.monitor)).toBe(STATUS_PAGE_MIN_INTERVAL_SECONDS * 1000)
  })

  it('reports a component id the vendor removed in the heartbeat', async () => {
    const monitor = (await payload.create({
      collection: 'monitors',
      overrideAccess: true,
      depth: 0,
      data: {
        organization: org.id,
        name: 'GitHub Git',
        type: 'status-page',
        url: `${base}/api/v2/summary.json`,
        statusPageProvider: 'atlassian',
        statusPageComponents: [
          { id: '8l4ygp009s5s', name: 'Git Operations' },
          { id: 'removed00000', name: 'Webhooks' },
        ],
        interval: 120,
        retryInterval: 120,
        maxRetries: 0,
        resendInterval: 0,
        timeout: 10,
      },
    })) as Monitor
    const { heartbeat } = await check(monitor)
    expect(heartbeat.status).toBe('up')
    expect(heartbeat.msg).toContain(
      'component no longer on the status page: Webhooks (removed00000)',
    )
  })
})
