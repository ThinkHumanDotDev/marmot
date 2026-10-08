/**
 * OTLP/HTTP JSON encoding of Marmot's check metrics (#99): the JSON mapping of
 * `ExportMetricsServiceRequest` (opentelemetry-proto `metrics/v1`, stable since OTLP 1.0), which
 * every OTLP/HTTP receiver accepts with `Content-Type: application/json`. Pure functions, no I/O.
 *
 * Every check becomes its own data points stamped with the check time (gauges), so a backend sees
 * one sample per check rather than an aggregate over an export interval. The error counter is a
 * cumulative sum kept per series by the exporter's process (`service.instance.id` tells the
 * processes apart).
 */

export type AttributeValue = string | number | boolean

/** One data point, before it is grouped into metrics. */
export type MetricPoint =
  | {
      kind: 'gauge'
      name: string
      unit: string
      description: string
      attributes: Record<string, AttributeValue>
      /** Unix time of the observation, ms. */
      time: number
      value: number
    }
  | {
      kind: 'counter'
      name: string
      unit: string
      description: string
      attributes: Record<string, AttributeValue>
      /** Start of the cumulative series (ms) and the time of this value. */
      startTime: number
      time: number
      value: number
    }

interface OtlpAnyValue {
  stringValue?: string
  boolValue?: boolean
  intValue?: string
  doubleValue?: number
}

interface OtlpKeyValue {
  key: string
  value: OtlpAnyValue
}

export interface OtlpNumberDataPoint {
  attributes: OtlpKeyValue[]
  startTimeUnixNano?: string
  timeUnixNano: string
  asDouble?: number
  asInt?: string
}

export interface OtlpMetric {
  name: string
  unit: string
  description: string
  gauge?: { dataPoints: OtlpNumberDataPoint[] }
  sum?: {
    dataPoints: OtlpNumberDataPoint[]
    /** 2 = AGGREGATION_TEMPORALITY_CUMULATIVE */
    aggregationTemporality: 2
    isMonotonic: true
  }
}

export interface OtlpMetricsRequest {
  resourceMetrics: {
    resource: { attributes: OtlpKeyValue[] }
    scopeMetrics: { scope: { name: string; version: string }; metrics: OtlpMetric[] }[]
  }[]
}

/** Milliseconds → the decimal string of nanoseconds (int64 fields are strings in OTLP JSON). */
export const unixNano = (ms: number): string => (BigInt(Math.round(ms)) * 1_000_000n).toString()

function anyValue(value: AttributeValue): OtlpAnyValue {
  if (typeof value === 'boolean') return { boolValue: value }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  }
  return { stringValue: value }
}

export const keyValues = (attributes: Record<string, AttributeValue>): OtlpKeyValue[] =>
  Object.entries(attributes).map(([key, value]) => ({ key, value: anyValue(value) }))

/** Groups points by metric name (keeping their order) into one OTLP request. */
export function encodeMetricsRequest(
  points: readonly MetricPoint[],
  resource: Record<string, AttributeValue>,
  scope: { name: string; version: string },
): OtlpMetricsRequest {
  const metrics = new Map<string, OtlpMetric>()
  for (const point of points) {
    let metric = metrics.get(point.name)
    if (!metric) {
      metric = { name: point.name, unit: point.unit, description: point.description }
      if (point.kind === 'gauge') metric.gauge = { dataPoints: [] }
      else metric.sum = { dataPoints: [], aggregationTemporality: 2, isMonotonic: true }
      metrics.set(point.name, metric)
    }
    const attributes = keyValues(point.attributes)
    if (point.kind === 'gauge') {
      metric.gauge?.dataPoints.push({
        attributes,
        timeUnixNano: unixNano(point.time),
        asDouble: point.value,
      })
    } else {
      metric.sum?.dataPoints.push({
        attributes,
        startTimeUnixNano: unixNano(point.startTime),
        timeUnixNano: unixNano(point.time),
        asInt: String(Math.round(point.value)),
      })
    }
  }
  return {
    resourceMetrics: [
      {
        resource: { attributes: keyValues(resource) },
        scopeMetrics: [{ scope, metrics: [...metrics.values()] }],
      },
    ],
  }
}
