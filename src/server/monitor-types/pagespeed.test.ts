import { readFileSync } from 'node:fs'
import path from 'node:path'

import type { Payload } from 'payload'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Monitor } from '@/payload-types'
import { resetInstanceSettingsCache } from '@/server/settings'

import { makeContext, makeMonitor } from './test-helpers'
import { getMonitorType, isCheckDeferredError } from './index'

/**
 * PageSpeed monitor type (#137) against recorded PageSpeed Insights answers (`fetch` is mocked) and
 * a mocked Lighthouse / puppeteer-core pair: no request leaves the process.
 */
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/pagespeed', name), 'utf8'))

const lighthouseRun = vi.fn()
const browser = { newPage: vi.fn(async () => ({})), close: vi.fn(async () => undefined) }
const connect = vi.fn(async (_options: unknown) => browser)

vi.mock('lighthouse', () => ({
  default: (...args: unknown[]) => lighthouseRun(...args),
  desktopConfig: { extends: 'lighthouse:default', settings: { formFactor: 'desktop' } },
}))
vi.mock('puppeteer-core', () => ({ default: { connect: (o: unknown) => connect(o) } }))

const payloadWithKey = (pagespeedApiKey: string | null): Partial<Payload> =>
  ({
    findGlobal: vi.fn(async () => ({ pagespeedApiKey })),
    logger: { warn: vi.fn() },
  }) as unknown as Partial<Payload>

const monitor = (over: Partial<Monitor> = {}) =>
  makeMonitor({
    type: 'pagespeed',
    url: 'https://www.example.com/',
    interval: 900,
    timeout: 5,
    pagespeedStrategy: 'mobile',
    pagespeedMinPerformance: 70,
    ...over,
  })

async function check(m: Monitor, key: string | null = 'key-123') {
  const ctx = makeContext(m, { payload: payloadWithKey(key) })
  await getMonitorType('pagespeed')!.check(ctx)
  return ctx
}

const respond = (body: unknown, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  )

beforeEach(() => resetInstanceSettingsCache())
afterEach(() => {
  vi.restoreAllMocks()
  lighthouseRun.mockReset()
  connect.mockClear()
  browser.close.mockClear()
})

