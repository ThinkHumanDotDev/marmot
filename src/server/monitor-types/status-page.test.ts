import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Monitor } from '@/payload-types'

import { getMonitorType } from './index'
import { resetDetectedProviders } from './status-page'
import { cacheLifetimeSeconds, MAX_CACHE_SECONDS, statusPageBase } from './status-page-fetch'
import type { MonitorCheckContext } from './types'

const fixture = (name: string): string =>
  readFileSync(join(__dirname, '../../lib/__fixtures__/status-pages', name), 'utf8')

/** Routes of the fake vendor: path → [content type, body, extra headers]. */
type Route = [string, string, Record<string, string>?]
let routes: Record<string, Route> = {}
let hits: string[] = []
let server: Server
let base: string

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    hits.push(path)
    const route = routes[path]
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/html' })
      res.end('<html>not found</html>')
      return
    }
    res.writeHead(200, { 'Content-Type': route[0], ...(route[2] ?? {}) })
    res.end(route[1])
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

beforeEach(() => {
  routes = {}
  hits = []
  resetDetectedProviders()
})

const type = () => getMonitorType('status-page')!

function context(monitor: Partial<Monitor>): MonitorCheckContext {
  return {
    monitor: {
      id: 1,
      type: 'status-page',
      url: base,
      statusPageProvider: 'auto',
      statusPageComponents: null,
      interval: 120,
      timeout: 10,
      ...monitor,
    } as Monitor,
    heartbeat: { status: 'down', msg: '' },
    signal: AbortSignal.timeout(10_000),
    payload: {} as never,
  }
}

describe('status-page monitor type', () => {
  it('detects a Statuspage summary and goes DOWN when the filtered component has a major outage', async () => {
    routes['/api/v2/summary.json'] = [
      'application/json',
      fixture('atlassian-summary.json'),
      { 'Cache-Control': 'max-age=300, public' },
    ]
    const ctx = context({ statusPageComponents: [{ id: 'br0l2tvcx85d', name: 'Actions' }] })
    await expect(type().check(ctx)).rejects.toThrow(
      'Actions · Major outage: Disruption with some GitHub Actions workflows (https://stspg.io/abc123def)',
    )
    expect(ctx.cacheSeconds).toBe(300)
  })

  it('stays up for a healthy component and remembers the detected format', async () => {
    routes['/summary.json'] = ['application/json', fixture('instatus-summary.json')]
    routes['/v2/components.json'] = ['application/json', fixture('instatus-components.json')]
    const ctx = context({ statusPageComponents: [{ id: 'cl7a1b2c3d0012', name: 'API (US)' }] })
    await type().check(ctx)
    expect(ctx.heartbeat.status).toBe('up')
    expect(ctx.heartbeat.msg).toBe('API (US) · All systems operational')
    expect(hits).toContain('/api/v2/summary.json') // tried first, 404

    hits = []
    await type().check(context({ statusPageComponents: [{ id: 'cl7a1b2c3d0012' }] }))
    expect(hits).not.toContain('/api/v2/summary.json')
  })

  it('reports a degraded vendor as DEGRADED and maintenance as MAINTENANCE', async () => {
    routes['/index.json'] = ['application/json', fixture('betterstack-index.json')]
    const ctx = context({ statusPageProvider: 'betterstack' })
    await type().check(ctx)
    expect(ctx.heartbeat.status).toBe('degraded')
    expect(ctx.heartbeat.msg).toContain('Slow checkout responses')

    routes['/api/v2/summary.json'] = ['application/json', fixture('atlassian-summary.json')]
    const maint = context({
      statusPageProvider: 'atlassian',
      statusPageComponents: [{ id: 'h2ftsgbw7kmk' }],
    })
    await type().check(maint)
    expect(maint.heartbeat.status).toBe('maintenance')
  })

  it('goes DOWN when every filtered component disappeared', async () => {
    routes['/api/v2/summary.json'] = ['application/json', fixture('atlassian-summary.json')]
    await expect(
      type().check(context({ statusPageComponents: [{ id: 'gone', name: 'Old thing' }] })),
    ).rejects.toThrow('component no longer on the status page: Old thing (gone)')
  })

  it('falls back to the feed the page advertises', async () => {
    routes['/'] = [
      'text/html',
      '<html><head><link rel="alternate" type="application/rss+xml" href="/history.rss"></head></html>',
    ]
    routes['/history.rss'] = ['application/rss+xml', fixture('resolved.atom')]
    const ctx = context({})
    await type().check(ctx)
    expect(ctx.heartbeat.status).toBe('up')
  })

  it('names the URL when nothing supported answers', async () => {
    await expect(type().check(context({}))).rejects.toThrow(/No supported status page found/)
  })
})

describe('status page fetch helpers', () => {
  it('reads max-age before Expires and caps it', () => {
    expect(cacheLifetimeSeconds(new Headers({ 'cache-control': 'public, max-age=60' }))).toBe(60)
    expect(cacheLifetimeSeconds(new Headers({ 'cache-control': 'no-cache, max-age=60' }))).toBe(
      null,
    )
    expect(
      cacheLifetimeSeconds(
        new Headers({
          date: 'Sat, 11 Oct 2026 14:00:00 GMT',
          expires: 'Sat, 11 Oct 2026 14:05:00 GMT',
        }),
      ),
    ).toBe(300)
    expect(cacheLifetimeSeconds(new Headers({ 'cache-control': 'max-age=999999' }))).toBe(
      MAX_CACHE_SECONDS,
    )
    expect(cacheLifetimeSeconds(new Headers())).toBeNull()
  })

  it('normalises pasted URLs to the page base', () => {
    expect(statusPageBase('https://www.githubstatus.com/')).toBe('https://www.githubstatus.com')
    expect(statusPageBase('https://www.githubstatus.com/api/v2/summary.json')).toBe(
      'https://www.githubstatus.com',
    )
    expect(statusPageBase('https://marmot.example/status/acme/?x=1')).toBe(
      'https://marmot.example/status/acme',
    )
  })
})
