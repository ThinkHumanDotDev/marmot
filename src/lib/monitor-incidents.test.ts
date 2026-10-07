import { describe, expect, it } from 'vitest'

import {
  incidentActionForBeat,
  incidentDurationSeconds,
  summarizeIncidents,
  timeToAcknowledgeSeconds,
} from './monitor-incidents'

describe('incidentActionForBeat', () => {
  it('acts on transitions only', () => {
    expect(incidentActionForBeat({ status: 'down', important: false })).toBeNull()
    expect(incidentActionForBeat({ status: 'up', important: false })).toBeNull()
    expect(incidentActionForBeat({ status: 'down', important: true })).toBe('open')
    expect(incidentActionForBeat({ status: 'maintenance', important: true })).toBe('maintenance')
    expect(incidentActionForBeat({ status: 'up', important: true })).toBe('resolve')
    // Degraded (#93) means the check works again.
    expect(incidentActionForBeat({ status: 'degraded', important: true })).toBe('resolve')
    expect(incidentActionForBeat({ status: 'pending', important: true })).toBeNull()
  })
})

describe('durations and summary', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 7, 10, minutes)).toISOString()

  it('measures ongoing and resolved incidents', () => {
    expect(incidentDurationSeconds({ startedAt: at(0), resolvedAt: at(30) })).toBe(1800)
    expect(incidentDurationSeconds({ startedAt: at(0), resolvedAt: null }, Date.parse(at(5)))).toBe(
      300,
    )
    expect(timeToAcknowledgeSeconds({ startedAt: at(0), acknowledgedAt: null })).toBeNull()
    expect(timeToAcknowledgeSeconds({ startedAt: at(0), acknowledgedAt: at(2) })).toBe(120)
  })

  it('computes MTTA over acknowledged and MTTR over resolved incidents', () => {
    const stats = summarizeIncidents([
      { status: 'resolved', startedAt: at(0), acknowledgedAt: at(4), resolvedAt: at(10) },
      { status: 'resolved', startedAt: at(0), acknowledgedAt: null, resolvedAt: at(30) },
      { status: 'acknowledged', startedAt: at(0), acknowledgedAt: at(2), resolvedAt: null },
      { status: 'open', startedAt: at(0), acknowledgedAt: null, resolvedAt: null },
    ])
    expect(stats).toEqual({
      total: 4,
      open: 1,
      acknowledged: 1,
      resolved: 2,
      mtta: 180,
      mttr: 1200,
    })
    expect(summarizeIncidents([])).toMatchObject({ total: 0, mtta: null, mttr: null })
  })
})
