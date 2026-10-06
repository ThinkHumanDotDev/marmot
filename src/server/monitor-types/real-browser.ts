/**
 * Browser engine monitor: loads `url` in a real Chromium through a Playwright-compatible remote
 * browser (`remoteBrowser`, e.g. a browserless/playwright server `ws://…`) and is UP when the
 * navigation response is 2xx/3xx. `playwright-core` is an optional dependency loaded inside
 * `check()`; Marmot never launches a local Chromium, so the worker image stays small.
 *
 * Ported from Uptime Kuma 2.5.5 `server/monitor-types/real-browser-monitor-type.js` — Copyright
 * (c) 2021 Louis Lam, MIT License. See THIRD_PARTY_NOTICES.md. (Screenshots are not stored.)
 */
import { assertHostLocalAllowed } from '@/server/security/outbound-guard'

import { registerMonitorType } from './registry'
import { checkTimeoutMs, loadOptionalDriver, requireField, withAbort } from './util'

/** Only http(s) pages may be loaded (no `file://`, see GHSA-2qgm-m29m-cj2h). */
export function assertHttpUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid URL "${value}"`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Invalid url protocol, only http and https are allowed.')
  }
  return url
}

registerMonitorType({
  name: 'real-browser',
  label: 'HTTP(s) - Browser Engine (Chrome/Chromium)',
  group: 'general',
  async check(ctx) {
    // Chromium resolves and connects on its own (subresources, redirects, scripts), past the
    // outbound address guard.
    assertHostLocalAllowed('The Browser Engine monitor')
    const url = assertHttpUrl(requireField(ctx.monitor.url, 'URL')).href
    const remote = ctx.monitor.remoteBrowser?.trim()
    if (!remote) {
      throw new Error(
        'Remote browser URL is required: Marmot connects to a Playwright-compatible remote browser (ws://…) and does not launch Chromium itself.',
      )
    }
    const { chromium } = await loadOptionalDriver(
      () => import('playwright-core'),
      'playwright-core',
      'Browser Engine',
    )
    const timeout = checkTimeoutMs(ctx.monitor)

    const browser = await withAbort(chromium.connect(remote, { timeout }), ctx.signal)
    try {
      const context = await browser.newContext({
        ignoreHTTPSErrors: Boolean(ctx.monitor.ignoreTls),
      })
      try {
        const page = await context.newPage()
        const res = await withAbort(
          page.goto(url, { waitUntil: 'networkidle', timeout }),
          ctx.signal,
          () => void page.close().catch(() => undefined),
        )
        if (!res) throw new Error('No response received for the navigation')
        const status = res.status()
        if (status < 200 || status >= 400) {
          throw new Error(String(status))
        }
        const timing = res.request().timing()
        ctx.heartbeat.ping = timing.responseEnd >= 0 ? Math.round(timing.responseEnd) : null
        ctx.heartbeat.msg = String(status)
        ctx.heartbeat.status = 'up'
      } finally {
        await context.close().catch(() => undefined)
      }
    } finally {
      await browser.close().catch(() => undefined)
    }
  },
})
