import { describe, expect, it } from 'vitest'

import {
  evaluateSeries,
  formatLabels,
  parsePrometheusResponse,
  prometheusQueryUrl,
  type PrometheusSeries,
} from './prometheus'

const down = { operator: '>', threshold: 0.05 } as const
const degraded = { operator: '>', threshold: 0.01 } as const
const series = (...values: number[]): PrometheusSeries[] =>
  values.map((value, i) => ({ labels: { i: String(i) }, value }))

describe('evaluateSeries', () => {
  it('judges one value against the DOWN and degraded conditions', () => {
    expect(evaluateSeries(series(0.002), { down, degraded })?.status).toBe('up')
    expect(evaluateSeries(series(0.03), { down, degraded })?.status).toBe('degraded')
    expect(evaluateSeries(series(0.06), { down, degraded })?.status).toBe('down')
    expect(evaluateSeries(series(0.05), { down, degraded })?.status).toBe('degraded')
    expect(evaluateSeries([], { down })).toBeNull()
  })

  it('never matches NaN', () => {
    expect(evaluateSeries(series(NaN), { down })?.status).toBe('up')
    expect(evaluateSeries(series(NaN), { down: { operator: '!=', threshold: 1 } })?.status).toBe(
      'up',
    )
  })

  it('aggregates several series', () => {
    const values = series(0.02, 0.09, 0.07)
    const worst = evaluateSeries(values, { down, degraded, aggregate: 'worst' })
    expect(worst).toMatchObject({ status: 'down', value: 0.09, seriesCount: 3 })
    expect(evaluateSeries(values, { down, degraded, aggregate: 'any' })).toMatchObject({
      status: 'down',
      value: 0.09,
    })
    expect(evaluateSeries(values, { down, degraded, aggregate: 'all' })).toMatchObject({
      status: 'degraded',
      value: 0.02,
    })
    // `<` conditions get worse downwards.
    const low = { operator: '<', threshold: 2 } as const
    expect(evaluateSeries(series(1, 0, 3), { down: low })).toMatchObject({ value: 0 })
  })
})

describe('parsePrometheusResponse', () => {
  it('reads vectors, scalars and matrices', () => {
    expect(
      parsePrometheusResponse(
        JSON.stringify({
          status: 'success',
          data: {
            resultType: 'vector',
            result: [{ metric: { job: 'api' }, value: [1, '0.5'] }],
          },
        }),
      ),
    ).toEqual([{ labels: { job: 'api' }, value: 0.5 }])
    expect(
      parsePrometheusResponse(
        JSON.stringify({ status: 'success', data: { resultType: 'scalar', result: [1, '+Inf'] } }),
      ),
    ).toEqual([{ labels: {}, value: Infinity }])
    expect(
      parsePrometheusResponse(
        JSON.stringify({
          status: 'success',
          data: {
            resultType: 'matrix',
            result: [
              {
                metric: {},
                values: [
                  [1, '1'],
                  [2, '2'],
                ],
              },
            ],
          },
        }),
      ),
    ).toEqual([{ labels: {}, value: 2 }])
  })

  it('throws on errors and foreign answers', () => {
    expect(() =>
      parsePrometheusResponse(
        JSON.stringify({ status: 'error', errorType: 'bad_data', error: 'parse error' }),
      ),
    ).toThrow('Query failed: bad_data: parse error')
    expect(() => parsePrometheusResponse('<html>')).toThrow(/not JSON/)
    expect(() =>
      parsePrometheusResponse(
        JSON.stringify({ status: 'success', data: { resultType: 'string', result: [1, 'x'] } }),
      ),
    ).toThrow(/string/)
  })
})

describe('helpers', () => {
  it('builds the query URL under a base path', () => {
    expect(prometheusQueryUrl('https://prom:9090', 'up')).toBe(
      'https://prom:9090/api/v1/query?query=up',
    )
    expect(prometheusQueryUrl('https://mimir/prometheus/', 'a{b="c"}')).toBe(
      'https://mimir/prometheus/api/v1/query?query=a%7Bb%3D%22c%22%7D',
    )
    expect(prometheusQueryUrl('https://prom/api/v1/query', 'up')).toBe(
      'https://prom/api/v1/query?query=up',
    )
  })

  it('formats label sets', () => {
    expect(formatLabels({ __name__: 'up', job: 'api' })).toBe('up{job="api"}')
  })
})
