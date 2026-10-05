import { describe, expect, it } from 'vitest'

import {
  applyBeat,
  BUCKET_SECONDS,
  emptyBucket,
  flatStatus,
  getDailyKey,
  getHourlyKey,
  getKey,
  getMinutelyKey,
  isStatsRange,
  RANGE_SPECS,
  rangeWindow,
  summarize,
  type BucketData,
  type HeartbeatStatus,
} from './uptime-calculator'

// 2021-01-01T12:34:56.789Z
const T = new Date(Date.UTC(2021, 0, 1, 12, 34, 56, 789))

describe('bucket keys', () => {
  it('truncates to the start of the minute, hour and UTC day', () => {
    expect(getMinutelyKey(T)).toBe(Date.UTC(2021, 0, 1, 12, 34, 0) / 1000)
    expect(getHourlyKey(T)).toBe(Date.UTC(2021, 0, 1, 12, 0, 0) / 1000)
    expect(getDailyKey(T)).toBe(Date.UTC(2021, 0, 1, 0, 0, 0) / 1000)
  })

  it('maps the same instant to the same key regardless of sub-second noise', () => {
    const a = new Date(Date.UTC(2021, 0, 1, 12, 34, 0, 0))
    const b = new Date(Date.UTC(2021, 0, 1, 12, 34, 59, 999))
    expect(getMinutelyKey(a)).toBe(getMinutelyKey(b))
    expect(getMinutelyKey(new Date(b.getTime() + 1))).toBe(getMinutelyKey(a) + 60)
  })

  it('keeps daily keys on UTC midnight across the date line', () => {
    const lateEvening = new Date(Date.UTC(2021, 0, 1, 23, 59, 59))
    const nextDay = new Date(Date.UTC(2021, 0, 2, 0, 0, 0))
    expect(getDailyKey(nextDay) - getDailyKey(lateEvening)).toBe(86400)
    expect(getDailyKey(lateEvening) % 86400).toBe(0)
  })

  it('getKey dispatches by granularity', () => {
    expect(getKey(T, 'minute')).toBe(getMinutelyKey(T))
    expect(getKey(T, 'hour')).toBe(getHourlyKey(T))
    expect(getKey(T, 'day')).toBe(getDailyKey(T))
  })
})

describe('flatStatus', () => {
  it('maps maintenance to up and pending to down', () => {
    expect(flatStatus('up')).toBe('up')
    expect(flatStatus('maintenance')).toBe('up')
    expect(flatStatus('down')).toBe('down')
    expect(flatStatus('pending')).toBe('down')
  })

  it('rejects unknown statuses', () => {
    expect(() => flatStatus('weird' as HeartbeatStatus)).toThrow(/Invalid heartbeat status/)
  })
})

describe('applyBeat', () => {
  const beats = (list: Array<[HeartbeatStatus, number | null]>): BucketData =>
    list.reduce((bucket, [status, ping]) => applyBeat(bucket, status, ping), emptyBucket())

  it('does not mutate the input bucket', () => {
    const start = emptyBucket()
    applyBeat(start, 'up', 10)
    expect(start).toEqual(emptyBucket())
  })

  it('sets ping/min/max from the first UP beat', () => {
    expect(beats([['up', 120]])).toEqual({
      up: 1,
      down: 0,
      ping: 120,
      pingMin: 120,
      pingMax: 120,
      extras: { pingCount: 1 },
    })
  })

  it('keeps a running average with min and max', () => {
    const bucket = beats([
      ['up', 100],
      ['up', 200],
      ['up', 300],
    ])
    expect(bucket.up).toBe(3)
    expect(bucket.ping).toBe(200)
    expect(bucket.pingMin).toBe(100)
    expect(bucket.pingMax).toBe(300)
    expect(bucket.extras.pingCount).toBe(3)
  })

  it('counts down and pending as down and ignores their ping', () => {
    const bucket = beats([
      ['up', 50],
      ['down', 999],
      ['pending', 5],
    ])
    expect(bucket).toMatchObject({ up: 1, down: 2, ping: 50, pingMin: 50, pingMax: 50 })
  })

  it('counts maintenance as up without touching the ping average', () => {
    const bucket = beats([
      ['up', 100],
      ['maintenance', null],
      ['maintenance', 7],
      ['up', 300],
    ])
    expect(bucket.up).toBe(4)
    expect(bucket.down).toBe(0)
    expect(bucket.extras.maintenance).toBe(2)
    expect(bucket.extras.pingCount).toBe(2)
    expect(bucket.ping).toBe(200)
  })

  it('skips missing or invalid pings while still counting the beat as up', () => {
    const bucket = beats([
      ['up', null],
      ['up', Number.NaN],
      ['up', -1],
      ['up', 40],
    ])
    expect(bucket.up).toBe(4)
    expect(bucket.ping).toBe(40)
    expect(bucket.extras.pingCount).toBe(1)
  })
})

