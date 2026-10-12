import { describe, expect, it } from 'vitest'

import {
  DAY_SECONDS,
  componentImpactSpans,
  dayState,
  downtimeOf,
  emptyFigures,
  impactWithin,
  monthlyHistoryCsv,
  replayStatuses,
  uptimeBarDaysOf,
  uptimeOf,
  windowDays,
  type DayFigures,
} from './uptime-history'

const H = 3600 * 1000
const day0 = Date.UTC(2026, 9, 6)

describe('uptime calculation modes', () => {
  // 90 of 100 checks succeeded, 6 h of 24 h were DOWN, incidents weigh 3 h.
  const figures: DayFigures = {
    up: 90,
    down: 10,
    downSeconds: 6 * 3600,
    knownSeconds: 24 * 3600,
    impactSeconds: 3 * 3600,
    elapsedSeconds: 24 * 3600,
  }

  it('gives each mode its own deterministic figure', () => {
    expect(uptimeOf('checks', figures)).toBeCloseTo(0.9, 10)
    expect(uptimeOf('duration', figures)).toBeCloseTo(0.75, 10)
    expect(uptimeOf('manual', figures)).toBeCloseTo(0.875, 10)
  })

  it('has no figure without data, and reports the mode’s downtime', () => {
    expect(uptimeOf('checks', emptyFigures())).toBeNull()
    expect(uptimeOf('duration', emptyFigures())).toBeNull()
    expect(uptimeOf('manual', emptyFigures())).toBeNull()
    expect(downtimeOf('checks', figures)).toBe(6 * 3600)
    expect(downtimeOf('duration', figures)).toBe(6 * 3600)
    expect(downtimeOf('manual', figures)).toBe(3 * 3600)
  })

  it('accepts 30, 45 and 90 bars only', () => {
    expect(uptimeBarDaysOf(45)).toBe(45)
    expect(uptimeBarDaysOf(60)).toBe(90)
    expect(uptimeBarDaysOf(null)).toBe(90)
  })
})

describe('replayStatuses', () => {
  it('counts the time spent DOWN between transitions', () => {
    const replay = replayStatuses(
      'up',
      [
        { time: day0 + 6 * H, status: 'down' },
        { time: day0 + 12 * H, status: 'up' },
      ],
      day0,
      day0 + 24 * H,
    )
    expect(replay.downSeconds).toBe(6 * 3600)
    expect(replay.knownSeconds).toBe(24 * 3600)
    expect([...replay.held].sort()).toEqual(['down', 'up'])
  })

  it('leaves the time before the first transition out when the start is unknown', () => {
    const replay = replayStatuses(
      null,
      [{ time: day0 + 18 * H, status: 'down' }],
      day0,
      day0 + 24 * H,
    )
    expect(replay.knownSeconds).toBe(6 * 3600)
    expect(replay.downSeconds).toBe(6 * 3600)
  })

  it('applies transitions before the interval to its start', () => {
    const replay = replayStatuses(
      'up',
      [{ time: day0 - 2 * H, status: 'down' }],
      day0,
      day0 + 24 * H,
    )
    expect(replay.downSeconds).toBe(24 * 3600)
  })
})

describe('incident impacts', () => {
  const at = (hours: number) => new Date(day0 + hours * H).toISOString()

  it('derives spans from the timeline and weighs overlaps by the worst impact', () => {
    const major = componentImpactSpans(
      [
        {
          status: 'investigating',
          postedAt: at(0),
          components: [{ component: 'c1', impact: 'major_outage' }],
        },
        { status: 'resolved', postedAt: at(2), components: [] },
      ],
      'c1',
    )
    const partial = componentImpactSpans(
      [
        {
          status: 'identified',
          postedAt: at(1),
          components: [{ component: 'c1', impact: 'partial_outage' }],
        },
        {
          status: 'monitoring',
          postedAt: at(3),
          components: [{ component: 'c1', impact: 'degraded_performance' }],
        },
        { status: 'resolved', postedAt: at(5), components: [] },
      ],
      'c1',
    )
    expect(major).toEqual([{ start: day0, end: day0 + 2 * H, impact: 'major_outage' }])
    expect(partial).toHaveLength(2)
    // 0–2 h major (1), 2–3 h partial (0.5), 3–5 h degraded (0): 2.5 h.
    const result = impactWithin([...major, ...partial], day0, day0 + 24 * H)
    expect(result.impactSeconds).toBe(2.5 * 3600)
    expect(result.worst).toBe('major_outage')
    expect(
      componentImpactSpans([{ status: 'investigating', postedAt: at(0), components: [] }], 'c1'),
    ).toEqual([])
  })

  it('keeps an unresolved impact open until the end of the interval', () => {
    const spans = componentImpactSpans(
      [
        {
          status: 'investigating',
          postedAt: at(20),
          components: [{ component: 'c1', impact: 'partial_outage' }],
        },
      ],
      'c1',
    )
    expect(impactWithin(spans, day0, day0 + 24 * H).impactSeconds).toBe(2 * 3600)
  })
})

describe('day state and windows', () => {
  it('colours a day by its worst state', () => {
    expect(dayState({ hasData: false })).toBe('nodata')
    expect(dayState({ hasData: true })).toBe('up')
    expect(dayState({ hasData: true, degradedChecks: 2 })).toBe('degraded')
    expect(dayState({ hasData: true, held: ['maintenance'], impact: 'partial_outage' })).toBe(
      'partial',
    )
    expect(dayState({ hasData: true, held: ['down'], impact: 'degraded_performance' })).toBe('down')
    expect(dayState({ hasData: false, impact: 'major_outage' })).toBe('down')
  })

  it('lists the window’s UTC days ending today', () => {
    const days = windowDays(90, new Date(day0 + 5 * H))
    expect(days).toHaveLength(90)
    expect(days.at(-1)).toBe(day0 / 1000)
    expect(days[1] - days[0]).toBe(DAY_SECONDS)
  })

  it('exports the monthly history as CSV and neutralises formulas', () => {
    const csv = monthlyHistoryCsv([
      {
        month: '2026-10',
        componentId: 'c1',
        component: '=API, EU',
        uptime: 0.999,
        downtimeSeconds: 86.4,
        days: 10,
      },
      {
        month: '2026-09',
        componentId: 'c1',
        component: 'API',
        uptime: null,
        downtimeSeconds: null,
        days: 0,
      },
    ])
    expect(csv.split('\r\n')).toEqual([
      'month,component_id,component,uptime_percent,downtime_seconds,days',
      `2026-10,c1,"'=API, EU",99.9000,86,10`,
      '2026-09,c1,API,,,0',
      '',
    ])
  })
})
