import { describe, expect, it } from 'vitest'

import {
  applyTiming,
  mergeBucketTiming,
  bucketTimingAverages,
  parseRequestTiming,
  timingTotal,
  type RequestTiming,
} from './request-timing'

const beat = (over: Partial<RequestTiming>): RequestTiming => ({
  dns: null,
  connect: null,
  tls: null,
  ttfb: null,
  transfer: null,
  ...over,
})

describe('parseRequestTiming', () => {
  it('returns null when no phase carries a value (an empty heartbeat group)', () => {
    expect(parseRequestTiming({ dns: null, connect: null })).toBeNull()
    expect(parseRequestTiming(null)).toBeNull()
    expect(parseRequestTiming([1, 2])).toBeNull()
  })

  it('keeps finite non-negative phases and drops the rest', () => {
    expect(parseRequestTiming({ dns: 1.5, connect: -1, tls: 'x', ttfb: 10, id: 3 })).toEqual(
      beat({ dns: 1.5, ttfb: 10 }),
    )
  })
})

describe('applyTiming', () => {
  it('keeps a running average per phase with its own count', () => {
    let bucket = applyTiming(undefined, beat({ connect: 2, tls: 10, ttfb: 30 }))
    bucket = applyTiming(bucket, beat({ connect: 4, ttfb: 50 }))
    expect(bucket.connect).toEqual({ avg: 3, count: 2 })
    expect(bucket.ttfb).toEqual({ avg: 40, count: 2 })
    // The second check had no TLS phase (reused connection): the TLS average is not diluted.
    expect(bucket.tls).toEqual({ avg: 10, count: 1 })
    expect(bucket.dns).toBeUndefined()
  })

  it('does not mutate its input', () => {
    const first = applyTiming(undefined, beat({ ttfb: 10 }))
    applyTiming(first, beat({ ttfb: 30 }))
    expect(first.ttfb).toEqual({ avg: 10, count: 1 })
  })
})

describe('mergeBucketTiming', () => {
  it('weights each bucket by its per-phase count', () => {
    const a = { timing: { ttfb: { avg: 10, count: 1 }, tls: { avg: 4, count: 1 } } }
    const b = { timing: { ttfb: { avg: 40, count: 3 } } }
    expect(mergeBucketTiming([a, b, { pingCount: 2 }, null])).toEqual(
      beat({ ttfb: (10 + 120) / 4, tls: 4 }),
    )
    expect(mergeBucketTiming([{ pingCount: 1 }])).toBeNull()
  })
})

describe('bucketTimingAverages / timingTotal', () => {
  it('reads the averages back from a bucket extras object', () => {
    const extras = { pingCount: 2, timing: applyTiming(undefined, beat({ dns: 1, ttfb: 9 })) }
    const averages = bucketTimingAverages(extras)
    expect(averages).toEqual(beat({ dns: 1, ttfb: 9 }))
    expect(timingTotal(averages as RequestTiming)).toBe(10)
    expect(bucketTimingAverages({ pingCount: 1 })).toBeNull()
  })
})
