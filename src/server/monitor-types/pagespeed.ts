/**
 * PageSpeed / Lighthouse monitor (#137): audits `url` with Lighthouse and judges the category
 * scores (performance, accessibility, best practices, SEO) against the monitor's minimums. Two
 * backends, picked per monitor (`pagespeedBackend`):
 *
 * - `psi`: Google's PageSpeed Insights v5 API (`PAGESPEED_API_URL`), with the `pagespeedApiKey`
 *   instance setting or `PAGESPEED_API_KEY` as key (anonymous requests share a small quota). Google
 *   loads the page from its own network, so only public pages can be audited. A quota answer (429),
 *   an API outage (5xx) or an unreachable API defers the check: Marmot could not judge the page.
 * - `lighthouse`: Lighthouse driving the remote Chromium (`remoteBrowser`, a Chrome DevTools
 *   Protocol websocket such as browserless) through `puppeteer-core`. Both packages are optional
 *   dependencies loaded inside `check()`; Marmot never launches a local Chromium.
 *
 * The scores and the main metrics (LCP, FCP, TBT, Speed Index, TTFB, CLS, and the field INP from
 * PageSpeed Insights) are stored on the heartbeat (`heartbeats.pagespeed`) and rolled up for the
 * trend charts of the detail page, whatever the verdict. A run below a minimum is DEGRADED or DOWN
 * (`pagespeedFailStatus`) with a message such as `performance 54 < 70`; a run Lighthouse could not
 * complete (page unreachable, nothing painted) is DOWN.
 */
import { env } from '@/env'
import {
  describeFailures,
  describeScores,
  evaluatePagespeed,
  fieldInp,
  monitorCategories,
  pagespeedReportUrl,
  parseLighthouseResult,
  PAGESPEED_CATEGORIES,
  PAGESPEED_THRESHOLD_FIELDS,
  type PagespeedCategory,
  type PagespeedRun,
  type PagespeedStrategy,
} from '@/lib/pagespeed'
import { LIGHTHOUSE_LABEL } from '@/server/security/monitor-targets'
import { assertHostLocalAllowed } from '@/server/security/outbound-guard'
import { getInstanceSettings } from '@/server/settings'

import { assertHttpUrl } from './real-browser'
import { registerMonitorType } from './registry'
import { CheckDeferredError, type MonitorCheckContext } from './types'
import { checkTimeoutMs, errorMessage, loadOptionalDriver, requireField, withAbort } from './util'

const USER_AGENT = 'Marmot (+https://github.com/thinkhumandotdev/marmot)'

interface PsiError {
  code?: number
  message?: string
}

/** Turns a failed PageSpeed Insights answer into the right error. */
function psiFailure(status: number, body: unknown, hasKey: boolean): Error {
  const error = (body as { error?: PsiError } | null)?.error
  const message = (typeof error?.message === 'string' ? error.message : '').trim()
  // Lighthouse could not audit the page (DNS failure, refused or failed document request…): the
  // page is the problem, whatever the status code.
  if (/^Lighthouse returned error/i.test(message)) return new Error(message)
  if (status === 429) {
    return new CheckDeferredError(
      `PageSpeed Insights quota exceeded; the check runs again at the next interval.${
        hasKey ? '' : ' Set an API key in the instance settings for a higher quota.'
      }`,
    )
  }
  const detail = message ? `${status}: ${message}` : String(status)
  if (status >= 500) {
    return new CheckDeferredError(
      `PageSpeed Insights unavailable (${detail}); the check runs again at the next interval.`,
    )
  }
  return new Error(`PageSpeed Insights API error ${detail}`)
}

/** Runs PageSpeed Insights and returns the answer's JSON. */
async function runPsi(
  ctx: MonitorCheckContext,
  url: string,
  strategy: PagespeedStrategy,
  categories: readonly PagespeedCategory[],
): Promise<unknown> {
  const settings = await getInstanceSettings(ctx.payload)
  const key = settings.pagespeedApiKey || env.PAGESPEED_API_KEY || null
  const endpoint = new URL(env.PAGESPEED_API_URL)
  endpoint.searchParams.set('url', url)
  endpoint.searchParams.set('strategy', strategy.toUpperCase())
  for (const category of categories) {
    endpoint.searchParams.append('category', category.replace('-', '_').toUpperCase())
  }
  if (key) endpoint.searchParams.set('key', key)

  let res: Response
  try {
    res = await fetch(endpoint, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: ctx.signal,
    })
  } catch (err) {
    if (ctx.signal.aborted) throw err
    const cause = (err as { cause?: unknown })?.cause
    throw new CheckDeferredError(
      `PageSpeed Insights unreachable (${cause instanceof Error ? cause.message : errorMessage(err)}); the check runs again at the next interval.`,
    )
  }
  const text = await res.text()
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    // Handled below: a proxy error page or a truncated answer.
  }
  if (!res.ok) throw psiFailure(res.status, body, Boolean(key))
  if (!body || typeof body !== 'object') {
    throw new Error('PageSpeed Insights answered with something that is not JSON')
  }
  return body
}

