import { describe, expect, it } from 'vitest'

import {
  addSample,
  bucketIndex,
  bucketLowerBound,
  bucketUpperBound,
  estimatePercentile,
  estimatePercentiles,
  HISTOGRAM_SIZE,
  isPercentile,
  mergeHistograms,
  parseHistogram,
  PERCENTILE_VALUES,
  PERCENTILES,
  sampleCount,
  type LatencyHistogram,
} from './latency-histogram'

/** Deterministic PRNG (mulberry32) so the property tests are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Nearest-rank percentile of raw samples: the reference the histogram must match. */
function truePercentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)))
  return sorted[rank - 1]
}

const build = (samples: number[]): LatencyHistogram =>
  samples.reduce<LatencyHistogram>((h, ms) => addSample(h, ms), [])

/** The estimate must lie inside the histogram bucket that holds the true value. */
function expectWithinTrueBucket(estimate: number | null, actual: number) {
  expect(estimate).not.toBeNull()
  const index = bucketIndex(actual)
  expect(estimate!).toBeGreaterThanOrEqual(bucketLowerBound(index))
  expect(estimate!).toBeLessThanOrEqual(bucketUpperBound(index))
}

describe('latency histogram layout', () => {
  it('uses contiguous log-spaced buckets from 0 ms to an overflow bucket', () => {
    expect(bucketLowerBound(0)).toBe(0)
    expect(bucketUpperBound(0)).toBe(1)
    for (let i = 1; i < HISTOGRAM_SIZE - 1; i += 1) {
      expect(bucketLowerBound(i)).toBe(bucketUpperBound(i - 1))
      // Four buckets per doubling: each is 2^(1/4) ≈ 1.19 times wider than its lower bound.
      expect(bucketUpperBound(i) / bucketLowerBound(i)).toBeCloseTo(2 ** 0.25, 10)
    }
    expect(bucketUpperBound(HISTOGRAM_SIZE - 1)).toBe(Number.POSITIVE_INFINITY)
    expect(bucketLowerBound(HISTOGRAM_SIZE - 1)).toBe(2 ** 17)
  })

  it('places every value inside the bounds of its bucket, edges included', () => {
    const values = [0, 0.4, 0.999, 1, 1.5, 2, 3, 4, 100, 250, 1000, 29_999, 131_071, 131_072, 1e9]
    for (let i = 1; i < HISTOGRAM_SIZE; i += 1) values.push(bucketLowerBound(i))
    for (const ms of values) {
      const index = bucketIndex(ms)
      expect(ms).toBeGreaterThanOrEqual(bucketLowerBound(index))
      expect(ms).toBeLessThan(bucketUpperBound(index))
    }
    expect(bucketIndex(-5)).toBe(0)
    expect(bucketIndex(Number.NaN)).toBe(0)
  })

  it('adds samples without mutating the input and trims nothing it should keep', () => {
    const start: LatencyHistogram = [0, 1]
    const next = addSample(start, 0.5)
    expect(start).toEqual([0, 1])
    expect(next).toEqual([1, 1])
    expect(sampleCount(addSample(null, 100))).toBe(1)
  })

  it('merges by element-wise addition and parses stored arrays defensively', () => {
    expect(mergeHistograms([[1, 2], null, [0, 1, 3], undefined])).toEqual([1, 3, 3])
    expect(mergeHistograms([null, [0, 0]])).toBeNull()
    expect(parseHistogram([1, 0, 2, 0, 0])).toEqual([1, 0, 2])
    expect(parseHistogram(null)).toBeNull()
    expect(parseHistogram({ 0: 1 })).toBeNull()
    expect(parseHistogram([1, -1])).toBeNull()
    expect(parseHistogram(['1'])).toBeNull()
    expect(parseHistogram(new Array(HISTOGRAM_SIZE + 1).fill(1))).toBeNull()
  })

  it('recognises the five percentiles', () => {
    expect(PERCENTILES).toEqual(['p50', 'p75', 'p90', 'p95', 'p99'])
    expect(isPercentile('p95')).toBe(true)
    expect(isPercentile('p100')).toBe(false)
    expect(isPercentile(95)).toBe(false)
  })
})

describe('percentile estimates', () => {
  it('returns null for an empty histogram', () => {
    expect(estimatePercentile(null, 95)).toBeNull()
    expect(estimatePercentile([], 95)).toBeNull()
    expect(estimatePercentiles([0, 0])).toEqual({
      p50: null,
      p75: null,
      p90: null,
      p95: null,
      p99: null,
    })
  })

  it('returns the exact value for identical samples when min/max are known', () => {
    const histogram = build([120, 120, 120])
    expect(estimatePercentile(histogram, 50, { min: 120, max: 120 })).toBe(120)
    expect(estimatePercentile(histogram, 99, { min: 120, max: 120 })).toBe(120)
  })

  it('reports the overflow bucket by its lower bound or the known maximum', () => {
    const histogram = build([200_000])
    expect(estimatePercentile(histogram, 50)).toBe(2 ** 17)
    expect(estimatePercentile(histogram, 50, { min: 200_000, max: 200_000 })).toBe(200_000)
  })

  const distributions: Array<[string, (random: () => number) => number]> = [
    // Typical HTTP latency: log-normal around 120 ms.
    [
      'log-normal',
      (r) =>
        Math.exp(
          Math.log(120) +
            0.6 * Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r()),
        ),
    ],
    ['uniform 0–2000 ms', (r) => r() * 2000],
    ['bimodal (cache hits and misses)', (r) => (r() < 0.8 ? 5 + r() * 10 : 400 + r() * 600)],
    [
      'sub-millisecond and huge outliers',
      (r) => (r() < 0.5 ? r() : r() < 0.98 ? 50 + r() * 50 : 150_000 + r() * 1e5),
    ],
    ['integer pings', (r) => Math.round(20 + r() * 80)],
  ]

  it.each(distributions)(
    'stays within one histogram bucket of the true value (%s)',
    (_name, sample) => {
      for (let seed = 1; seed <= 20; seed += 1) {
        const random = rng(seed)
        const size = 1 + Math.floor(random() * 2000)
        const samples = Array.from({ length: size }, () => sample(random))
        const histogram = build(samples)
        const bounds = { min: Math.min(...samples), max: Math.max(...samples) }
        for (const key of PERCENTILES) {
          const p = PERCENTILE_VALUES[key]
          const actual = truePercentile(samples, p)
          expectWithinTrueBucket(estimatePercentile(histogram, p, bounds), actual)
          expectWithinTrueBucket(estimatePercentile(histogram, p), actual)
        }
      }
    },
  )

  it('gives the same answer for merged histograms as for one built from all samples', () => {
    const random = rng(42)
    const parts = Array.from({ length: 30 }, () =>
      Array.from({ length: Math.floor(random() * 50) }, () => 10 + random() * 990),
    )
    const all = parts.flat()
    const merged = mergeHistograms(parts.map((part) => (part.length ? build(part) : null)))
    expect(merged).toEqual(build(all))
    for (const key of PERCENTILES) {
      const actual = truePercentile(all, PERCENTILE_VALUES[key])
      expectWithinTrueBucket(estimatePercentile(merged, PERCENTILE_VALUES[key]), actual)
    }
  })
})
