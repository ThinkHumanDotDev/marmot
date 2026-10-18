/**
 * PageSpeed / Lighthouse monitors (#137): options, the parsing of a Lighthouse result (the
 * PageSpeed Insights v5 API embeds the same `lighthouseResult`) and the threshold verdict. Shared by
 * the collection, the form, the monitor type, the stats rollups and the detail page, so it imports
 * nothing server-only.
 */

/** Lighthouse runs take tens of seconds and PageSpeed Insights has a daily quota: 15 minutes. */
export const PAGESPEED_MIN_INTERVAL_SECONDS = 900
/** Starting timeout of a new PageSpeed monitor (a run often takes 20–60 s). */
export const PAGESPEED_DEFAULT_TIMEOUT_SECONDS = 120

/** `psi`: Google's PageSpeed Insights v5 API; `lighthouse`: Lighthouse over the remote browser. */
export const PAGESPEED_BACKENDS = ['psi', 'lighthouse'] as const
export type PagespeedBackend = (typeof PAGESPEED_BACKENDS)[number]

export const PAGESPEED_STRATEGIES = ['mobile', 'desktop'] as const
export type PagespeedStrategy = (typeof PAGESPEED_STRATEGIES)[number]

/** Lighthouse category ids, as the API and `onlyCategories` spell them. */
export const PAGESPEED_CATEGORIES = [
  'performance',
  'accessibility',
  'best-practices',
  'seo',
] as const
export type PagespeedCategory = (typeof PAGESPEED_CATEGORIES)[number]

/** What a run below a threshold records. */
export const PAGESPEED_FAIL_STATUSES = ['degraded', 'down'] as const
export type PagespeedFailStatus = (typeof PAGESPEED_FAIL_STATUSES)[number]

/** Monitor field holding the minimum score (0–100) of each category; empty means no threshold. */
export const PAGESPEED_THRESHOLD_FIELDS = {
  performance: 'pagespeedMinPerformance',
  accessibility: 'pagespeedMinAccessibility',
  'best-practices': 'pagespeedMinBestPractices',
  seo: 'pagespeedMinSeo',
} as const satisfies Record<PagespeedCategory, string>
export type PagespeedThresholdField =
  (typeof PAGESPEED_THRESHOLD_FIELDS)[keyof typeof PAGESPEED_THRESHOLD_FIELDS]

/**
 * Stored metrics, in milliseconds except `cls` (unitless). All but `inp` are lab values of the run;
 * `inp` is the 75th percentile of real users (Chrome UX Report field data, PageSpeed Insights only,
 * when Google has enough traffic for the page) since a lab run cannot measure interactions.
 */
export const PAGESPEED_METRICS = ['lcp', 'fcp', 'tbt', 'si', 'ttfb', 'inp', 'cls'] as const
export type PagespeedMetric = (typeof PAGESPEED_METRICS)[number]

/** Lighthouse audit behind each lab metric. */
const METRIC_AUDITS: Record<Exclude<PagespeedMetric, 'inp'>, string> = {
  lcp: 'largest-contentful-paint',
  fcp: 'first-contentful-paint',
  tbt: 'total-blocking-time',
  si: 'speed-index',
  ttfb: 'server-response-time',
  cls: 'cumulative-layout-shift',
}

/** One run as stored on the heartbeat (`heartbeats.pagespeed`). */
export interface PagespeedRun {
  backend: PagespeedBackend
  strategy: PagespeedStrategy
  /** Category scores 0–100; a category Lighthouse could not score is absent. */
  scores: Partial<Record<PagespeedCategory, number>>
  metrics: Partial<Record<PagespeedMetric, number>>
  /** URL Lighthouse ended up on (after redirects). */
  finalUrl: string | null
  lighthouseVersion: string | null
  /** Where to read the full report (PageSpeed Insights web UI), `null` when there is none. */
  reportUrl: string | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** Thrown for a Lighthouse result that reports a failed run (`runtimeError`). */
export class LighthouseRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'LighthouseRuntimeError'
  }
}

/**
 * Scores and lab metrics of a Lighthouse result (LHR). Throws `LighthouseRuntimeError` when the run
 * itself failed (page unreachable, no content painted…).
 */
export function parseLighthouseResult(lhr: unknown): {
  scores: PagespeedRun['scores']
  metrics: PagespeedRun['metrics']
  finalUrl: string | null
  lighthouseVersion: string | null
} {
  if (!isRecord(lhr)) throw new Error('The answer has no Lighthouse result')
  const runtimeError = lhr.runtimeError
  if (isRecord(runtimeError) && typeof runtimeError.code === 'string') {
    throw new LighthouseRuntimeError(
      runtimeError.code,
      `Lighthouse failed: ${typeof runtimeError.message === 'string' ? runtimeError.message : runtimeError.code}`,
    )
  }
  const scores: PagespeedRun['scores'] = {}
  const categories = isRecord(lhr.categories) ? lhr.categories : {}
  for (const category of PAGESPEED_CATEGORIES) {
    const entry = categories[category]
    const score = isRecord(entry) ? finite(entry.score) : null
    if (score !== null) scores[category] = Math.round(score * 100)
  }
  const metrics: PagespeedRun['metrics'] = {}
  const audits = isRecord(lhr.audits) ? lhr.audits : {}
  for (const [metric, auditId] of Object.entries(METRIC_AUDITS) as [
    Exclude<PagespeedMetric, 'inp'>,
    string,
  ][]) {
    const audit = audits[auditId]
    const value = isRecord(audit) ? finite(audit.numericValue) : null
    if (value !== null && value >= 0) {
      metrics[metric] = metric === 'cls' ? Math.round(value * 1000) / 1000 : Math.round(value)
    }
  }
  const finalUrl =
    typeof lhr.finalDisplayedUrl === 'string'
      ? lhr.finalDisplayedUrl
      : typeof lhr.finalUrl === 'string'
        ? lhr.finalUrl
        : null
  return {
    scores,
    metrics,
    finalUrl,
    lighthouseVersion: typeof lhr.lighthouseVersion === 'string' ? lhr.lighthouseVersion : null,
  }
}

