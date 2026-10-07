import { describe, expect, it } from 'vitest'

import {
  closeRun,
  crontabPattern,
  describeCron,
  evaluatePush,
  nextExpectedAt,
  openRun,
  pushGraceMs,
  type PushScheduleSettings,
} from './push-schedule'

const at = (iso: string) => new Date(iso)

/** Nightly 02:00 Europe/Berlin with 30 minutes of grace (the issue's example). */
const nightly: PushScheduleSettings = {
  interval: 60,
  pushSchedule: 'cron',
  pushCron: '0 2 * * *',
  timezone: 'Europe/Berlin',
  pushGrace: 30 * 60,
}

describe('push schedules', () => {
  it('cron: DOWN at 02:31 when the 02:00 ping did not arrive (30 min grace)', () => {
    // Last ping 02:05 CET on March 10th; the next one is due March 11th 02:00 CET (01:00Z).
    const state = { lastPushAt: '2026-03-10T01:05:00Z', lastPushStatus: 'up' as const }
    expect(nextExpectedAt(nightly, at(state.lastPushAt))?.toISOString()).toBe(
      '2026-03-11T01:00:00.000Z',
    )
    expect(evaluatePush(nightly, state, at('2026-03-11T00:59:00Z')).status).toBe('up')
    expect(evaluatePush(nightly, state, at('2026-03-11T01:29:00Z')).status).toBe('up')
    expect(evaluatePush(nightly, state, at('2026-03-11T01:30:00Z')).status).toBe('up')
    expect(evaluatePush(nightly, state, at('2026-03-11T01:31:00Z'))).toMatchObject({
      status: 'down',
      reason: 'late',
    })
  })

  it('cron: spring forward — 02:00 does not exist, the run is due at 03:00 CEST', () => {
    // 2026-03-29: clocks jump from 02:00 CET to 03:00 CEST (01:00Z).
    const state = { lastPushAt: '2026-03-28T01:05:00Z', lastPushStatus: 'up' as const }
    expect(nextExpectedAt(nightly, at(state.lastPushAt))?.toISOString()).toBe(
      '2026-03-29T01:00:00.000Z',
    )
    expect(evaluatePush(nightly, state, at('2026-03-29T01:29:00Z')).status).toBe('up')
    expect(evaluatePush(nightly, state, at('2026-03-29T01:31:00Z')).status).toBe('down')
    // The day after, 02:00 CEST is 00:00Z.
    const after = { lastPushAt: '2026-03-29T01:10:00Z', lastPushStatus: 'up' as const }
    expect(nextExpectedAt(nightly, at(after.lastPushAt))?.toISOString()).toBe(
      '2026-03-30T00:00:00.000Z',
    )
    expect(evaluatePush(nightly, after, at('2026-03-30T00:31:00Z')).status).toBe('down')
  })

  it('cron: fall back — 02:00 happens twice but one run is expected', () => {
    // 2026-10-25: 03:00 CEST becomes 02:00 CET; 02:00 CEST is 00:00Z, 02:00 CET is 01:00Z.
    const before = { lastPushAt: '2026-10-24T00:05:00Z', lastPushStatus: 'up' as const }
    expect(nextExpectedAt(nightly, at(before.lastPushAt))?.toISOString()).toBe(
      '2026-10-25T00:00:00.000Z',
    )
    expect(evaluatePush(nightly, before, at('2026-10-25T00:31:00Z')).status).toBe('down')

    // After the first 02:00 run, the second 02:00 (CET) is not expected again.
    const ran = { lastPushAt: '2026-10-25T00:05:00Z', lastPushStatus: 'up' as const }
    expect(nextExpectedAt(nightly, at(ran.lastPushAt))?.toISOString()).toBe(
      '2026-10-26T01:00:00.000Z',
    )
    expect(evaluatePush(nightly, ran, at('2026-10-25T01:31:00Z')).status).toBe('up')
    expect(evaluatePush(nightly, ran, at('2026-10-26T01:29:00Z')).status).toBe('up')
    expect(evaluatePush(nightly, ran, at('2026-10-26T01:31:00Z')).status).toBe('down')
  })

  it('cron: PENDING until the first expected ping plus grace, then DOWN', () => {
    const state = { since: '2026-03-10T12:00:00Z' }
    expect(evaluatePush(nightly, state, at('2026-03-11T01:20:00Z'))).toMatchObject({
      status: 'pending',
      reason: 'waiting',
    })
    expect(evaluatePush(nightly, state, at('2026-03-11T01:31:00Z'))).toMatchObject({
      status: 'down',
      reason: 'no-ping',
    })
  })

  it('interval: the original window (interval + 10 %, at least 1 s) unless a grace is set', () => {
    const legacy: PushScheduleSettings = { interval: 60 }
    expect(pushGraceMs(legacy)).toBe(6000)
    expect(pushGraceMs({ interval: 5 })).toBe(1000)
    expect(pushGraceMs({ ...legacy, pushGrace: 120 })).toBe(120_000)
    expect(pushGraceMs({ ...nightly, pushGrace: null })).toBe(60_000)

    expect(evaluatePush(legacy, {}, at('2026-01-01T00:00:00Z'))).toMatchObject({
      status: 'down',
      reason: 'no-ping',
    })
    const state = { lastPushAt: '2026-01-01T00:00:00Z' }
    expect(evaluatePush(legacy, state, at('2026-01-01T00:01:06Z')).status).toBe('up')
    expect(evaluatePush(legacy, state, at('2026-01-01T00:01:07Z')).status).toBe('down')
    const graced = { ...legacy, pushGrace: 600 }
    expect(evaluatePush(graced, state, at('2026-01-01T00:10:59Z')).status).toBe('up')
    expect(evaluatePush(graced, state, at('2026-01-01T00:11:01Z')).status).toBe('down')
  })

  it('a reported failure stays DOWN until the next success', () => {
    const state = { lastPushAt: '2026-01-01T00:00:00Z', lastPushStatus: 'down' as const }
    expect(evaluatePush({ interval: 60 }, state, at('2026-01-01T00:00:10Z'))).toMatchObject({
      status: 'down',
      reason: 'failed',
    })
  })

  it('runs: UP while running within grace, DOWN after grace or the maximum duration', () => {
    const settings: PushScheduleSettings = { interval: 3600, pushGrace: 600 }
    const state = {
      lastPushAt: '2026-01-01T00:00:00Z',
      lastPushStatus: 'up' as const,
      runs: [{ rid: null, startedAt: '2026-01-01T01:00:00Z' }],
    }
    expect(evaluatePush(settings, state, at('2026-01-01T01:09:00Z'))).toMatchObject({
      status: 'up',
      reason: 'running',
      ageSeconds: 540,
    })
    // Running overrides the schedule: the ping was due by 01:10, the run started at 01:05 has time.
    const late = { ...state, runs: [{ rid: null, startedAt: '2026-01-01T01:05:00Z' }] }
    expect(evaluatePush(settings, late, at('2026-01-01T01:12:00Z')).status).toBe('up')
    expect(evaluatePush(settings, state, at('2026-01-01T01:10:30Z'))).toMatchObject({
      status: 'down',
      reason: 'run-timeout',
    })
    expect(
      evaluatePush({ ...settings, pushMaxDuration: 300 }, state, at('2026-01-01T01:05:01Z')),
    ).toMatchObject({ status: 'down', reason: 'run-too-long' })
  })

  it('invalid cron expressions are reported instead of throwing', () => {
    expect(evaluatePush({ ...nightly, pushCron: 'nope' }, {}, new Date())).toMatchObject({
      status: 'down',
      reason: 'invalid-schedule',
    })
  })
})