describe('pagespeed monitor, PageSpeed Insights backend', () => {
  it('is UP above the minimums and stores scores, metrics and the report link', async () => {
    const fetchSpy = respond(fixture('psi-mobile.json'))
    const ctx = await check(monitor({ pagespeedCategories: ['performance', 'best-practices'] }))

    expect(ctx.heartbeat.status).toBe('up')
    expect(ctx.heartbeat.msg).toBe(
      'performance 91, accessibility 97, best-practices 100, seo 92 (mobile)',
    )
    expect(ctx.heartbeat.ping).toBe(87)
    expect(ctx.pagespeed).toEqual({
      backend: 'psi',
      strategy: 'mobile',
      scores: { performance: 91, accessibility: 97, 'best-practices': 100, seo: 92 },
      metrics: { lcp: 2613, fcp: 1503, tbt: 122, si: 2104, ttfb: 87, cls: 0.021, inp: 143 },
      finalUrl: 'https://www.example.com/',
      lighthouseVersion: '12.8.2',
      reportUrl:
        'https://pagespeed.web.dev/analysis?url=https%3A%2F%2Fwww.example.com%2F&form_factor=mobile',
    })
    const requested = new URL(String(fetchSpy.mock.calls[0][0]))
    expect(requested.origin + requested.pathname).toBe(
      'https://www.googleapis.com/pagespeedonline/v5/runPagespeed',
    )
    expect(requested.searchParams.get('url')).toBe('https://www.example.com/')
    expect(requested.searchParams.get('strategy')).toBe('MOBILE')
    expect(requested.searchParams.getAll('category')).toEqual(['PERFORMANCE', 'BEST_PRACTICES'])
    expect(requested.searchParams.get('key')).toBe('key-123')
  })

  it('is degraded below a minimum, or DOWN when the monitor says so', async () => {
    respond(fixture('psi-mobile.json'))
    const degraded = await check(monitor({ pagespeedMinPerformance: 95, pagespeedMinSeo: 95 }))
    expect(degraded.heartbeat.status).toBe('degraded')
    expect(degraded.heartbeat.msg).toBe('performance 91 < 95, seo 92 < 95 (mobile)')
    expect(degraded.pagespeed?.scores.performance).toBe(91)

    const down = monitor({ pagespeedMinPerformance: 95, pagespeedFailStatus: 'down' })
    const ctx = makeContext(down, { payload: payloadWithKey(null) })
    await expect(getMonitorType('pagespeed')!.check(ctx)).rejects.toThrow(
      'performance 91 < 95 (mobile)',
    )
    // The scores of a failing run are still recorded for the trend charts.
    expect(ctx.pagespeed?.scores.performance).toBe(91)
  })

  it('is DOWN when Lighthouse cannot load the page, deferred on quota and outages', async () => {
    respond(fixture('psi-error-dns.json'), 400)
    await expect(check(monitor())).rejects.toThrow(/^Lighthouse returned error: DNS_FAILURE/)

    vi.restoreAllMocks()
    respond(fixture('psi-error-quota.json'), 429)
    const quota = await check(monitor()).catch((err: unknown) => err)
    expect(isCheckDeferredError(quota)).toBe(true)
    expect((quota as Error).message).toMatch(/quota exceeded/)

    vi.restoreAllMocks()
    respond({ error: { code: 503, message: 'The service is currently unavailable.' } }, 503)
    const outage = await check(monitor()).catch((err: unknown) => err)
    expect(isCheckDeferredError(outage)).toBe(true)

    vi.restoreAllMocks()
    respond(
      { error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } },
      400,
    )
    await expect(check(monitor())).rejects.toThrow(
      'PageSpeed Insights API error 400: API key not valid. Please pass a valid API key.',
    )

    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    expect(isCheckDeferredError(await check(monitor()).catch((err: unknown) => err))).toBe(true)
  })

  it('is DOWN on a Lighthouse runtime error in a successful answer', async () => {
    const body = fixture('psi-mobile.json') as { lighthouseResult: Record<string, unknown> }
    body.lighthouseResult.runtimeError = {
      code: 'NO_FCP',
      message: 'The page did not paint any content.',
    }
    respond(body)
    await expect(check(monitor())).rejects.toThrow(
      'Lighthouse failed: The page did not paint any content.',
    )
  })

  it('refuses non-HTTP URLs', async () => {
    await expect(check(monitor({ url: 'file:///etc/passwd' }))).rejects.toThrow(
      'only http and https',
    )
  })
})

describe('pagespeed monitor, Lighthouse backend', () => {
  it('runs Lighthouse in the remote browser with the desktop config', async () => {
    const lhr = (fixture('psi-mobile.json') as { lighthouseResult: unknown }).lighthouseResult
    lighthouseRun.mockResolvedValue({ lhr })
    const ctx = await check(
      monitor({
        pagespeedBackend: 'lighthouse',
        pagespeedStrategy: 'desktop',
        pagespeedCategories: ['performance'],
        remoteBrowser: 'ws://browserless:3000',
        ignoreTls: true,
      }),
    )
    expect(ctx.heartbeat.status).toBe('up')
    expect(ctx.pagespeed).toMatchObject({
      backend: 'lighthouse',
      strategy: 'desktop',
      reportUrl: null,
      metrics: { lcp: 2613 },
    })
    expect(ctx.pagespeed?.metrics).not.toHaveProperty('inp')
    expect(connect).toHaveBeenCalledWith({
      browserWSEndpoint: 'ws://browserless:3000',
      protocolTimeout: 5000,
      acceptInsecureCerts: true,
    })
    const [url, flags, config] = lighthouseRun.mock.calls[0] as [
      string,
      Record<string, unknown>,
      unknown,
    ]
    expect(url).toBe('https://www.example.com/')
    expect(flags).toMatchObject({ onlyCategories: ['performance'], output: 'json' })
    expect(config).toMatchObject({ settings: { formFactor: 'desktop' } })
    expect(browser.close).toHaveBeenCalled()
  })

  it('needs a remote browser and reports a failed run', async () => {
    await expect(check(monitor({ pagespeedBackend: 'lighthouse' }))).rejects.toThrow(
      'Remote browser URL is required',
    )
    lighthouseRun.mockResolvedValue(undefined)
    await expect(
      check(monitor({ pagespeedBackend: 'lighthouse', remoteBrowser: 'ws://browserless:3000' })),
    ).rejects.toThrow('Lighthouse returned no result')
    expect(browser.close).toHaveBeenCalled()
  })
})
