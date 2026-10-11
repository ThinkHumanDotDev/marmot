/**
 * Which data points one check produces (#99). Pure: the listener (`./listener.ts`) turns a
 * heartbeat event into a `CheckSample` and keeps the error counters.
 *
 * | Metric                        | Type    | Unit      | When                                     |
 * | ----------------------------- | ------- | --------- | ---------------------------------------- |
 * | `marmot.check.duration`       | gauge   | `ms`      | the check measured a response time       |
 * | `marmot.check.phase.duration` | gauge   | `ms`      | per timing phase (HTTP, TCP port)        |
 * | `marmot.check.status`         | gauge   | `1`       | every check: 1 succeeded, 0 failed       |
 * | `marmot.check.errors`         | counter | `{error}` | every check (cumulative failed checks)   |
 * | `marmot.check.packet_loss`    | gauge   | `1`       | ping monitors (ratio of lost requests)   |
 */
import { OTEL_METRICS } from '@/lib/otel'
import { TIMING_PHASES, type TimingPhase } from '@/lib/request-timing'
import { isHostMonitorType } from '@/lib/validation/monitor'
import { displayUrl } from '@/server/webhooks/url'

import type { AttributeValue, MetricPoint } from './encode'

export interface SampleMonitor {
  id: string | number
  name?: string | null
  type?: string | null
  url?: string | null
  hostname?: string | null
  port?: number | null
}

export interface CheckSample {
  monitor: SampleMonitor
  /** Unix time of the check, ms. */
  time: number
  /** Location that ran the check: `local` for the worker pool, else the probe location's slug. */
  location: string
  /** The check itself succeeded (UP or DEGRADED, a recovering success included). */
  ok: boolean
  /** Response time, ms. */
  ping: number | null
  timing?: Partial<Record<TimingPhase, number | null>> | null
  statusCode?: number | null
}

export interface ErrorSeries {
  /** Unix time (ms) the cumulative series started in this process. */
  startTime: number
  /** Failed checks so far, this one included. */
  value: number
}

/** The checked target without credentials or query string (`https://host/path`, `host:port`). */
export function monitorTarget(monitor: SampleMonitor): string | null {
  const host = monitor.hostname
    ? monitor.port
      ? `${monitor.hostname}:${monitor.port}`
      : monitor.hostname
    : null
  // A monitor keeps the URL of an earlier type: host-based types report their host.
  if (host && isHostMonitorType(monitor.type)) return host
  if (monitor.url) return displayUrl(monitor.url) ?? null
  return host
}

/** Data point attributes of a check (OpenTelemetry semantic conventions where one exists). */
export function sampleAttributes(sample: CheckSample): Record<string, AttributeValue> {
  const attributes: Record<string, AttributeValue> = {
    'marmot.monitor.id': String(sample.monitor.id),
    'marmot.monitor.name': sample.monitor.name ?? '',
    'marmot.monitor.type': sample.monitor.type ?? '',
    'marmot.location': sample.location,
  }
  const target = monitorTarget(sample.monitor)
  if (target) attributes['marmot.monitor.target'] = target
  if (typeof sample.statusCode === 'number' && Number.isFinite(sample.statusCode)) {
    attributes['http.response.status_code'] = Math.trunc(sample.statusCode)
  }
  return attributes
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

export function checkPoints(sample: CheckSample, errors: ErrorSeries): MetricPoint[] {
  const attributes = sampleAttributes(sample)
  const time = sample.time
  const points: MetricPoint[] = []

  if (finite(sample.ping)) {
    points.push({
      kind: 'gauge',
      name: OTEL_METRICS.duration,
      unit: 'ms',
      description: 'Response time of the check',
      attributes,
      time,
      value: sample.ping,
    })
  }
  for (const phase of TIMING_PHASES) {
    const value = sample.timing?.[phase]
    if (!finite(value)) continue
    points.push({
      kind: 'gauge',
      name: OTEL_METRICS.phaseDuration,
      unit: 'ms',
      description: 'Duration of one request timing phase of the check',
      attributes: { ...attributes, 'marmot.check.phase': phase },
      time,
      value,
    })
  }
  points.push({
    kind: 'gauge',
    name: OTEL_METRICS.status,
    unit: '1',
    description: 'Whether the check succeeded (1) or failed (0)',
    attributes,
    time,
    value: sample.ok ? 1 : 0,
  })
  // The counter carries no status code: a failed check without a response must count in the
  // same series as one answered with 500.
  const { 'http.response.status_code': _code, ...counterAttributes } = attributes
  points.push({
    kind: 'counter',
    name: OTEL_METRICS.errors,
    unit: '{error}',
    description: 'Failed checks',
    attributes: counterAttributes,
    startTime: errors.startTime,
    time,
    value: errors.value,
  })
  if (sample.monitor.type === 'ping') {
    // One echo request per check: the loss is 0 or 1 until multi-packet pings exist.
    points.push({
      kind: 'gauge',
      name: OTEL_METRICS.packetLoss,
      unit: '1',
      description: 'Share of echo requests without a reply',
      attributes: counterAttributes,
      time,
      value: sample.ok ? 0 : 1,
    })
  }
  return points
}
