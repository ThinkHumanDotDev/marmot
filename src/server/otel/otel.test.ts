import { describe, expect, it } from 'vitest'

import { OTEL_METRICS } from '@/lib/otel'

import { encodeMetricsRequest, unixNano, type MetricPoint } from './encode'
import { metricsUrl } from './endpoint'
import { headersProblem, mergeHeaders } from './headers'
import { checkPoints, monitorTarget, type CheckSample } from './metrics'

const sample = (overrides: Partial<CheckSample> = {}): CheckSample => ({
  monitor: {
    id: 7,
    name: 'API',
    type: 'http',
    url: 'https://user:pw@api.example.com/health?token=abc',
  },
  time: Date.UTC(2026, 9, 8, 12, 0, 0),
  location: 'local',
  ok: true,
  ping: 120,
  timing: { dns: 3, connect: 10, tls: 20.5, ttfb: 80, transfer: null },
  statusCode: 200,
  ...overrides,
})

describe('OTLP check metrics', () => {
  it('derives every documented metric from a successful HTTP check', () => {
    const points = checkPoints(sample(), { startTime: 1, value: 0 })
    const names = points.map((p) => p.name)
    expect(names.filter((n) => n === OTEL_METRICS.duration)).toHaveLength(1)
    expect(names.filter((n) => n === OTEL_METRICS.phaseDuration)).toHaveLength(4)
    expect(names).toContain(OTEL_METRICS.status)
    expect(names).toContain(OTEL_METRICS.errors)
    expect(names).not.toContain(OTEL_METRICS.packetLoss)

    const duration = points.find((p) => p.name === OTEL_METRICS.duration)!
    expect(duration.value).toBe(120)
    expect(duration.attributes).toEqual({
      'marmot.monitor.id': '7',
      'marmot.monitor.name': 'API',
      'marmot.monitor.type': 'http',
      'marmot.location': 'local',
      // Credentials and query strings never leave Marmot.
      'marmot.monitor.target': 'https://api.example.com/health',
      'http.response.status_code': 200,
    })
    const tls = points.find(
      (p) => p.name === OTEL_METRICS.phaseDuration && p.attributes['marmot.check.phase'] === 'tls',
    )
    expect(tls?.value).toBe(20.5)
    const errors = points.find((p) => p.name === OTEL_METRICS.errors)!
    expect(errors.kind).toBe('counter')
    expect(errors.attributes).not.toHaveProperty('http.response.status_code')
  })

  it('reports failures and packet loss for ping monitors', () => {
    const points = checkPoints(
      sample({
        monitor: { id: 'abc', name: 'Router', type: 'ping', hostname: '10.0.0.1' },
        ok: false,
        ping: null,
        timing: null,
        statusCode: null,
      }),
      { startTime: 1, value: 3 },
    )
    expect(points.find((p) => p.name === OTEL_METRICS.duration)).toBeUndefined()
    expect(points.find((p) => p.name === OTEL_METRICS.status)?.value).toBe(0)
    expect(points.find((p) => p.name === OTEL_METRICS.errors)?.value).toBe(3)
    expect(points.find((p) => p.name === OTEL_METRICS.packetLoss)?.value).toBe(1)
    expect(monitorTarget({ id: 1, hostname: 'db', port: 5432 })).toBe('db:5432')
  })
})

describe('OTLP JSON encoding', () => {
  it('groups points into gauges and cumulative sums with nanosecond strings', () => {
    const points = checkPoints(sample(), { startTime: 1_000, value: 2 })
    const request = encodeMetricsRequest(
      points,
      { 'service.name': 'marmot-synthetic-check' },
      { name: 'marmot', version: '1.0.0' },
    )
    const [resource] = request.resourceMetrics
    expect(resource.resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'marmot-synthetic-check' } },
    ])
    const metrics = resource.scopeMetrics[0].metrics
    const phase = metrics.find((m) => m.name === OTEL_METRICS.phaseDuration)!
    expect(phase.gauge?.dataPoints).toHaveLength(4)
    expect(phase.unit).toBe('ms')
    const errors = metrics.find((m) => m.name === OTEL_METRICS.errors)!
    expect(errors.sum).toMatchObject({ aggregationTemporality: 2, isMonotonic: true })
    expect(errors.sum?.dataPoints[0]).toMatchObject({
      startTimeUnixNano: '1000000000',
      timeUnixNano: unixNano(sample().time),
      asInt: '2',
    })
    const status = metrics.find((m) => m.name === OTEL_METRICS.status)!
    expect(status.gauge?.dataPoints[0].attributes).toContainEqual({
      key: 'http.response.status_code',
      value: { intValue: '200' },
    })
  })

  it('keeps one metric per name across several checks', () => {
    const points: MetricPoint[] = [
      ...checkPoints(sample(), { startTime: 1, value: 0 }),
      ...checkPoints(sample({ time: sample().time + 60_000 }), { startTime: 1, value: 0 }),
    ]
    const metrics = encodeMetricsRequest(points, {}, { name: 'marmot', version: '1' })
      .resourceMetrics[0].scopeMetrics[0].metrics
    expect(new Set(metrics.map((m) => m.name)).size).toBe(metrics.length)
    expect(metrics.find((m) => m.name === OTEL_METRICS.duration)?.gauge?.dataPoints).toHaveLength(2)
  })
})

describe('collector settings', () => {
  it('appends the signal path only to base URLs', () => {
    expect(metricsUrl('http://collector:4318')).toBe('http://collector:4318/v1/metrics')
    expect(metricsUrl('https://otlp.example.com/otlp/v1/metrics')).toBe(
      'https://otlp.example.com/otlp/v1/metrics',
    )
  })

  it('validates header names and values', () => {
    expect(headersProblem([{ name: 'Authorization', value: 'Basic x' }])).toBeNull()
    expect(headersProblem([{ name: 'bad name', value: 'x' }])?.key).toBe('otelHeaderNameInvalid')
    expect(headersProblem([{ name: 'Content-Type', value: 'x' }])?.key).toBe('otelHeaderReserved')
    expect(
      headersProblem([
        { name: 'X-Key', value: 'a' },
        { name: 'x-key', value: 'b' },
      ])?.key,
    ).toBe('otelHeaderDuplicate')
    expect(headersProblem([{ name: 'X-Key', value: 'a\r\nInjected: 1' }])?.key).toBe(
      'otelHeaderValueInvalid',
    )
  })

  it('keeps stored values for entries without one and drops removed headers', () => {
    const stored = { Authorization: 'Bearer old', 'X-Scope': 'tenant-a' }
    expect(
      mergeHeaders(
        [
          { name: 'authorization', value: null },
          { name: 'X-New', value: 'n' },
          { name: 'X-Unknown', value: null },
        ],
        stored,
      ),
    ).toEqual({ authorization: 'Bearer old', 'X-New': 'n' })
  })
})
