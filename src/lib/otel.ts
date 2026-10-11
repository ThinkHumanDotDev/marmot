/**
 * Shapes and constants of the OpenTelemetry (OTLP) metrics export (#99), shared by the collection,
 * the route handlers, the settings UI and the monitor form. Free of server imports.
 */

/** Resource attribute `service.name` of every exported data point. */
export const OTEL_SERVICE_NAME = 'marmot-synthetic-check'

/** Instrumentation scope of the exported metrics. */
export const OTEL_SCOPE_NAME = 'marmot'

/** Metric names (OpenTelemetry naming: dotted, lower case, unit in `unit`). */
export const OTEL_METRICS = {
  /** Gauge, ms: the check's response time. */
  duration: 'marmot.check.duration',
  /** Gauge, ms: one request timing phase (`marmot.check.phase` attribute), HTTP and TCP checks. */
  phaseDuration: 'marmot.check.phase.duration',
  /** Gauge, 1 when the check succeeded (UP, DEGRADED), 0 when it failed. */
  status: 'marmot.check.status',
  /** Cumulative counter of failed checks. */
  errors: 'marmot.check.errors',
  /** Gauge, ratio 0–1: share of echo requests without a reply (ping monitors). */
  packetLoss: 'marmot.check.packet_loss',
} as const

export const OTEL_ENDPOINT_MAX_LENGTH = 2048
export const OTEL_NAME_MAX_LENGTH = 100
export const OTEL_MAX_HEADERS = 20
export const OTEL_HEADER_VALUE_MAX_LENGTH = 4096

/** RFC 9110 field-name token. */
export const OTEL_HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/

/** Headers the exporter sets itself (or that would break the request). */
export const OTEL_RESERVED_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'content-type',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
])

/** What the API and the settings UI receive for a collector (header values never leave the server). */
export interface OtelCollectorRow {
  id: string
  name: string
  endpoint: string
  /** Names of the configured headers; their values are write-only. */
  headerNames: string[]
  active: boolean
  /** The organization default: monitors without their own collector export here. */
  default: boolean
  lastExportAt: string | null
  /** Message of the last failed export, cleared by the next successful one. */
  lastError: string | null
  createdAt: string
}
