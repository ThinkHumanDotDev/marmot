/**
 * Latency histogram (#95): a compact, mergeable sketch of the response times recorded in a stat
 * bucket, from which percentiles (p50 … p99) are derived at query time.
 *
 * Layout (version 1, stored as a plain number array in `stat-*.latencyHistogram`):
 * - index 0 counts pings in `[0, 1)` ms;
 * - index `i` in `1 … SIZE - 2` counts pings in `[2^((i-1)/4), 2^(i/4))` ms, i.e. four log-spaced
 *   buckets per doubling (each about 19 % wide) from 1 ms up to 2^17 ms ≈ 131 s;
 * - the last index counts everything from 2^17 ms up (overflow).
 *
 * Trailing zero counts are trimmed before storing, so a typical row holds a dozen small integers.
 * Histograms merge by element-wise addition, which is exact, so percentiles of a merged range are
 * as accurate as those of a single bucket: the estimate always lies inside the histogram bucket
 * that contains the true value (nearest-rank definition).
 *
 * The array is a JSON value, so it is stored the same way on Postgres (jsonb) and MongoDB.
 * Changing the layout requires a new field (or a conversion), never a silent reinterpretation.
 */

/** Log-spaced buckets per doubling of the latency. */
export const HISTOGRAM_STEPS_PER_OCTAVE = 4
/** Doublings covered above 1 ms (2^17 ms ≈ 131 s). */
export const HISTOGRAM_OCTAVES = 17
/** Number of histogram buckets: `[0, 1)`, the log-spaced ones, and the overflow bucket. */
export const HISTOGRAM_SIZE = 1 + HISTOGRAM_STEPS_PER_OCTAVE * HISTOGRAM_OCTAVES + 1

const OVERFLOW_INDEX = HISTOGRAM_SIZE - 1

export type LatencyHistogram = number[]

export type Percentile = 'p50' | 'p75' | 'p90' | 'p95' | 'p99'

export const PERCENTILES: readonly Percentile[] = ['p50', 'p75', 'p90', 'p95', 'p99']

export const PERCENTILE_VALUES: Record<Percentile, number> = {
  p50: 50,
  p75: 75,
  p90: 90,
  p95: 95,
  p99: 99,
}

export const isPercentile = (value: unknown): value is Percentile =>
  typeof value === 'string' && (PERCENTILES as readonly string[]).includes(value)

export type PercentileValues = Record<Percentile, number | null>

/** Inclusive lower bound (ms) of histogram bucket `index`. */
export function bucketLowerBound(index: number): number {
  if (index <= 0) return 0
  return 2 ** ((Math.min(index, OVERFLOW_INDEX) - 1) / HISTOGRAM_STEPS_PER_OCTAVE)
}

/** Exclusive upper bound (ms) of histogram bucket `index`; `Infinity` for the overflow bucket. */
export function bucketUpperBound(index: number): number {
  if (index >= OVERFLOW_INDEX) return Number.POSITIVE_INFINITY
  return bucketLowerBound(index + 1)
}

/** Histogram bucket of a ping in ms (negative and non-finite values land in bucket 0). */
export function bucketIndex(ms: number): number {
  if (!Number.isFinite(ms) || ms < 1) return 0
  let index = Math.min(OVERFLOW_INDEX, 1 + Math.floor(Math.log2(ms) * HISTOGRAM_STEPS_PER_OCTAVE))
  // `log2` is not exact at the bucket edges; settle on the bucket whose bounds hold `ms`.
  while (index > 1 && ms < bucketLowerBound(index)) index -= 1
  while (index < OVERFLOW_INDEX && ms >= bucketLowerBound(index + 1)) index += 1
  return index
}

const trim = (counts: number[]): LatencyHistogram => {
  let end = counts.length
  while (end > 0 && counts[end - 1] === 0) end -= 1
  return counts.slice(0, end)
}

/**
 * Read a stored histogram. Anything that is not an array of non-negative finite numbers (legacy
 * rows, hand-edited data) is treated as "no histogram".
 */
export function parseHistogram(raw: unknown): LatencyHistogram | null {
  if (!Array.isArray(raw) || raw.length > HISTOGRAM_SIZE) return null
  const counts: number[] = []
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
    counts.push(value)
  }
  return counts.length > 0 ? trim(counts) : null
}

/** Add one ping to a histogram and return the new histogram (the input is not mutated). */
export function addSample(histogram: LatencyHistogram | null, ms: number): LatencyHistogram {
  const index = bucketIndex(ms)
  const counts = histogram ? [...histogram] : []
  while (counts.length <= index) counts.push(0)
  counts[index] += 1
  return counts
}

/** Element-wise sum of histograms; `null` entries are skipped, `null` when none had data. */
export function mergeHistograms(
  histograms: Iterable<LatencyHistogram | null | undefined>,
): LatencyHistogram | null {
  const merged: number[] = []
  for (const histogram of histograms) {
    if (!histogram) continue
    for (let i = 0; i < histogram.length; i += 1) {
      while (merged.length <= i) merged.push(0)
      merged[i] += histogram[i]
    }
  }
  const trimmed = trim(merged)
  return trimmed.length > 0 ? trimmed : null
}

/** Number of samples in a histogram. */
export const sampleCount = (histogram: LatencyHistogram | null | undefined): number =>
  histogram ? histogram.reduce((sum, count) => sum + count, 0) : 0

export type PercentileBounds = {
  /** Smallest ping of the merged rows; narrows the first bucket's interpolation. */
  min?: number | null
  /** Largest ping of the merged rows; narrows the last bucket's (and the overflow's) interpolation. */
  max?: number | null
}

/**
 * Estimate the `p`-th percentile (0 < p ≤ 100) with the nearest-rank definition: the value of the
 * `ceil(p / 100 · n)`-th smallest sample. The bucket holding that sample is found exactly; inside it
 * the value is interpolated linearly by rank, so the estimate never leaves the true value's bucket.
 * `min` / `max` (the exact extremes of the rows) tighten the interpolation range when they fall
 * inside it. Returns `null` for an empty histogram.
 */
export function estimatePercentile(
  histogram: LatencyHistogram | null | undefined,
  p: number,
  bounds: PercentileBounds = {},
): number | null {
  const total = sampleCount(histogram)
  if (!histogram || total === 0) return null
  const rank = Math.min(total, Math.max(1, Math.ceil((p / 100) * total)))

  let before = 0
  for (let index = 0; index < histogram.length; index += 1) {
    const count = histogram[index]
    if (count === 0 || before + count < rank) {
      before += count
      continue
    }
    let lower = bucketLowerBound(index)
    let upper = bucketUpperBound(index)
    const { min, max } = bounds
    if (typeof min === 'number' && Number.isFinite(min) && min > lower && min < upper) lower = min
    if (typeof max === 'number' && Number.isFinite(max) && max >= lower && max < upper) upper = max
    // The overflow bucket has no upper bound; without a known maximum report its lower bound.
    if (!Number.isFinite(upper)) return lower
    const fraction = (rank - before - 0.5) / count
    return lower + (upper - lower) * fraction
  }
  return null
}

/** Estimate several percentiles at once (all five by default). */
export function estimatePercentiles(
  histogram: LatencyHistogram | null | undefined,
  bounds: PercentileBounds = {},
  percentiles: readonly Percentile[] = PERCENTILES,
): Partial<PercentileValues> {
  const result: Partial<PercentileValues> = {}
  for (const key of percentiles) {
    result[key] = estimatePercentile(histogram, PERCENTILE_VALUES[key], bounds)
  }
  return result
}