/** Runs Lighthouse in the remote browser and returns its result (LHR). */
async function runLighthouse(
  ctx: MonitorCheckContext,
  url: string,
  strategy: PagespeedStrategy,
  categories: readonly PagespeedCategory[],
): Promise<unknown> {
  // Chromium resolves and connects on its own, past the outbound address guard.
  assertHostLocalAllowed(LIGHTHOUSE_LABEL)
  const remote = ctx.monitor.remoteBrowser?.trim()
  if (!remote) {
    throw new Error(
      'Remote browser URL is required: Lighthouse runs in a remote Chromium (ws://…, Chrome DevTools Protocol) and Marmot does not launch one itself.',
    )
  }
  const [lighthouseModule, puppeteerModule] = await Promise.all([
    loadOptionalDriver(() => import('lighthouse'), 'lighthouse', 'PageSpeed (Lighthouse)'),
    loadOptionalDriver(() => import('puppeteer-core'), 'puppeteer-core', 'PageSpeed (Lighthouse)'),
  ])
  const lighthouse = lighthouseModule.default
  const timeout = checkTimeoutMs(ctx.monitor)
  const browser = await withAbort(
    puppeteerModule.default.connect({
      browserWSEndpoint: remote,
      protocolTimeout: timeout,
      acceptInsecureCerts: Boolean(ctx.monitor.ignoreTls),
    }),
    ctx.signal,
  )
  try {
    const page = await browser.newPage()
    const result = await withAbort(
      lighthouse(
        url,
        {
          output: 'json',
          logLevel: 'error',
          onlyCategories: [...categories],
          maxWaitForLoad: timeout,
        },
        strategy === 'desktop' ? lighthouseModule.desktopConfig : undefined,
        page as unknown as Parameters<typeof lighthouse>[3],
      ),
      ctx.signal,
      () => void browser.close().catch(() => undefined),
    )
    if (!result?.lhr) throw new Error('Lighthouse returned no result')
    return result.lhr
  } finally {
    await browser.close().catch(() => undefined)
  }
}

/** The monitor's minimum score per category (`pagespeedMin*`), empty ones left out. */
function thresholds(ctx: MonitorCheckContext): Partial<Record<PagespeedCategory, number>> {
  const out: Partial<Record<PagespeedCategory, number>> = {}
  for (const category of PAGESPEED_CATEGORIES) {
    const value = ctx.monitor[PAGESPEED_THRESHOLD_FIELDS[category]]
    if (typeof value === 'number' && Number.isFinite(value)) out[category] = value
  }
  return out
}

registerMonitorType({
  name: 'pagespeed',
  label: 'PageSpeed / Lighthouse',
  group: 'general',
  allowCustomStatus: true,
  async check(ctx) {
    const { monitor } = ctx
    const url = assertHttpUrl(requireField(monitor.url, 'URL')).href
    const strategy: PagespeedStrategy =
      monitor.pagespeedStrategy === 'desktop' ? 'desktop' : 'mobile'
    const backend = monitor.pagespeedBackend === 'lighthouse' ? 'lighthouse' : 'psi'
    const categories = monitorCategories(monitor.pagespeedCategories)

    let lhr: unknown
    let inp: number | null = null
    if (backend === 'psi') {
      const body = await runPsi(ctx, url, strategy, categories)
      lhr = (body as { lighthouseResult?: unknown }).lighthouseResult
      inp = fieldInp(body)
    } else {
      lhr = await runLighthouse(ctx, url, strategy, categories)
    }

    const parsed = parseLighthouseResult(lhr)
    const run: PagespeedRun = {
      backend,
      strategy,
      scores: parsed.scores,
      metrics: { ...parsed.metrics, ...(inp !== null ? { inp: Math.round(inp) } : {}) },
      finalUrl: parsed.finalUrl,
      lighthouseVersion: parsed.lighthouseVersion,
      reportUrl: backend === 'psi' ? pagespeedReportUrl(url, strategy) : null,
    }
    ctx.pagespeed = run
    // The response time of the page's document, as Lighthouse measured it.
    if (typeof run.metrics.ttfb === 'number') ctx.heartbeat.ping = run.metrics.ttfb

    const failures = evaluatePagespeed(run.scores, thresholds(ctx), categories)
    if (failures.length === 0) {
      ctx.heartbeat.status = 'up'
      ctx.heartbeat.msg = `${describeScores(run.scores) || 'No scores'} (${strategy})`
      return
    }
    const msg = `${describeFailures(failures)} (${strategy})`
    if (monitor.pagespeedFailStatus === 'down') throw new Error(msg)
    ctx.heartbeat.status = 'degraded'
    ctx.heartbeat.msg = msg
  },
})
