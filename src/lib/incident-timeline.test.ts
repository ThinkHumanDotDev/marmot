import { describe, expect, it } from 'vitest'

import {
  deriveIncidentState,
  impactFromLegacyStyle,
  incidentTimeline,
  legacyStyleFromImpact,
  worstImpact,
  type TimelineUpdate,
} from './incident-timeline'

const at = (minute: number) => new Date(Date.UTC(2026, 9, 7, 10, minute)).toISOString()

describe('incident timeline', () => {
  it('keeps the last impact of components an update leaves out', () => {
    const updates: TimelineUpdate[] = [
      {
        status: 'investigating',
        postedAt: at(0),
        components: [
          { component: 'c1', impact: 'major_outage' },
          { component: 'c2', impact: 'degraded_performance' },
        ],
      },
      { status: 'identified', postedAt: at(5), components: [] },
      {
        status: 'monitoring',
        postedAt: at(10),
        components: [{ component: 'c1', impact: 'partial_outage' }],
      },
    ]
    expect(deriveIncidentState(updates)).toEqual({
      status: 'monitoring',
      impact: 'partial_outage',
      active: true,
      resolvedAt: null,
      components: [
        { component: 'c1', impact: 'partial_outage' },
        { component: 'c2', impact: 'degraded_performance' },
      ],
    })
  })

  it('resets every component when resolved, and reopening keeps them operational', () => {
    const updates: TimelineUpdate[] = [
      {
        status: 'investigating',
        postedAt: at(0),
        components: [{ component: 'a', impact: 'major_outage' }],
      },
      { status: 'resolved', postedAt: at(30) },
    ]
    const resolved = deriveIncidentState(updates)
    expect(resolved).toMatchObject({ status: 'resolved', impact: 'operational', active: false })
    expect(resolved.resolvedAt).toBe(at(30))
    expect(resolved.components).toEqual([{ component: 'a', impact: 'operational' }])

    const reopened = deriveIncidentState([
      ...updates,
      { status: 'investigating', postedAt: at(40) },
    ])
    expect(reopened).toMatchObject({ active: true, impact: 'operational', resolvedAt: null })
  })

  it('orders updates by postedAt, then by position', () => {
    const updates: TimelineUpdate[] = [
      { status: 'resolved', postedAt: at(20) },
      {
        status: 'investigating',
        postedAt: at(0),
        components: [{ component: 'c1', impact: 'major_outage' }],
      },
      { status: 'identified', postedAt: at(20) },
    ]
    // The two updates at minute 20 apply in stored order: resolved, then identified.
    expect(deriveIncidentState(updates)).toMatchObject({
      status: 'identified',
      active: true,
      impact: 'operational',
    })
  })

  it('uses the declared impact when no component is affected', () => {
    expect(
      deriveIncidentState([{ status: 'investigating', postedAt: at(0) }], 'major_outage'),
    ).toMatchObject({ impact: 'major_outage' })
    expect(
      deriveIncidentState(
        [
          { status: 'investigating', postedAt: at(0) },
          { status: 'resolved', postedAt: at(1) },
        ],
        'major_outage',
      ),
    ).toMatchObject({ impact: 'operational' })
  })

  it('maps legacy styles to impacts and back', () => {
    expect(impactFromLegacyStyle('info')).toBe('operational')
    expect(impactFromLegacyStyle('primary')).toBe('operational')
    expect(impactFromLegacyStyle('warning')).toBe('degraded_performance')
    expect(impactFromLegacyStyle('danger')).toBe('major_outage')
    expect(impactFromLegacyStyle(null)).toBe('operational')
    for (const style of ['info', 'warning', 'danger'] as const) {
      expect(legacyStyleFromImpact(impactFromLegacyStyle(style))).toBe(style)
    }
    expect(worstImpact([])).toBe('operational')
    expect(worstImpact(['degraded_performance', 'major_outage', 'partial_outage'])).toBe(
      'major_outage',
    )
  })

  it('reads incidents stored before the timeline as one update', () => {
    const active = incidentTimeline({
      content: 'Old text',
      style: 'danger',
      active: true,
      createdAt: at(0),
      updatedAt: at(5),
    })
    expect(active.updates).toEqual([
      {
        id: 'legacy',
        status: 'investigating',
        message: 'Old text',
        postedAt: at(0),
        components: [],
      },
    ])
    expect(active.state).toMatchObject({ impact: 'major_outage', active: true })

    const resolved = incidentTimeline({
      content: 'Done',
      style: 'warning',
      active: false,
      createdAt: at(0),
      resolvedAt: at(9),
    })
    expect(resolved.updates[0]).toMatchObject({ status: 'resolved', postedAt: at(9) })
    expect(resolved.state).toMatchObject({ active: false, resolvedAt: at(9) })
  })
})
