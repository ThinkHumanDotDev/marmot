import { describe, expect, it } from 'vitest'

import {
  nextEscalationStep,
  onCallAt,
  shiftsBetween,
  withinRestrictions,
  type RotationLayer,
  type ScheduleDefinition,
} from './on-call'

const at = (iso: string) => new Date(iso)

const weekly = (overrides: Partial<RotationLayer> = {}): RotationLayer => ({
  rotation: 'weekly',
  handoffTime: '09:00',
  // A Monday.
  startDate: '2026-03-02',
  members: ['ada', 'grace', 'linus'],
  ...overrides,
})

const schedule = (
  layers: RotationLayer[],
  extra: Partial<ScheduleDefinition> = {},
): ScheduleDefinition => ({ timezone: 'America/New_York', layers, ...extra })

const who = (definition: ScheduleDefinition, iso: string) =>
  onCallAt(definition, at(iso))?.userId ?? null

describe('weekly rotation of three members', () => {
  const definition = schedule([weekly()])

  it('nobody is on call before the rotation starts', () => {
    expect(who(definition, '2026-03-02T13:59:59Z')).toBeNull()
    // 09:00 EST is 14:00 UTC.
    expect(who(definition, '2026-03-02T14:00:00Z')).toBe('ada')
  })

  it('hands off at 09:00 local time after the spring-forward change (EST → EDT)', () => {
    // DST starts on Sunday 2026-03-08; the next Monday 09:00 EDT is 13:00 UTC.
    expect(who(definition, '2026-03-09T12:59:59Z')).toBe('ada')
    expect(who(definition, '2026-03-09T13:00:00Z')).toBe('grace')
    expect(who(definition, '2026-03-16T12:59:59Z')).toBe('grace')
    expect(who(definition, '2026-03-16T13:00:00Z')).toBe('linus')
    // Back to the first member after three weeks.
    expect(who(definition, '2026-03-23T13:00:00Z')).toBe('ada')
  })

  it('hands off at 09:00 local time after the fall-back change (EDT → EST)', () => {
    // Week 34 starts Mon 2026-10-26 09:00 EDT (13:00 UTC): members[34 % 3] = 'grace'.
    expect(who(definition, '2026-10-26T12:59:59Z')).toBe('ada')
    expect(who(definition, '2026-10-26T13:00:00Z')).toBe('grace')
    // DST ends on Sunday 2026-11-01; week 35 starts at 09:00 EST = 14:00 UTC: 'linus'.
    expect(who(definition, '2026-11-02T13:59:59Z')).toBe('grace')
    expect(who(definition, '2026-11-02T14:00:00Z')).toBe('linus')
  })

  it('lists the shifts of the DST week with their real lengths', () => {
    const shifts = shiftsBetween(definition, at('2026-03-02T14:00:00Z'), at('2026-03-16T13:00:00Z'))
    expect(
      shifts.map((shift) => [shift.userId, shift.start.toISOString(), shift.end.toISOString()]),
    ).toEqual([
      ['ada', '2026-03-02T14:00:00.000Z', '2026-03-09T13:00:00.000Z'],
      ['grace', '2026-03-09T13:00:00.000Z', '2026-03-16T13:00:00.000Z'],
    ])
    // The DST week is one hour short.
    expect(shifts[0].end.getTime() - shifts[0].start.getTime()).toBe((7 * 24 - 1) * 3_600_000)
  })

  it("filters a member's own shifts", () => {
    const shifts = shiftsBetween(
      definition,
      at('2026-03-02T14:00:00Z'),
      at('2026-04-06T13:00:00Z'),
      {
        userId: 'grace',
      },
    )
    expect(shifts.map((shift) => shift.start.toISOString())).toEqual([
      '2026-03-09T13:00:00.000Z',
      '2026-03-30T13:00:00.000Z',
    ])
  })
})

describe('daily rotation in Europe/Berlin across both DST changes', () => {
  const definition: ScheduleDefinition = {
    timezone: 'Europe/Berlin',
    layers: [
      {
        rotation: 'daily',
        handoffTime: '08:30',
        startDate: '2026-03-27',
        members: ['a', 'b'],
      },
    ],
  }

  it('keeps 08:30 local on the day after spring forward (2026-03-29)', () => {
    // 2026-03-29 08:30 CEST = 06:30 UTC; the day before 08:30 CET = 07:30 UTC.
    expect(who(definition, '2026-03-28T07:29:59Z')).toBe('a')
    expect(who(definition, '2026-03-28T07:30:00Z')).toBe('b')
    expect(who(definition, '2026-03-29T06:29:59Z')).toBe('b')
    expect(who(definition, '2026-03-29T06:30:00Z')).toBe('a')
  })

  it('keeps 08:30 local after fall back (2026-10-25)', () => {
    // 2026-10-25 08:30 CET = 07:30 UTC; day index 212 → 'a'.
    expect(who(definition, '2026-10-25T07:29:59Z')).toBe('b')
    expect(who(definition, '2026-10-25T07:30:00Z')).toBe('a')
  })

  it('a handoff inside the skipped hour happens one hour later', () => {
    const gap: ScheduleDefinition = {
      timezone: 'Europe/Berlin',
      layers: [
        { rotation: 'daily', handoffTime: '02:30', startDate: '2026-03-28', members: ['a', 'b'] },
      ],
    }
    // 02:30 does not exist on 2026-03-29; the handoff happens at 03:30 CEST = 01:30 UTC.
    expect(who(gap, '2026-03-29T01:29:59Z')).toBe('a')
    expect(who(gap, '2026-03-29T01:30:00Z')).toBe('b')
  })
})

