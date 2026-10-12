/**
 * Prometheus query monitor (#140): the settings and the verdict of an instant query, shared by the
 * monitor type (`src/server/monitor-types/prometheus.ts`), the collection, the form schema and the
 * tests. Pure, no server imports.
 */

export const PROMETHEUS_OPERATORS = ['>', '>=', '<', '<=', '==', '!='] as const
export type PrometheusOperator = (typeof PROMETHEUS_OPERATORS)[number]

/**
 * How several series combine (`prometheusAggregate`). Every series is judged on its own first.
 * - `worst` (default): the worst status any series reaches; the heartbeat reports the most
 *   extreme value among those series (the largest for a `>`/`>=` DOWN condition, the smallest for
 *   `<`/`<=`), so the stored value is the worst one;
 * - `any`: the same verdict, reporting the first series (in result order) that reached it;
 * - `all`: a status applies only when every series reaches it (DOWN when all are down), so one
 *   healthy series keeps the monitor UP; the heartbeat reports the best series.
 */
export const PROMETHEUS_AGGREGATES = ['worst', 'any', 'all'] as const
export type PrometheusAggregate = (typeof PROMETHEUS_AGGREGATES)[number]

/** Status of an empty result (`prometheusNoDataStatus`) or a failed query (`prometheusErrorStatus`). */
export const PROMETHEUS_FALLBACK_STATUSES = ['up', 'down', 'pending'] as const
export type PrometheusFallbackStatus = (typeof PROMETHEUS_FALLBACK_STATUSES)[number]

export const PROMETHEUS_QUERY_MAX_LENGTH = 10_000

export interface PrometheusCondition {
  operator: PrometheusOperator
  threshold: number
}

export type PrometheusSeriesStatus = 'up' | 'degraded' | 'down'

export interface PrometheusSeries {
  /** Label set (`__name__` included when Prometheus returns it). */
  labels: Record<string, string>
  value: number
}

export interface PrometheusVerdict {
  status: PrometheusSeriesStatus
  /** The value the verdict is about (stored on the heartbeat). */
  value: number
  /** The series that value came from. */
  labels: Record<string, string>
  /** Number of series in the result. */
  seriesCount: number
}

const RANK: Record<PrometheusSeriesStatus, number> = { up: 0, degraded: 1, down: 2 }

export function compare(value: number, condition: PrometheusCondition): boolean {
  const { operator, threshold } = condition
  if (Number.isNaN(value)) return false
  switch (operator) {
    case '>':
      return value > threshold
    case '>=':
      return value >= threshold
    case '<':
      return value < threshold
    case '<=':
      return value <= threshold
    case '==':
      return value === threshold
    case '!=':
      return value !== threshold
  }
}

export function seriesStatus(
  value: number,
  down: PrometheusCondition,
  degraded: PrometheusCondition | null,
): PrometheusSeriesStatus {
  if (compare(value, down)) return 'down'
  if (degraded && compare(value, degraded)) return 'degraded'
  return 'up'
}

/** Direction in which a value gets worse under `down`, or null for `==` / `!=`. */
const worseDirection = (down: PrometheusCondition): 1 | -1 | null =>
  down.operator === '>' || down.operator === '>='
    ? 1
    : down.operator === '<' || down.operator === '<='
      ? -1
      : null

/**
 * The monitor's verdict over every series of a result, or `null` for an empty result. NaN values
 * (Prometheus' `NaN` of an empty division) never match a condition: such a series is UP.
 */
export function evaluateSeries(
  series: readonly PrometheusSeries[],
  settings: {
    down: PrometheusCondition
    degraded?: PrometheusCondition | null
    aggregate?: PrometheusAggregate | null
  },
): PrometheusVerdict | null {
  if (series.length === 0) return null
  const degraded = settings.degraded ?? null
  const judged = series.map((s) => ({
    ...s,
    status: seriesStatus(s.value, settings.down, degraded),
  }))
  const aggregate = settings.aggregate ?? 'worst'
  const verdict = (pick: (typeof judged)[number]): PrometheusVerdict => ({
    status: pick.status,
    value: pick.value,
    labels: pick.labels,
    seriesCount: series.length,
  })

  if (aggregate === 'all') {
    // A status needs every series: the best series decides.
    return verdict(judged.reduce((a, b) => (RANK[b.status] < RANK[a.status] ? b : a)))
  }
  const rank = Math.max(...judged.map((s) => RANK[s.status]))
  const atWorst = judged.filter((s) => RANK[s.status] === rank)
  if (aggregate === 'any') return verdict(atWorst[0])
  // `worst`: among the series with the worst status, the most extreme value.
  const direction = worseDirection(settings.down)
  const comparable = atWorst.filter((s) => !Number.isNaN(s.value))
  if (direction === null || comparable.length === 0) return verdict(atWorst[0])
  return verdict(comparable.reduce((a, b) => (b.value * direction > a.value * direction ? b : a)))
}

