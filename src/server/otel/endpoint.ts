/**
 * Save-time checks of an OTLP/HTTP collector URL (#99). Exports go through `guardedFetch`, which
 * re-checks every resolved address at connect time; this only gives early feedback for URLs that
 * can never work (wrong scheme, literal private addresses while the outbound guard is on).
 */
import { OTEL_ENDPOINT_MAX_LENGTH } from '@/lib/otel'
import type { ErrorKey, ErrorValues } from '@/server/errors'
import { literalTargetDenial } from '@/server/security/outbound-guard'

export function otelEndpointProblem(
  value: unknown,
): { key: ErrorKey; values?: ErrorValues } | null {
  if (typeof value !== 'string' || !value.trim() || value.length > OTEL_ENDPOINT_MAX_LENGTH) {
    return { key: 'otelEndpointInvalid' }
  }
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return { key: 'otelEndpointInvalid' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { key: 'otelEndpointInvalid' }
  if (url.username || url.password) return { key: 'otelEndpointCredentials' }
  const denial = literalTargetDenial(url.hostname)
  if (denial) return { key: 'otelEndpointBlocked', values: { reason: denial } }
  return null
}

/**
 * The URL metrics are POSTed to. Like `OTEL_EXPORTER_OTLP_ENDPOINT`, a base URL without a path
 * (`https://collector:4318`) gets the signal path `/v1/metrics`; any other path is used as-is
 * (`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` semantics, e.g. Grafana Cloud's `/otlp/v1/metrics`).
 */
export function metricsUrl(endpoint: string): string {
  const url = new URL(endpoint.trim())
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/v1/metrics'
  return url.toString()
}
