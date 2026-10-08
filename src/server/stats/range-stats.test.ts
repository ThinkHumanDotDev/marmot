import { describe, expect, it } from 'vitest'

import { estimatePercentile, mergeHistograms } from './latency-histogram'
import { bucketPercentiles, buildSeries, CHART_STEP_SECONDS, countChecks } from './range-stats'
import { applyBeat, emptyBucket, type Bucket, type HeartbeatStatus } from './uptime-calculator'

const bucketAt = (timestamp: number, beats: Array<[HeartbeatStatus, number | null]>): Bucket => ({
  ...beats.reduce((b, [status, ping]) => applyBeat(b, status, ping), emptyBucket()),
  timestamp,
})

describe('range stats', () => {
  const a = bucketAt(0, [
    ['up', 100],
    ['degraded', 900],
    ['down', null],
  ])
  const b = bucketAt(60, [
    ['up', 200],
    ['maintenance', null],
    ['pending', null],
  ])
  const c = bucketAt(600, [['up', 50]])

  it('counts total, failed, degraded and maintenance checks', () => {
    expect(countChecks([a, b, c])).toEqual({
      total: 7,
      up: 5,
      failed: 2,
      degraded: 1,
      maintenance: 1,
    })
  })

  it('derives percentiles by merging the bucket histograms', () => {
    const merged = mergeHistograms([a, b, c].map((x) => x.latencyHistogram))
    const result = bucketPercentiles([a, b, c], ['p50', 'p99'])
    expect(result.p50).toBe(estimatePercentile(merged, 50, { min: 50, max: 900 }))
    expect(result.p99).toBeLessThanOrEqual(900)
    expect(Object.keys(result)).toEqual(['p50', 'p99'])
    // Rows written before the histogram existed have none: no percentile rather than a wrong one.
    expect(bucketPercentiles([{ ...a, latencyHistogram: null }]).p95).toBeNull()
  })

  it('folds buckets into fixed intervals that cover the whole window', () => {
    const series = buildSeries([a, b, c], { from: 0, to: 900 }, 300, ['p95'])
    expect(series.map((p) => p.timestamp)).toEqual([0, 300, 600, 900])
    expect(series[0]).toMatchObject({ up: 4, down: 2, degraded: 1, maintenance: 1 })
    expect(series[0].ping).toBeCloseTo((100 + 900 + 200) / 3)
    expect(series[0].pingMin).toBe(100)
    expect(series[0].pingMax).toBe(900)
    expect(series[1]).toMatchObject({ up: 0, down: 0, ping: null, p95: null })
    expect(series[2].p95).toBe(50)
    expect(series[2]).not.toHaveProperty('p50')
  })

  it('keeps the interval count fixed when the window does not start on a step boundary', () => {
    const shifted = buildSeries([b], { from: 361, to: 1499 }, 300, [])
    expect(shifted).toHaveLength(4)
    // A bucket before the first interval's start folds into it rather than adding a point.
    expect(shifted[0]).toMatchObject({ timestamp: 300, up: 2, down: 1 })
  })

  it('uses intervals that divide the window into a few hundred points at most', () => {
    expect(CHART_STEP_SECONDS['1d']).toBe(300)
    expect((90 * 86400) / CHART_STEP_SECONDS['90d']).toBe(90)
    expect((30 * 86400) / CHART_STEP_SECONDS['30d']).toBe(180)
  })
})