/** Interaction to Next Paint (p75, ms) from the field data of a PageSpeed Insights answer. */
export function fieldInp(body: unknown): number | null {
  if (!isRecord(body) || !isRecord(body.loadingExperience)) return null
  const metrics = body.loadingExperience.metrics
  if (!isRecord(metrics)) return null
  const inp = metrics.INTERACTION_TO_NEXT_PAINT
  return isRecord(inp) ? finite(inp.percentile) : null
}

/** The PageSpeed Insights web report of `url`, which runs the same analysis on pagespeed.web.dev. */
export function pagespeedReportUrl(url: string, strategy: PagespeedStrategy): string {
  const params = new URLSearchParams({ url, form_factor: strategy })
  return `https://pagespeed.web.dev/analysis?${params.toString()}`
}

/** One category below its threshold. `score` is `null` when Lighthouse could not score it. */
export interface PagespeedFailure {
  category: PagespeedCategory
  score: number | null
  min: number
}

/** Categories whose score is below the monitor's minimum (in `PAGESPEED_CATEGORIES` order). */
export function evaluatePagespeed(
  scores: PagespeedRun['scores'],
  thresholds: Partial<Record<PagespeedCategory, number | null>>,
  categories: readonly PagespeedCategory[] = PAGESPEED_CATEGORIES,
): PagespeedFailure[] {
  const failures: PagespeedFailure[] = []
  for (const category of PAGESPEED_CATEGORIES) {
    if (!categories.includes(category)) continue
    const min = thresholds[category]
    if (typeof min !== 'number' || !Number.isFinite(min)) continue
    const score = scores[category]
    if (typeof score !== 'number' || score < min) {
      failures.push({ category, score: typeof score === 'number' ? score : null, min })
    }
  }
  return failures
}

/** `performance 54 < 70, seo 81 < 90` (the heartbeat message, kept in English like the others). */
export function describeFailures(failures: readonly PagespeedFailure[]): string {
  return failures
    .map((failure) => `${failure.category} ${failure.score ?? 'not scored'} < ${failure.min}`)
    .join(', ')
}

/** `performance 92, accessibility 100, …` for a passing run. */
export function describeScores(scores: PagespeedRun['scores']): string {
  return PAGESPEED_CATEGORIES.flatMap((category) =>
    typeof scores[category] === 'number' ? [`${category} ${scores[category]}`] : [],
  ).join(', ')
}

/** The categories a monitor runs: its selection, or all four when it has none. */
export function monitorCategories(selection: unknown): PagespeedCategory[] {
  const list = Array.isArray(selection)
    ? PAGESPEED_CATEGORIES.filter((category) => selection.includes(category))
    : []
  return list.length > 0 ? list : [...PAGESPEED_CATEGORIES]
}

/** A stored `heartbeats.pagespeed` value, or `null` when it is missing or malformed. */
export function parsePagespeedRun(value: unknown): PagespeedRun | null {
  if (!isRecord(value) || !isRecord(value.scores) || !isRecord(value.metrics)) return null
  const scores: PagespeedRun['scores'] = {}
  for (const category of PAGESPEED_CATEGORIES) {
    const score = finite(value.scores[category])
    if (score !== null) scores[category] = score
  }
  const metrics: PagespeedRun['metrics'] = {}
  for (const metric of PAGESPEED_METRICS) {
    const number = finite(value.metrics[metric])
    if (number !== null) metrics[metric] = number
  }
  const text = (v: unknown) => (typeof v === 'string' && v ? v : null)
  return {
    backend: value.backend === 'lighthouse' ? 'lighthouse' : 'psi',
    strategy: value.strategy === 'desktop' ? 'desktop' : 'mobile',
    scores,
    metrics,
    finalUrl: text(value.finalUrl),
    lighthouseVersion: text(value.lighthouseVersion),
    reportUrl: text(value.reportUrl),
  }
}

/** Key of a rolled-up PageSpeed value (`extras.pagespeed.<key>` of the stat buckets). */
export type PagespeedSeriesKey = PagespeedCategory | PagespeedMetric

/** Flat `{ performance: 92, lcp: 1830, … }` of a run, as the stat buckets roll it up. */
export function pagespeedSeriesValues(
  run: unknown,
): Partial<Record<PagespeedSeriesKey, number>> | null {
  const parsed = parsePagespeedRun(run)
  if (!parsed) return null
  const values = { ...parsed.scores, ...parsed.metrics }
  return Object.keys(values).length > 0 ? values : null
}
