import { describe, expect, it } from 'vitest'

import type { ComponentImpact } from '@/lib/status-page-components'

import { badgeMaxAge, statusPageBadgeState, type BadgeStateInput } from './badge'

const input = (overrides: Partial<BadgeStateInput> = {}): BadgeStateInput => ({
  overall: 'up',
  groups: [],
  maintenance: [],
  ...overrides,
})

const withImpacts = (...impacts: (ComponentImpact | null)[]): BadgeStateInput['groups'] => [
  { monitors: impacts.map((impact) => ({ impact })) },
]

describe('statusPageBadgeState', () => {
  it.each([
    ['up', 'operational'],
    ['partial', 'partial'],
    ['down', 'major'],
    ['maintenance', 'maintenance'],
    ['unknown', 'unknown'],
  ] as const)('follows the page overall status %s → %s', (overall, state) => {
    expect(statusPageBadgeState(input({ overall }))).toBe(state)
  })

  it.each([
    ['degraded_performance', 'degraded'],
    ['partial_outage', 'partial'],
    ['major_outage', 'major'],
    ['operational', 'operational'],
  ] as const)('raises an operational page to the incident impact %s → %s', (impact, state) => {
    expect(statusPageBadgeState(input({ groups: withImpacts(null, impact) }))).toBe(state)
  })

  it('takes the worst impact over all components and groups', () => {
    const groups: BadgeStateInput['groups'] = [
      { monitors: [{ impact: 'degraded_performance' }] },
      {
        monitors: [{ impact: 'major_outage' }, { impact: 'partial_outage' }],
      },
    ]
    expect(statusPageBadgeState(input({ groups }))).toBe('major')
  })

  it('never lowers the overall status', () => {
    expect(
      statusPageBadgeState(input({ overall: 'down', groups: withImpacts('degraded_performance') })),
    ).toBe('major')
  })

  it('shows running maintenance, but not upcoming windows', () => {
    expect(statusPageBadgeState(input({ maintenance: [{ status: 'under-maintenance' }] }))).toBe(
      'maintenance',
    )
    expect(statusPageBadgeState(input({ maintenance: [{ status: 'scheduled' }] }))).toBe(
      'operational',
    )
    expect(
      statusPageBadgeState(
        input({ overall: 'unknown', maintenance: [{ status: 'under-maintenance' }] }),
      ),
    ).toBe('maintenance')
  })

  it('lets an outage beat maintenance', () => {
    expect(
      statusPageBadgeState(
        input({
          overall: 'maintenance',
          groups: withImpacts('partial_outage'),
          maintenance: [{ status: 'under-maintenance' }],
        }),
      ),
    ).toBe('partial')
    expect(
      statusPageBadgeState(
        input({
          groups: withImpacts('degraded_performance'),
          maintenance: [{ status: 'under-maintenance' }],
        }),
      ),
    ).toBe('degraded')
  })
})

describe('badgeMaxAge', () => {
  it('uses the auto-refresh interval, with a floor and a default', () => {
    expect(badgeMaxAge({ autoRefreshInterval: 120 })).toBe(120)
    expect(badgeMaxAge({ autoRefreshInterval: 5 })).toBe(30)
    expect(badgeMaxAge({ autoRefreshInterval: 0 })).toBe(300)
    expect(badgeMaxAge({ autoRefreshInterval: null })).toBe(300)
  })
})