describe('push runs', () => {
  const now = at('2026-01-01T01:00:00Z')

  it('opens one anonymous run and one run per rid', () => {
    let runs = openRun([], null, at('2026-01-01T00:00:00Z'))
    runs = openRun(runs, null, at('2026-01-01T00:10:00Z'))
    expect(runs).toEqual([{ rid: null, startedAt: '2026-01-01T00:10:00.000Z' }])
    runs = openRun(runs, 'a', at('2026-01-01T00:20:00Z'))
    runs = openRun(runs, 'b', at('2026-01-01T00:30:00Z'))
    runs = openRun(runs, 'a', at('2026-01-01T00:40:00Z'))
    expect(runs.map((r) => r.rid)).toEqual([null, 'b', 'a'])
    for (let i = 0; i < 20; i++) runs = openRun(runs, `r${i}`, now)
    expect(runs).toHaveLength(10)
  })

  it('closes the run with the same rid, else the latest anonymous run, and measures it', () => {
    const runs = [
      { rid: null, startedAt: '2026-01-01T00:50:00Z' },
      { rid: 'a', startedAt: '2026-01-01T00:55:00Z' },
    ]
    const byRid = closeRun(runs, 'a', now, 3600_000)
    expect(byRid.durationMs).toBe(5 * 60_000)
    expect(byRid.runs).toEqual([runs[0]])
    const anonymous = closeRun(runs, null, now, 3600_000)
    expect(anonymous.run).toBe(runs[0])
    expect(anonymous.durationMs).toBe(10 * 60_000)
    expect(closeRun(runs, 'zzz', now, 3600_000)).toMatchObject({ run: null, durationMs: null })
    // Runs past the grace period were reported DOWN already and are dropped.
    expect(closeRun(runs, 'a', now, 60_000).runs).toEqual([])
  })
})

describe('cron descriptions', () => {
  it('describes the common shapes', () => {
    expect(describeCron('* * * * *')).toEqual({ kind: 'everyMinute' })
    expect(describeCron('*/15 * * * *')).toEqual({ kind: 'everyMinutes', minutes: 15 })
    expect(describeCron('5 * * * *')).toEqual({ kind: 'hourly', minute: 5 })
    expect(describeCron('0 */6 * * *')).toEqual({ kind: 'everyHours', hours: 6, minute: 0 })
    expect(describeCron('0 2 * * *')).toEqual({ kind: 'daily', time: '02:00' })
    expect(describeCron('30 23 * * 1-5')).toEqual({
      kind: 'weekly',
      weekdays: [1, 2, 3, 4, 5],
      time: '23:30',
    })
    expect(describeCron('0 4 * * SUN,sat')).toMatchObject({ weekdays: [0, 6] })
    expect(describeCron('0 4 * * 5-7')).toMatchObject({ weekdays: [0, 5, 6] })
    expect(describeCron('0 3 1 * *')).toEqual({ kind: 'monthly', day: 1, time: '03:00' })
    expect(describeCron('0 3 1 1 *')).toBeNull()
    expect(describeCron('0 0 3 * * *')).toBeNull()
  })

  it('suggests a crontab line', () => {
    expect(crontabPattern(nightly)).toBe('0 2 * * *')
    expect(crontabPattern({ interval: 60 })).toBe('* * * * *')
    expect(crontabPattern({ interval: 300 })).toBe('*/5 * * * *')
    expect(crontabPattern({ interval: 3600 })).toBe('0 * * * *')
    expect(crontabPattern({ interval: 6 * 3600 })).toBe('0 */6 * * *')
  })
})
