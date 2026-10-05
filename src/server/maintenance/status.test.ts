import { formatInTimeZone } from 'date-fns-tz'
import { describe, expect, it } from 'vitest'

import {
  buildCron,
  computeMaintenanceTimeslots,
  getMaintenanceStatus,
  resolveTimezone,
  windowDurationMinutes,
  type MaintenanceLike,
} from './status'

const at = (iso: string) => new Date(iso)
const utc = { serverTimezone: 'UTC' }

const base = (overrides: Partial<MaintenanceLike>): MaintenanceLike => ({
  strategy: 'single',
  active: true,
  timezone: 'UTC',
  dateRange: { start: null, end: null },
  timeRange: { start: '02:00', end: '03:00' },
  intervalDay: 1,
  weekdays: [],
  daysOfMonth: [],
  cron: '30 3 * * *',
  duration: 60,
  ...overrides,
})

describe('helpers', () => {
  it('resolves SAME_AS_SERVER to the server zone', () => {
    expect(resolveTimezone('SAME_AS_SERVER', 'Europe/Paris')).toBe('Europe/Paris')
    expect(resolveTimezone(null, 'Europe/Paris')).toBe('Europe/Paris')
    expect(resolveTimezone('Asia/Tokyo', 'Europe/Paris')).toBe('Asia/Tokyo')
    expect(resolveTimezone('SAME_AS_SERVER')).toBeTruthy()
  })

  it('computes the daily window length, across midnight too', () => {
    expect(windowDurationMinutes({ start: '02:00', end: '03:30' })).toBe(90)
    expect(windowDurationMinutes({ start: '23:00', end: '01:00' })).toBe(120)
    expect(windowDurationMinutes({ start: 'x', end: '01:00' })).toBe(0)
  })

  it('generates cron patterns like Uptime Kuma', () => {
    expect(buildCron(base({ strategy: 'recurring-interval', timeRange: { start: '04:15', end: '05:00' } }))).toBe(
      '15 4 * * *',
    )
    expect(buildCron(base({ strategy: 'recurring-weekday', weekdays: ['5', '1', 1] }))).toBe(
      '0 2 * * 1,5',
    )
    expect(
      buildCron(
        base({
          strategy: 'recurring-day-of-month',
          daysOfMonth: ['15', 'lastDay1', '1', 'lastDay2'],
        }),
      ),
    ).toBe('0 2 1,15,L * *')
    expect(buildCron(base({ strategy: 'recurring-weekday', weekdays: [] }))).toBeNull()
    expect(buildCron(base({ strategy: 'cron', cron: ' */5 * * * * ' }))).toBe('*/5 * * * *')
  })
})

describe('inactive / manual / unknown', () => {
  it('is inactive when paused, whatever the strategy', () => {
    expect(getMaintenanceStatus(base({ strategy: 'manual', active: false }), at('2026-01-01T00:00:00Z'), utc)).toBe(
      'inactive',
    )
  })

  it('manual is under maintenance until paused', () => {
    const slots = computeMaintenanceTimeslots(base({ strategy: 'manual' }), at('2026-01-01T00:00:00Z'), utc)
    expect(slots.status).toBe('under-maintenance')
    expect(slots.current).toBeNull()
  })

  it('is unknown when the schedule cannot be evaluated', () => {
    expect(getMaintenanceStatus(base({ strategy: 'cron', cron: 'nope' }), at('2026-01-01T00:00:00Z'), utc)).toBe(
      'unknown',
    )
    expect(getMaintenanceStatus(base({ strategy: 'single' }), at('2026-01-01T00:00:00Z'), utc)).toBe('unknown')
  })
})