describe('summarize', () => {
  it('returns zero uptime and null ping without data', () => {
    expect(summarize([])).toEqual({ uptime: 0, avgPing: null })
  })

  it('computes uptime as up / (up + down) across buckets', () => {
    const a = { ...emptyBucket(), up: 3, down: 1 }
    const b = { ...emptyBucket(), up: 4, down: 2 }
    expect(summarize([a, b]).uptime).toBeCloseTo(7 / 10, 10)
  })

  it('weights the ping average by the number of pinged beats', () => {
    const a: BucketData = {
      up: 2,
      down: 0,
      ping: 100,
      pingMin: 100,
      pingMax: 100,
      extras: { pingCount: 2 },
    }
    const b: BucketData = {
      up: 1,
      down: 0,
      ping: 400,
      pingMin: 400,
      pingMax: 400,
      extras: { pingCount: 1 },
    }
    expect(summarize([a, b]).avgPing).toBe(200)
  })

  it('falls back to `up` as weight for rows without pingCount', () => {
    const legacy: BucketData = { up: 3, down: 0, ping: 90, pingMin: 90, pingMax: 90, extras: {} }
    const modern: BucketData = {
      up: 1,
      down: 0,
      ping: 10,
      pingMin: 10,
      pingMax: 10,
      extras: { pingCount: 1 },
    }
    expect(summarize([legacy, modern]).avgPing).toBe(70)
  })

  it('returns null ping when only down beats were recorded', () => {
    expect(summarize([{ ...emptyBucket(), down: 5 }])).toEqual({ uptime: 0, avgPing: null })
  })

  it('reports 100 % uptime for maintenance-only buckets', () => {
    const bucket = applyBeat(emptyBucket(), 'maintenance', null)
    expect(summarize([bucket])).toEqual({ uptime: 1, avgPing: null })
  })
})

describe('ranges', () => {
  it('validates range strings', () => {
    expect(isStatsRange('24h')).toBe(true)
    expect(isStatsRange('30d')).toBe(true)
    expect(isStatsRange('1y')).toBe(true)
    expect(isStatsRange('7d')).toBe(false)
    expect(isStatsRange(undefined)).toBe(false)
  })

  it('uses minutely for 24h, hourly for 30d and daily for 1y', () => {
    expect(RANGE_SPECS['24h']).toMatchObject({
      granularity: 'minute',
      buckets: 1440,
      collection: 'stat-minutely',
    })
    expect(RANGE_SPECS['30d']).toMatchObject({
      granularity: 'hour',
      buckets: 720,
      collection: 'stat-hourly',
    })
    expect(RANGE_SPECS['1y']).toMatchObject({
      granularity: 'day',
      buckets: 365,
      collection: 'stat-daily',
    })
  })

  it('computes an inclusive window ending at the current bucket', () => {
    for (const range of ['24h', '30d', '1y'] as const) {
      const spec = RANGE_SPECS[range]
      const { from, to } = rangeWindow(range, T)
      expect(to).toBe(getKey(T, spec.granularity))
      expect((to - from) / BUCKET_SECONDS[spec.granularity] + 1).toBe(spec.buckets)
    }
  })

  it('24h window spans exactly one day of minutes', () => {
    const { from, to } = rangeWindow('24h', T)
    expect(to - from).toBe(24 * 3600 - 60)
  })
})
