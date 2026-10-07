import { describe, expect, it } from 'vitest'

import { isReminderDue, reminderGapFactor } from './reminder-backoff'

describe('reminderGapFactor', () => {
  it('spaces reminders by 1, 1, 1 / 1, 2, 3 / 1, 2, 4 base intervals', () => {
    const gaps = (b: 'none' | 'linear' | 'exponential') =>
      [0, 1, 2, 3].map((k) => reminderGapFactor(b, k))
    expect(gaps('none')).toEqual([1, 1, 1, 1])
    expect(gaps('linear')).toEqual([1, 2, 3, 4])
    expect(gaps('exponential')).toEqual([1, 2, 4, 8])
    expect(Number.isFinite(reminderGapFactor('exponential', 10_000))).toBe(true)
  })
})

describe('isReminderDue', () => {
  const t0 = new Date('2026-01-01T00:00:00Z')
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000)

  /** Simulates one tick per base interval (10 minutes) and returns the ticks that send. */
  function sentTicks(backoff: string, maxReminders = 0, ticks = 16): number[] {
    let sent = 0
    let last: Date | null = null
    const out: number[] = []
    for (let tick = 1; tick <= ticks; tick++) {
      // A little jitter: workers never fire exactly on time.
      const now = at(tick * 10 + (tick % 2 ? 0.3 : -0.2))
      if (
        isReminderDue({
          backoff,
          maxReminders,
          remindersSent: sent,
          lastReminderAt: last,
          baseSeconds: 600,
          now,
        })
      ) {
        sent++
        last = now
        out.push(tick)
      }
    }
    return out
  }

  it('fixed sends every tick', () => {
    expect(sentTicks('none', 0, 5)).toEqual([1, 2, 3, 4, 5])
  })

  it('linear waits 1, 2, 3 … ticks', () => {
    expect(sentTicks('linear')).toEqual([1, 3, 6, 10, 15])
  })

  it('exponential waits 1, 2, 4, 8 … ticks', () => {
    expect(sentTicks('exponential')).toEqual([1, 3, 7, 15])
  })

  it('stops at maxReminders', () => {
    expect(sentTicks('none', 3, 10)).toEqual([1, 2, 3])
    expect(sentTicks('exponential', 2)).toEqual([1, 3])
  })

  it('treats unknown backoffs and missing bookkeeping as fixed', () => {
    expect(
      isReminderDue({
        backoff: 'weird',
        remindersSent: 4,
        lastReminderAt: t0,
        baseSeconds: 600,
        now: t0,
      }),
    ).toBe(true)
    expect(
      isReminderDue({ backoff: 'exponential', remindersSent: 4, baseSeconds: 600, now: t0 }),
    ).toBe(true)
  })
})
