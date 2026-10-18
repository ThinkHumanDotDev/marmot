import { describe, expect, it } from 'vitest'

import {
  describeBreach,
  describeHealthy,
  evaluateHostThresholds,
  hostSampleSchema,
  mergeSeries,
  parseHostThresholds,
  sampleSeries,
  thresholdSeriesKeys,
  type HostRollupRow,
  type HostThreshold,
} from './host-metrics'

const GiB = 1024 ** 3

const threshold = (data: Partial<HostThreshold>): HostThreshold => ({
  metric: 'cpu',
  target: null,
  operator: '>',
  value: 90,
  duration: 0,
  severity: 'down',
  ...data,
})

/** Minute rows from `[minutesAgo, value]` pairs, one sample each. */
const rows = (now: Date, key: string, points: [number, number][]): HostRollupRow[] =>
  points.map(([ago, value]) => ({
    timestamp: Math.floor((now.getTime() - ago * 60_000) / 60_000) * 60,
    series: mergeSeries({}, { [key]: value }),
  }))

describe('host samples', () => {
  it('derives the series of a sample', () => {
    const sample = hostSampleSchema.parse({
      hostname: 'web-1',
      cpu: 12.5,
      load: [0.5, 0.4, 0.3],
      memory: { used: 4 * GiB, total: 16 * GiB },
      swap: { used: 0, total: 0 },
      disks: [
        { mount: '/', used: 93, total: 100 },
        { mount: '/data', used: 10, total: 100 },
      ],
      network: { rx: 1000, tx: 2000 },
      temperatures: [{ name: 'cpu-thermal', celsius: 55 }],
      containers: [{ name: 'web', cpu: 150, memoryUsed: 256, memoryLimit: 1024 }],
    })
    expect(sampleSeries(sample)).toEqual({
      cpu: 12.5,
      load1: 0.5,
      load5: 0.4,
      load15: 0.3,
      memory: 25,
      'disk:/': 93,
      'disk:/data': 10,
      'net:rx': 1000,
      'net:tx': 2000,
      'temp:cpu-thermal': 55,
      'docker.cpu:web': 150,
      'docker.mem:web': 25,
    })
  })

  it('rejects malformed samples', () => {
    expect(hostSampleSchema.safeParse({}).success).toBe(false)
    expect(hostSampleSchema.safeParse({ hostname: 'x', cpu: -1 }).success).toBe(false)
    expect(
      hostSampleSchema.safeParse({ hostname: 'x', disks: [{ mount: '', used: 1, total: 2 }] })
        .success,
    ).toBe(false)
  })

  it('merges samples into rollup aggregates', () => {
    const merged = mergeSeries(mergeSeries({}, { cpu: 10 }), { cpu: 30 })
    expect(merged.cpu).toEqual([2, 40, 10, 30, 30])
  })
})

describe('host thresholds', () => {
  const now = new Date('2026-10-18T12:00:30Z')

  it('matches targeted metrics by target, or every series without one', () => {
    const keys = ['disk:/', 'disk:/data', 'cpu']
    expect(thresholdSeriesKeys(threshold({ metric: 'disk' }), keys)).toEqual([
      'disk:/',
      'disk:/data',
    ])
    expect(thresholdSeriesKeys(threshold({ metric: 'disk', target: '/data' }), keys)).toEqual([
      'disk:/data',
    ])
    expect(thresholdSeriesKeys(threshold({ metric: 'cpu' }), keys)).toEqual(['cpu'])
  })

  it('judges the newest value without a duration and names the worst series', () => {
    const data: HostRollupRow[] = [
      {
        timestamp: Math.floor(now.getTime() / 60_000) * 60,
        series: mergeSeries({}, { 'disk:/': 93, 'disk:/data': 97, cpu: 20 }),
      },
    ]
    const verdict = evaluateHostThresholds([threshold({ metric: 'disk' })], data, now)
    expect(verdict.status).toBe('down')
    expect(verdict.breaches.map(describeBreach)).toEqual(['disk /data at 97 % (> 90 %)'])
  })

  it('needs every sample of the duration to breach, and enough history', () => {
    const sustained = threshold({ duration: 300, severity: 'degraded' })
    const steady = rows(now, 'cpu', [
      [6, 95],
      [5, 96],
      [4, 97],
      [3, 95],
      [2, 99],
      [1, 98],
      [0, 97],
    ])
    expect(evaluateHostThresholds([sustained], steady, now).status).toBe('degraded')
    expect(describeBreach(evaluateHostThresholds([sustained], steady, now).breaches[0])).toBe(
      'CPU at 97 % for 5 min (> 90 %)',
    )
    // One healthy sample inside the window clears it.
    const dip = steady.map((row, i) => (i === 3 ? rows(now, 'cpu', [[3, 40]])[0] : row))
    expect(evaluateHostThresholds([sustained], dip, now).status).toBe('up')
    // Two minutes of history are not five.
    expect(evaluateHostThresholds([sustained], steady.slice(-2), now).status).toBe('up')
  })

  it('only judges series the newest sample still reports', () => {
    const data: HostRollupRow[] = [
      { timestamp: 1000 * 60, series: mergeSeries({}, { 'disk:/mnt': 99, cpu: 5 }) },
      { timestamp: 1001 * 60, series: mergeSeries({}, { cpu: 5 }) },
    ]
    expect(evaluateHostThresholds([threshold({ metric: 'disk' })], data, now).status).toBe('up')
  })

  it('treats lower-bound thresholds symmetrically', () => {
    const data = rows(now, 'cpu', [[0, 2]])
    const verdict = evaluateHostThresholds([threshold({ operator: '<', value: 5 })], data, now)
    expect(verdict.status).toBe('down')
  })

  it('DOWN wins over degraded', () => {
    const data: HostRollupRow[] = [
      { timestamp: 1, series: mergeSeries({}, { cpu: 99, memory: 99 }) },
    ]
    const verdict = evaluateHostThresholds(
      [threshold({ severity: 'degraded' }), threshold({ metric: 'memory' })],
      data,
      now,
    )
    expect(verdict.status).toBe('down')
    expect(verdict.breaches).toHaveLength(2)
  })

  it('skips malformed stored thresholds', () => {
    expect(
      parseHostThresholds([{ metric: 'cpu', value: 90 }, { metric: 'nope', value: 1 }, null]),
    ).toEqual([threshold({})])
  })

  it('summarises a healthy host', () => {
    expect(describeHealthy({ cpu: 12.34, memory: 48, 'disk:/': 61, 'disk:/data': 70 })).toBe(
      'CPU 12 %, memory 48 %, disk /data 70 %',
    )
  })
})
