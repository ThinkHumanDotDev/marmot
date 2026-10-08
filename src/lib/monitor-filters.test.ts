import { describe, expect, it } from 'vitest'

import {
  EMPTY_FILTERS,
  hasActiveFilters,
  matchesMonitorFilters,
  parseMonitorFilters,
  parseSearchQuery,
  serializeMonitorFilters,
  statusFilterOf,
  type FilterableMonitor,
  type MonitorFilters,
} from './monitor-filters'

const checkout: FilterableMonitor = {
  name: 'Checkout API',
  type: 'http',
  active: true,
  url: 'https://shop.example.com/api/checkout',
  description: 'Payment flow of the Café shop',
  tags: [
    { id: '1', name: 'prod', value: null },
    { id: '2', name: 'env', value: 'eu' },
  ],
  notifications: ['10'],
  locations: ['7'],
  includeLocal: true,
}

const db: FilterableMonitor = {
  name: 'Database',
  type: 'port',
  active: false,
  hostname: 'db.internal',
  tags: [],
  notifications: [],
  locations: [],
}

const filters = (patch: Partial<MonitorFilters>): MonitorFilters => ({ ...EMPTY_FILTERS, ...patch })

describe('monitor filters', () => {
  it('round-trips through the query string and drops unknown statuses', () => {
    const parsed = parseMonitorFilters(
      new URLSearchParams('q=api&status=down,bogus&status=up&tag=1,1&type=http&location=local'),
    )
    expect(parsed).toEqual({
      q: 'api',
      status: ['down', 'up'],
      type: ['http'],
      tag: ['1'],
      notification: [],
      location: ['local'],
    })
    expect(serializeMonitorFilters(parsed).toString()).toBe(
      'q=api&status=down%2Cup&type=http&tag=1&location=local',
    )
    expect(parseMonitorFilters({ status: ['paused'], q: undefined }).status).toEqual(['paused'])
    expect(serializeMonitorFilters(EMPTY_FILTERS).toString()).toBe('')
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false)
    expect(hasActiveFilters(filters({ tag: ['1'] }))).toBe(true)
  })

  it('maps live statuses to filter values', () => {
    expect(statusFilterOf(false, 'down')).toBe('paused')
    expect(statusFilterOf(true, 'degraded')).toBe('degraded')
    expect(statusFilterOf(true, 'unknown')).toBeNull()
  })

  it('searches name, target and description, case- and accent-insensitively', () => {
    const match = (q: string, m = checkout) => matchesMonitorFilters(m, 'up', filters({ q }))
    expect(match('checkout')).toBe(true)
    expect(match('SHOP.EXAMPLE')).toBe(true)
    expect(match('cafe')).toBe(true)
    expect(match('checkout payment')).toBe(true)
    expect(match('checkout nope')).toBe(false)
    expect(match('db.internal', db)).toBe(true)
    // Fuzzy: the letters of the name in order, from three characters on.
    expect(match('chkapi')).toBe(true)
    expect(match('cpi')).toBe(true)
    expect(match('ci')).toBe(false)
  })

  it('combines filters with AND and their values with OR', () => {
    expect(matchesMonitorFilters(checkout, 'down', filters({ status: ['down', 'up'] }))).toBe(true)
    expect(matchesMonitorFilters(checkout, 'up', filters({ status: ['down'] }))).toBe(false)
    expect(matchesMonitorFilters(checkout, 'unknown', filters({ status: ['up'] }))).toBe(false)
    expect(matchesMonitorFilters(db, 'down', filters({ status: ['paused'] }))).toBe(true)
    expect(matchesMonitorFilters(checkout, 'down', filters({ status: ['down'], tag: ['1'] }))).toBe(
      true,
    )
    expect(
      matchesMonitorFilters(checkout, 'down', filters({ status: ['down'], type: ['port'] })),
    ).toBe(false)
    expect(matchesMonitorFilters(checkout, 'up', filters({ notification: ['10'] }))).toBe(true)
    expect(matchesMonitorFilters(db, 'up', filters({ notification: ['10'] }))).toBe(false)
  })

  it('filters by location, the local worker pool included', () => {
    expect(matchesMonitorFilters(checkout, 'up', filters({ location: ['7'] }))).toBe(true)
    expect(matchesMonitorFilters(checkout, 'up', filters({ location: ['local'] }))).toBe(true)
    expect(matchesMonitorFilters(db, 'up', filters({ location: ['local'] }))).toBe(true)
    expect(matchesMonitorFilters(db, 'up', filters({ location: ['7'] }))).toBe(false)
    const remoteOnly = { ...checkout, includeLocal: false }
    expect(matchesMonitorFilters(remoteOnly, 'up', filters({ location: ['local'] }))).toBe(false)
  })

  it('understands filter tokens in the search box', () => {
    expect(parseSearchQuery('status:down tag:prod  api')).toEqual({
      terms: ['api'],
      tokens: { status: ['down'], type: [], tag: ['prod'], location: [] },
    })
    const lookups = { locationNames: { '7': 'Berlin' } }
    const match = (q: string, live: 'up' | 'down' = 'down', m = checkout) =>
      matchesMonitorFilters(m, live, filters({ q }), lookups)
    expect(match('status:down tag:prod')).toBe(true)
    expect(match('status:down tag:prod', 'up')).toBe(false)
    expect(match('tag:eu')).toBe(true)
    expect(match('tag:env:eu')).toBe(true)
    expect(match('tag:staging')).toBe(false)
    expect(match('type:HTTP')).toBe(true)
    expect(match('is:paused', 'up', db)).toBe(true)
    expect(match('location:berlin')).toBe(true)
    expect(match('location:local', 'up', db)).toBe(true)
    expect(match('location:paris')).toBe(false)
    // Unknown keys stay plain search text.
    expect(parseSearchQuery('https://x').terms).toEqual(['https://x'])
  })
})
