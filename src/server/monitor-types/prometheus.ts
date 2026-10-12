/**
 * Prometheus query monitor (#140): runs a PromQL instant query against the HTTP API of Prometheus,
 * Thanos, Mimir or VictoriaMetrics (`GET <url>/api/v1/query`) and judges the result with the
 * monitor's DOWN and degraded conditions (`src/lib/prometheus.ts`). The value the verdict is about
 * is stored on the heartbeat (`heartbeats.value`) and charted on the detail page.
 *
 * The request reuses the HTTP monitors' plumbing (`buildHttpRequest`): basic or bearer
 * authentication, custom headers, the monitor's proxy, `ignoreTls`, the outbound address guard and
 * the request timing. An empty result takes `prometheusNoDataStatus`, a failed query (HTTP error,
 * Prometheus `status: "error"`, unreachable endpoint) `prometheusErrorStatus`: `up`, `down`, or
 * `pending`, which holds the monitor's state like a deferred check (no retry used, no
 * notification). A target refused by the outbound guard is always DOWN.
 */
import { STATUS_CODES } from 'node:http'

import { request } from 'undici'

import {
  evaluateSeries,
  formatLabels,
  formatValue,
  parsePrometheusResponse,
  prometheusQueryUrl,
  type PrometheusCondition,
  type PrometheusFallbackStatus,
  type PrometheusSeries,
} from '@/lib/prometheus'
import { findBlockedMessage } from '@/server/security/outbound-guard'

import { buildHttpRequest, loadMonitorProxy, recordTlsInfo } from './http-request'
import { registerMonitorType } from './registry'
import { captureResponse, requestSecrets } from './response-capture'
import { CheckDeferredError, type MonitorCheckContext } from './types'
import { errorMessage, responseExcerpt } from './util'

/** A condition from the monitor's operator and threshold fields, or `null` when incomplete. */
export function prometheusCondition(
  operator: string | null | undefined,
  threshold: number | null | undefined,
): PrometheusCondition | null {
  if (!operator || typeof threshold !== 'number' || !Number.isFinite(threshold)) return null
  return { operator: operator as PrometheusCondition['operator'], threshold }
}

/** Run the instant query and return its series; throws on any failure. */
async function runQuery(ctx: MonitorCheckContext, query: string): Promise<PrometheusSeries[]> {
  const url = prometheusQueryUrl(ctx.monitor.url ?? '', query)
  const proxy = await loadMonitorProxy(ctx.payload, ctx.monitor)
  const built = await buildHttpRequest(
    { ...ctx.monitor, url, method: 'GET', body: null },
    ctx.signal,
    { proxy },
  )
  const headers = built.options?.headers as Record<string, string>
  // Custom headers may still override it (`buildHttpRequest` lower-cases their names).
  if (!ctx.monitor.headers?.toLowerCase().includes('"accept"')) headers.accept = 'application/json'
  const startedAt = Date.now()
  let statusCode: number
  let body: string
  let responseHeaders: Record<string, string | string[] | undefined>
  try {
    let res: Awaited<ReturnType<typeof request>>
    try {
      res = await request(built.url, built.options)
    } catch (err) {
      await recordTlsInfo(ctx, built.url, built.capture, err)
      throw err
    }
    body = await res.body.text()
    statusCode = res.statusCode
    responseHeaders = res.headers
    ctx.heartbeat.ping = Date.now() - startedAt
    ctx.timing = built.timing.result()
    await recordTlsInfo(ctx, built.url, built.capture)
  } finally {
    await built.cleanup()
  }
  ctx.heartbeat.statusCode = statusCode
  ctx.response = captureResponse(
    {
      statusCode,
      headers: responseHeaders,
      body,
    },
    requestSecrets(headers, ctx.monitor),
  )
  if (statusCode < 200 || statusCode >= 300) {
    // Prometheus answers 400 / 422 / 503 with a JSON error that says what went wrong.
    try {
      parsePrometheusResponse(body)
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Query failed')) {
        throw new Error(`HTTP ${statusCode}: ${err.message}`)
      }
    }
    throw new Error(
      `HTTP ${statusCode} ${STATUS_CODES[statusCode] ?? ''}`.trim() + responseTail(body),
    )
  }
  return parsePrometheusResponse(body)
}

const responseTail = (body: string): string => {
  const excerpt = responseExcerpt(body.trim())
  return excerpt ? `: ${excerpt}` : ''
}

/** Apply `prometheusNoDataStatus` / `prometheusErrorStatus`. */
function fallback(
  ctx: MonitorCheckContext,
  status: PrometheusFallbackStatus,
  reason: string,
): void {
  if (status === 'up') {
    ctx.heartbeat.status = 'up'
    ctx.heartbeat.msg = `${reason} (counted as UP)`
    return
  }
  if (status === 'pending') throw new CheckDeferredError(`${reason} (status kept)`)
  throw new Error(reason)
}

const describeCondition = (condition: PrometheusCondition) =>
  `${condition.operator} ${formatValue(condition.threshold)}`

registerMonitorType({
  name: 'prometheus',
  label: 'Prometheus Query',
  group: 'general',
  allowCustomStatus: true,
  async check(ctx) {
    const { monitor } = ctx
    const query = (monitor.prometheusQuery ?? '').trim()
    if (!monitor.url) throw new Error('URL is required')
    if (!query) throw new Error('A PromQL query is required')
    const down = prometheusCondition(
      monitor.prometheusDownOperator,
      monitor.prometheusDownThreshold,
    )
    if (!down) throw new Error('A DOWN condition (operator and threshold) is required')
    const degraded = prometheusCondition(
      monitor.prometheusDegradedOperator,
      monitor.prometheusDegradedThreshold,
    )

    let series: PrometheusSeries[]
    try {
      series = await runQuery(ctx, query)
    } catch (err) {
      // The guard's verdict and the monitor timeout are never overridden.
      if (findBlockedMessage(err) || ctx.signal.aborted) throw err
      fallback(ctx, monitor.prometheusErrorStatus ?? 'down', errorMessage(err))
      return
    }

    const verdict = evaluateSeries(series, {
      down,
      degraded,
      aggregate: monitor.prometheusAggregate ?? 'worst',
    })
    if (!verdict) {
      fallback(ctx, monitor.prometheusNoDataStatus ?? 'down', 'The query returned no data')
      return
    }

    ctx.value = Number.isFinite(verdict.value) ? verdict.value : null
    const subject =
      verdict.seriesCount > 1 || Object.keys(verdict.labels).length > 0
        ? `${formatLabels(verdict.labels)} = `
        : 'Value '
    const others = verdict.seriesCount > 1 ? ` (${verdict.seriesCount} series)` : ''
    const value = `${subject}${formatValue(verdict.value)}${others}`
    if (verdict.status === 'down') {
      throw new Error(`${value} meets the DOWN condition ${describeCondition(down)}`)
    }
    ctx.heartbeat.status = verdict.status
    ctx.heartbeat.msg =
      verdict.status === 'degraded' && degraded
        ? `${value} meets the degraded condition ${describeCondition(degraded)}`
        : value
  },
})
