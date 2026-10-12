import { describe, expect, it } from 'vitest'

import {
  currentPeriod,
  emptySlaFigures,
  meanTimeToRecovery,
  periodDates,
  periodDays,
  periodFromDates,
  periodSeconds,
  previousSchedulePeriod,
  slaAttainment,
  slaHealth,
  slaReportCsv,
  slaUptime,
  type SlaFigures,
} from './sla'

const DAY = 86_400
/** September 2026: 30 days, 2,592,000 seconds. */
const SEPTEMBER = DAY * 30

const figures = (overrides: Partial<SlaFigures>): SlaFigures => ({
  ...emptySlaFigures(),
  ...overrides,
})

describe('periods', () => {
  const now = new Date('2026-10-12T15:30:00Z') // a Monday

  it('resolves calendar months, quarters and rolling 30 days in UTC', () => {
    const month = currentPeriod('month', now)
    expect(periodDates(month)).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    expect(month.key).toBe('2026-10')
    expect(periodSeconds(month)).toBe(31 * DAY)

    const quarter = currentPeriod('quarter', now)
    expect(periodDates(quarter)).toEqual({ from: '2026-10-01', to: '2026-12-31' })
    expect(quarter.key).toBe('2026-Q4')

    const rolling = currentPeriod('rolling30', now)
    expect(periodDates(rolling)).toEqual({ from: '2026-09-13', to: '2026-10-12' })
    expect(periodDays(rolling)).toHaveLength(30)
  })

  it('picks the previous complete month and week of a schedule', () => {
    const month = previousSchedulePeriod('monthly', now)!
    expect(periodDates(month)).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(month.key).toBe('2026-09')
    // On the 1st the month that just ended is due.
    expect(previousSchedulePeriod('monthly', new Date('2026-11-01T00:40:00Z'))?.key).toBe('2026-10')
    // January looks back into the previous year.
    expect(previousSchedulePeriod('monthly', new Date('2027-01-01T01:00:00Z'))?.key).toBe('2026-12')

    const week = previousSchedulePeriod('weekly', now)!
    expect(periodDates(week)).toEqual({ from: '2026-10-05', to: '2026-10-11' })
    expect(week.key).toBe('week:2026-10-05')
    // Sunday still belongs to the running week.
    expect(previousSchedulePeriod('weekly', new Date('2026-10-18T23:00:00Z'))?.key).toBe(
      'week:2026-10-05',
    )
    expect(previousSchedulePeriod('none', now)).toBeNull()
  })

  it('validates report ranges', () => {
    const range = periodFromDates('2026-09-01', '2026-09-30')!
    expect(periodSeconds(range)).toBe(SEPTEMBER)
    expect(range.key).toBe('2026-09-01..2026-09-30')
    expect(periodFromDates('2026-09-30', '2026-09-01')).toBeNull()
    expect(periodFromDates('2026-02-31', '2026-03-01')).toBeNull()
    expect(periodFromDates('2026-9-1', '2026-09-30')).toBeNull()
    expect(periodFromDates('2025-01-01', '2026-09-30')).toBeNull()
  })
})