/** `{job="api", instance="a:9090"}` for messages (empty label sets read `{}`). */
export function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels).filter(([key]) => key !== '__name__')
  const name = labels.__name__ ?? ''
  return `${name}{${entries.map(([k, v]) => `${k}="${v}"`).join(', ')}}`
}

/** A number as Prometheus prints sample values (`NaN`, `+Inf`, plain decimals otherwise). */
export function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN'
  if (value === Infinity) return '+Inf'
  if (value === -Infinity) return '-Inf'
  return String(Number(value.toPrecision(6)))
}

/** A sample value as the HTTP API encodes it (`"0.05"`, `"NaN"`, `"+Inf"`). */
export function parseSampleValue(raw: unknown): number {
  if (typeof raw === 'number') return raw
  if (typeof raw !== 'string') throw new Error(`Unexpected sample value ${JSON.stringify(raw)}`)
  if (raw === 'NaN') return NaN
  if (raw === '+Inf' || raw === 'Inf') return Infinity
  if (raw === '-Inf') return -Infinity
  const value = Number(raw)
  if (raw.trim() === '' || Number.isNaN(value)) {
    throw new Error(`Unexpected sample value ${JSON.stringify(raw)}`)
  }
  return value
}

const sampleOf = (pair: unknown): number => {
  if (!Array.isArray(pair) || pair.length < 2) throw new Error('Unexpected sample in the result')
  return parseSampleValue(pair[1])
}

const labelsOf = (metric: unknown): Record<string, string> => {
  if (!metric || typeof metric !== 'object' || Array.isArray(metric)) return {}
  return Object.fromEntries(
    Object.entries(metric as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
  )
}

/**
 * The series of a `GET /api/v1/query` answer (Prometheus, Thanos, Mimir, VictoriaMetrics).
 * A vector gives one series per element, a scalar one series without labels, a matrix (a range
 * selector) the latest sample of each series. Throws on `status: "error"` and on answers that are
 * not the query API's.
 */
export function parsePrometheusResponse(body: string): PrometheusSeries[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error('The answer is not JSON: is the URL the base URL of the Prometheus API?')
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Unexpected answer from the query API')
  const doc = parsed as {
    status?: unknown
    error?: unknown
    errorType?: unknown
    data?: { resultType?: unknown; result?: unknown } | null
  }
  if (doc.status === 'error') {
    const type = typeof doc.errorType === 'string' ? `${doc.errorType}: ` : ''
    throw new Error(`Query failed: ${type}${String(doc.error ?? 'unknown error')}`)
  }
  if (doc.status !== 'success' || !doc.data || typeof doc.data !== 'object') {
    throw new Error('Unexpected answer from the query API')
  }
  const { resultType, result } = doc.data
  switch (resultType) {
    case 'scalar':
      return [{ labels: {}, value: sampleOf(result) }]
    case 'vector':
      if (!Array.isArray(result)) throw new Error('Unexpected vector result')
      return result.map((item: { metric?: unknown; value?: unknown }) => ({
        labels: labelsOf(item?.metric),
        value: sampleOf(item?.value),
      }))
    case 'matrix':
      if (!Array.isArray(result)) throw new Error('Unexpected matrix result')
      return result.flatMap((item: { metric?: unknown; values?: unknown }) => {
        const values = Array.isArray(item?.values) ? item.values : []
        if (values.length === 0) return []
        return [{ labels: labelsOf(item?.metric), value: sampleOf(values[values.length - 1]) }]
      })
    case 'string':
      throw new Error('The query returns a string; a numeric result is required')
    default:
      throw new Error('Unexpected answer from the query API')
  }
}

/** `https://prom:9090/prefix` + query → `https://prom:9090/prefix/api/v1/query?query=…`. */
export function prometheusQueryUrl(endpoint: string, query: string): string {
  const url = new URL(endpoint.trim())
  const base = url.pathname.replace(/\/+$/, '')
  url.pathname = base.endsWith('/api/v1/query') ? base : `${base}/api/v1/query`
  url.searchParams.set('query', query)
  return url.toString()
}