describe('custom rotations', () => {
  it('hour-based shifts are exact durations, regardless of DST', () => {
    const definition = schedule([
      {
        rotation: 'custom',
        customLength: 12,
        customUnit: 'hours',
        handoffTime: '08:00',
        startDate: '2026-03-07',
        members: ['day', 'night'],
      },
    ])
    // 2026-03-07 08:00 EST = 13:00 UTC; shifts every 12 h of real time.
    expect(who(definition, '2026-03-07T13:00:00Z')).toBe('day')
    expect(who(definition, '2026-03-08T01:00:00Z')).toBe('night')
    expect(who(definition, '2026-03-08T13:00:00Z')).toBe('day')
  })

  it('day-based custom lengths follow the calendar', () => {
    const definition = schedule([
      {
        rotation: 'custom',
        customLength: 2,
        customUnit: 'days',
        handoffTime: '00:00',
        startDate: '2026-03-07',
        members: ['x', 'y'],
      },
    ])
    expect(who(definition, '2026-03-09T03:59:59Z')).toBe('x') // still 2026-03-08 23:59 EDT
    expect(who(definition, '2026-03-09T04:00:00Z')).toBe('y')
  })
})

describe('restrictions, layers and overrides', () => {
  const business: RotationLayer = weekly({
    members: ['day-shift'],
    restrictions: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '17:00' }],
  })

  it('a restricted layer is only on call inside its windows', () => {
    const definition = schedule([business])
    expect(who(definition, '2026-03-10T14:00:00Z')).toBe('day-shift') // Tue 10:00 EDT
    expect(who(definition, '2026-03-10T21:00:00Z')).toBeNull() // Tue 17:00 EDT
    expect(who(definition, '2026-03-14T14:00:00Z')).toBeNull() // Saturday
  })

  it('windows may wrap past midnight', () => {
    const night = [{ days: ['fri'] as const, start: '22:00', end: '06:00' }]
    expect(withinRestrictions(night, 'UTC', at('2026-03-13T23:00:00Z'))).toBe(true) // Fri 23:00
    expect(withinRestrictions(night, 'UTC', at('2026-03-14T05:59:00Z'))).toBe(true) // Sat 05:59
    expect(withinRestrictions(night, 'UTC', at('2026-03-14T06:00:00Z'))).toBe(false)
    expect(withinRestrictions(night, 'UTC', at('2026-03-12T23:00:00Z'))).toBe(false) // Thu
  })

  it('later layers take precedence where they have somebody on call', () => {
    const definition = schedule([weekly(), business])
    expect(who(definition, '2026-03-10T14:00:00Z')).toBe('day-shift')
    expect(who(definition, '2026-03-10T22:00:00Z')).toBe('grace')
  })

  it('overrides take precedence over every layer, the last one winning', () => {
    const definition = schedule([weekly(), business], {
      overrides: [
        { user: 'holiday-cover', start: '2026-03-10T00:00:00Z', end: '2026-03-11T00:00:00Z' },
        { user: 'late-swap', start: '2026-03-10T20:00:00Z', end: '2026-03-10T23:00:00Z' },
      ],
    })
    expect(onCallAt(definition, at('2026-03-10T14:00:00Z'))).toEqual({
      userId: 'holiday-cover',
      source: 'override',
      index: 0,
    })
    expect(who(definition, '2026-03-10T21:00:00Z')).toBe('late-swap')
    expect(who(definition, '2026-03-11T00:00:00Z')).toBe('grace')
    const shifts = shiftsBetween(definition, at('2026-03-10T00:00:00Z'), at('2026-03-11T02:00:00Z'))
    expect(shifts.map((shift) => [shift.userId, shift.source])).toEqual([
      ['holiday-cover', 'override'],
      ['late-swap', 'override'],
      ['holiday-cover', 'override'],
      ['grace', 'layer'],
    ])
  })
})

describe('nextEscalationStep', () => {
  it('walks the steps, repeats, then stops', () => {
    expect(nextEscalationStep(2, 1, 0, 0)).toEqual({ step: 1, round: 0 })
    expect(nextEscalationStep(2, 1, 1, 0)).toEqual({ step: 0, round: 1 })
    expect(nextEscalationStep(2, 1, 1, 1)).toBeNull()
    expect(nextEscalationStep(1, 0, 0, 0)).toBeNull()
  })
})