describe('SLA maths', () => {
  const spec = { target: 99.9, calculation: 'duration' as const, excludeMaintenance: false }

  it('computes attainment and the remaining budget of a 99.9 % monthly target', () => {
    // 20 minutes down in a fully observed 30-day month.
    const f = figures({ downSeconds: 1200, knownSeconds: SEPTEMBER, elapsedSeconds: SEPTEMBER })
    const result = slaAttainment(spec, f, SEPTEMBER)
    expect(result.uptime).toBeCloseTo(1 - 1200 / SEPTEMBER, 12)
    expect(result.met).toBe(true)
    // 0.1 % of 30 days = 43.2 minutes.
    expect(result.budgetSeconds).toBeCloseTo(2592, 6)
    expect(result.consumedSeconds).toBe(1200)
    expect(result.remainingSeconds).toBeCloseTo(1392, 6)
    expect(result.remainingRatio).toBeCloseTo(1392 / 2592, 9)
    expect(result.burnRate).toBeCloseTo(1200 / 2592, 9)
    expect(slaHealth(result)).toBe('met')
  })

  it('misses the target once the downtime exceeds the budget', () => {
    const f = figures({ downSeconds: 3000, knownSeconds: SEPTEMBER, elapsedSeconds: SEPTEMBER })
    const result = slaAttainment(spec, f, SEPTEMBER)
    expect(result.met).toBe(false)
    expect(result.remainingSeconds).toBeCloseTo(-408, 6)
    expect(slaHealth(result)).toBe('missed')
  })

  it('flags a target at risk when it burns faster than the budget allows', () => {
    // Ten days in, 20 minutes down: the budget is not spent yet, but at this rate it will be.
    const elapsed = 10 * DAY
    const f = figures({ downSeconds: 1200, knownSeconds: elapsed, elapsedSeconds: elapsed })
    const result = slaAttainment(spec, f, SEPTEMBER)
    expect(result.remainingSeconds).toBeCloseTo(1392, 6)
    expect(result.burnRate).toBeCloseTo(1200 / 864, 9)
    // Below the target so far, with budget left for the rest of the period.
    expect(result.met).toBe(false)
    expect(slaHealth(result)).toBe('atRisk')
  })

  it('excludes maintenance from the uptime and the budget (duration)', () => {
    const f = figures({
      downSeconds: 1200,
      knownSeconds: SEPTEMBER,
      maintenanceSeconds: 7200,
      elapsedSeconds: SEPTEMBER,
    })
    const included = slaAttainment(spec, f, SEPTEMBER)
    const excluded = slaAttainment({ ...spec, excludeMaintenance: true }, f, SEPTEMBER)
    expect(included.uptime).toBeCloseTo(1 - 1200 / SEPTEMBER, 12)
    expect(excluded.uptime).toBeCloseTo(1 - 1200 / (SEPTEMBER - 7200), 12)
    expect(excluded.budgetSeconds).toBeCloseTo(0.001 * (SEPTEMBER - 7200), 6)
    expect(excluded.consumedSeconds).toBe(1200)
  })

  it('excludes maintenance beats from both sides in checks mode', () => {
    const f = figures({ up: 9_980, down: 20, maintenanceChecks: 100, elapsedSeconds: SEPTEMBER })
    expect(slaUptime('checks', f, false)).toBeCloseTo(9_980 / 10_000, 12)
    expect(slaUptime('checks', f, true)).toBeCloseTo(9_880 / 9_900, 12)
    const result = slaAttainment(
      { target: 99.9, calculation: 'checks', excludeMaintenance: false },
      f,
      SEPTEMBER,
    )
    // 0.2 % of the checks failed: twice the allowed error rate, applied to the observed time.
    expect(result.consumedSeconds).toBeCloseTo(0.002 * SEPTEMBER, 6)
    expect(result.burnRate).toBeCloseTo(2, 9)
    expect(result.met).toBe(false)
  })

  it('reports no data without observations', () => {
    const result = slaAttainment(spec, emptySlaFigures(), SEPTEMBER)
    expect(result.uptime).toBeNull()
    expect(result.met).toBeNull()
    expect(result.burnRate).toBeNull()
    expect(result.remainingSeconds).toBeCloseTo(2592, 6)
    expect(slaHealth(result)).toBe('nodata')
  })

  it('counts exactly the target as met', () => {
    const f = figures({ downSeconds: 2592, knownSeconds: SEPTEMBER, elapsedSeconds: SEPTEMBER })
    expect(slaAttainment(spec, f, SEPTEMBER).met).toBe(true)
  })

  it('averages the recovery time of resolved incidents', () => {
    expect(
      meanTimeToRecovery([
        { startedAt: '2026-09-03T10:00:00Z', resolvedAt: '2026-09-03T10:20:00Z' },
        { startedAt: '2026-09-10T00:00:00Z', resolvedAt: '2026-09-10T00:40:00Z' },
        { startedAt: '2026-09-20T00:00:00Z', resolvedAt: null },
      ]),
    ).toBe(1800)
    expect(meanTimeToRecovery([{ startedAt: '2026-09-20T00:00:00Z' }])).toBeNull()
  })
})

describe('slaReportCsv', () => {
  it('writes one line per target and neutralises formulas', () => {
    const csv = slaReportCsv({
      name: 'Customers',
      from: '2026-09-01',
      to: '2026-09-30',
      generatedAt: '2026-10-01T00:40:00Z',
      rows: [
        {
          targetId: '1',
          name: '=API, public',
          target: 99.9,
          calculation: 'duration',
          excludeMaintenance: true,
          uptime: 0.999537,
          downtimeSeconds: 1200,
          incidents: 1,
          mttrSeconds: 1200,
          met: true,
          budgetSeconds: 2592,
          remainingSeconds: 1392,
        },
        {
          targetId: '2',
          name: 'Website',
          target: 99.5,
          calculation: 'checks',
          excludeMaintenance: false,
          uptime: null,
          downtimeSeconds: null,
          incidents: 0,
          mttrSeconds: null,
          met: null,
          budgetSeconds: 12960,
          remainingSeconds: 12960,
        },
      ],
    })
    expect(csv.split('\r\n')).toEqual([
      'item,target_percent,uptime_percent,downtime_minutes,incidents,mttr_minutes,target_met,budget_minutes,budget_remaining_minutes',
      `"'=API, public",99.9,99.9537,20.0,1,20.0,yes,43.2,23.2`,
      'Website,99.5,,,0,,,216.0,216.0',
      '',
    ])
  })
})