describe('single window', () => {
  const doc = base({
    strategy: 'single',
    timezone: 'Asia/Tokyo',
    dateRange: { start: '2026-01-01T09:00', end: '2026-01-01T10:30' },
  })

  it('reads the wall-clock range in the maintenance timezone, not the server one', () => {
    const before = computeMaintenanceTimeslots(doc, at('2025-12-31T23:59:00Z'), {
      serverTimezone: 'America/Los_Angeles',
    })
    expect(before.status).toBe('scheduled')
    // 09:00 JST is 00:00Z.
    expect(before.next).toEqual({ start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T01:30:00.000Z' })

    const during = computeMaintenanceTimeslots(doc, at('2026-01-01T00:00:00Z'), {
      serverTimezone: 'America/Los_Angeles',
    })
    expect(during.status).toBe('under-maintenance')
    expect(during.current?.end).toBe('2026-01-01T01:30:00.000Z')

    expect(getMaintenanceStatus(doc, at('2026-01-01T01:30:00Z'), utc)).toBe('ended')
  })

  it('accepts ISO instants with an offset as-is', () => {
    const iso = base({
      strategy: 'single',
      timezone: 'Asia/Tokyo',
      dateRange: { start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T01:00:00+00:00' },
    })
    expect(computeMaintenanceTimeslots(iso, at('2026-01-01T00:30:00Z'), utc).current).toEqual({
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-01T01:00:00.000Z',
    })
  })
})

describe('recurring-interval', () => {
  it('runs daily when the interval is one day', () => {
    const doc = base({ strategy: 'recurring-interval', intervalDay: 1 })
    const during = computeMaintenanceTimeslots(doc, at('2026-01-05T02:30:00Z'), utc)
    expect(during.status).toBe('under-maintenance')
    expect(during.current).toEqual({ start: '2026-01-05T02:00:00.000Z', end: '2026-01-05T03:00:00.000Z' })
    expect(during.next?.start).toBe('2026-01-06T02:00:00.000Z')

    const between = computeMaintenanceTimeslots(doc, at('2026-01-05T04:00:00Z'), utc)
    expect(between.status).toBe('scheduled')
    expect(between.current).toBeNull()
    expect(between.next).toEqual({ start: '2026-01-06T02:00:00.000Z', end: '2026-01-06T03:00:00.000Z' })
  })

  it('anchors "every N days" on the range start and handles windows across midnight', () => {
    const doc = base({
      strategy: 'recurring-interval',
      intervalDay: 3,
      dateRange: { start: '2026-01-01T00:00', end: null },
      timeRange: { start: '22:00', end: '01:00' },
    })
    // Occurrences: Jan 1, 4, 7, … at 22:00 for 3 hours.
    expect(getMaintenanceStatus(doc, at('2026-01-04T23:00:00Z'), utc)).toBe('under-maintenance')
    const spill = computeMaintenanceTimeslots(doc, at('2026-01-05T00:30:00Z'), utc)
    expect(spill.status).toBe('under-maintenance')
    expect(spill.current).toEqual({ start: '2026-01-04T22:00:00.000Z', end: '2026-01-05T01:00:00.000Z' })

    const skipDay = computeMaintenanceTimeslots(doc, at('2026-01-05T23:00:00Z'), utc)
    expect(skipDay.status).toBe('scheduled')
    expect(skipDay.next?.start).toBe('2026-01-07T22:00:00.000Z')
    expect(getMaintenanceStatus(doc, at('2026-01-02T22:30:00Z'), utc)).toBe('scheduled')
  })

  it('is scheduled before the range starts and ended after it ends', () => {
    const doc = base({
      strategy: 'recurring-interval',
      dateRange: { start: '2026-02-01T00:00', end: '2026-02-03T02:30' },
    })
    const before = computeMaintenanceTimeslots(doc, at('2026-01-31T02:30:00Z'), utc)
    expect(before.status).toBe('scheduled')
    expect(before.next?.start).toBe('2026-02-01T02:00:00.000Z')

    // The last occurrence is clipped to the range end (Kuma `inferDuration`).
    const clipped = computeMaintenanceTimeslots(doc, at('2026-02-03T02:15:00Z'), utc)
    expect(clipped.status).toBe('under-maintenance')
    expect(clipped.current).toEqual({ start: '2026-02-03T02:00:00.000Z', end: '2026-02-03T02:30:00.000Z' })
    expect(clipped.next).toBeNull()

    expect(getMaintenanceStatus(doc, at('2026-02-03T02:30:00Z'), utc)).toBe('ended')
  })

  it('keeps the same wall-clock time across a DST change (every 2 days, Europe/London)', () => {
    // Clocks go forward in London on 2026-03-29 at 01:00Z.
    const doc = base({
      strategy: 'recurring-interval',
      intervalDay: 2,
      timezone: 'Europe/London',
      dateRange: { start: '2026-03-27T00:00', end: null },
      timeRange: { start: '03:00', end: '04:00' },
    })
    const gmt = computeMaintenanceTimeslots(doc, at('2026-03-27T03:30:00Z'), utc)
    expect(gmt.status).toBe('under-maintenance')
    expect(gmt.current?.start).toBe('2026-03-27T03:00:00.000Z')
    // Next occurrence: Mar 29, after the switch → 03:00 BST = 02:00Z.
    expect(gmt.next?.start).toBe('2026-03-29T02:00:00.000Z')
    expect(formatInTimeZone(new Date(gmt.next!.start), 'Europe/London', 'HH:mm')).toBe('03:00')

    const bst = computeMaintenanceTimeslots(doc, at('2026-03-31T02:30:00Z'), utc)
    expect(bst.status).toBe('under-maintenance')
    expect(bst.current).toEqual({ start: '2026-03-31T02:00:00.000Z', end: '2026-03-31T03:00:00.000Z' })
  })
})

describe('recurring-weekday', () => {
  const doc = base({
    strategy: 'recurring-weekday',
    timezone: 'America/New_York',
    weekdays: ['1', '5'],
    timeRange: { start: '10:00', end: '11:00' },
  })

  it('runs on the chosen weekdays in the maintenance timezone', () => {
    // 2026-01-05 is a Monday; 10:30 EST = 15:30Z.
    const monday = computeMaintenanceTimeslots(doc, at('2026-01-05T15:30:00Z'), utc)
    expect(monday.status).toBe('under-maintenance')
    expect(monday.current).toEqual({ start: '2026-01-05T15:00:00.000Z', end: '2026-01-05T16:00:00.000Z' })

    const tuesday = computeMaintenanceTimeslots(doc, at('2026-01-06T15:30:00Z'), utc)
    expect(tuesday.status).toBe('scheduled')
    expect(tuesday.next?.start).toBe('2026-01-09T15:00:00.000Z')
  })

  it('follows the DST shift of its own zone', () => {
    // New York springs forward on 2026-03-08; Monday 2026-03-09 10:00 EDT = 14:00Z.
    const after = computeMaintenanceTimeslots(doc, at('2026-03-09T14:30:00Z'), utc)
    expect(after.status).toBe('under-maintenance')
    expect(after.current?.start).toBe('2026-03-09T14:00:00.000Z')
    // Friday before the switch: 10:00 EST = 15:00Z.
    expect(computeMaintenanceTimeslots(doc, at('2026-03-06T15:30:00Z'), utc).current?.start).toBe(
      '2026-03-06T15:00:00.000Z',
    )
  })
})

describe('recurring-day-of-month', () => {
  const doc = base({
    strategy: 'recurring-day-of-month',
    daysOfMonth: ['1', '15', 'lastDay1'],
    timeRange: { start: '03:00', end: '04:00' },
  })

  it('includes numbered days and the last day of the month', () => {
    expect(getMaintenanceStatus(doc, at('2026-02-15T03:30:00Z'), utc)).toBe('under-maintenance')
    const lastDay = computeMaintenanceTimeslots(doc, at('2026-02-28T03:30:00Z'), utc)
    expect(lastDay.status).toBe('under-maintenance')
    expect(lastDay.current?.start).toBe('2026-02-28T03:00:00.000Z')
    expect(lastDay.next?.start).toBe('2026-03-01T03:00:00.000Z')

    const midMonth = computeMaintenanceTimeslots(doc, at('2026-02-20T12:00:00Z'), utc)
    expect(midMonth.status).toBe('scheduled')
    expect(midMonth.next?.start).toBe('2026-02-28T03:00:00.000Z')
  })
})

describe('cron', () => {
  const doc = base({ strategy: 'cron', cron: '*/15 * * * *', duration: 5 })

  it('opens a window of `duration` minutes at every match', () => {
    const inside = computeMaintenanceTimeslots(doc, at('2026-01-01T10:17:00Z'), utc)
    expect(inside.status).toBe('under-maintenance')
    expect(inside.current).toEqual({ start: '2026-01-01T10:15:00.000Z', end: '2026-01-01T10:20:00.000Z' })
    expect(inside.next?.start).toBe('2026-01-01T10:30:00.000Z')

    const outside = computeMaintenanceTimeslots(doc, at('2026-01-01T10:22:00Z'), utc)
    expect(outside.status).toBe('scheduled')
    expect(outside.next).toEqual({ start: '2026-01-01T10:30:00.000Z', end: '2026-01-01T10:35:00.000Z' })
  })

  it('uses SAME_AS_SERVER through the server timezone', () => {
    const nightly = base({ strategy: 'cron', cron: '0 2 * * *', duration: 60, timezone: 'SAME_AS_SERVER' })
    // 02:30 in Tokyo on Jan 2 is 17:30Z on Jan 1.
    expect(getMaintenanceStatus(nightly, at('2026-01-01T17:30:00Z'), { serverTimezone: 'Asia/Tokyo' })).toBe(
      'under-maintenance',
    )
    expect(getMaintenanceStatus(nightly, at('2026-01-01T17:30:00Z'), { serverTimezone: 'UTC' })).toBe(
      'scheduled',
    )
  })

  it('ends when the range end is reached and no occurrence remains', () => {
    const bounded = base({
      strategy: 'cron',
      cron: '0 2 * * *',
      duration: 60,
      dateRange: { start: null, end: '2026-01-02T00:00' },
    })
    expect(getMaintenanceStatus(bounded, at('2026-01-01T02:30:00Z'), utc)).toBe('under-maintenance')
    expect(getMaintenanceStatus(bounded, at('2026-01-02T00:00:00Z'), utc)).toBe('ended')
  })
})
