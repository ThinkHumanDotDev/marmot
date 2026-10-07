import { describe, expect, it } from 'vitest'

import {
  eventFiltersQuery,
  eventPath,
  isEventsReturnPath,
  isPublicId,
  parseEventFilters,
  randomPublicId,
} from './status-page-events'

describe('public ids', () => {
  it('are 8 base36 characters and practically unique', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => randomPublicId()))
    expect(ids.size).toBe(2000)
    for (const id of ids) expect(isPublicId(id)).toBe(true)
  })

  it('rejects anything else', () => {
    for (const value of ['', 'ABCDEFGH', 'abc', 'abcdefghi', 'abcd-fgh', 12345678, null]) {
      expect(isPublicId(value)).toBe(false)
    }
  })
})

describe('event paths', () => {
  it('builds permalinks below the page', () => {
    expect(eventPath('incident', 'k3x9a0b1')).toBe('/events/incident/k3x9a0b1')
    expect(eventPath('maintenance', 'k3x9a0b1')).toBe('/events/maintenance/k3x9a0b1')
  })

  it('only accepts the history and permalinks as login return paths', () => {
    expect(isEventsReturnPath('/events')).toBe(true)
    expect(isEventsReturnPath('/events/incident/k3x9a0b1')).toBe(true)
    expect(isEventsReturnPath('/events/maintenance/k3x9a0b1')).toBe(true)
    for (const value of [
      '//evil.example',
      'https://evil.example/events',
      '/events/incident/K3X9A0B1',
      '/events/incident/k3x9a0b1/../../admin',
      '/events?x=1',
      '/admin',
      '',
      null,
    ]) {
      expect(isEventsReturnPath(value), String(value)).toBe(false)
    }
  })
})

describe('history filters', () => {
  it('parses known values and drops malformed ones', () => {
    expect(
      parseEventFilters(
        new URLSearchParams('type=incident&component=abc_1-2&month=2026-09&page=3'),
      ),
    ).toEqual({ type: 'incident', component: 'abc_1-2', month: '2026-09', page: 3 })
    expect(
      parseEventFilters({ type: 'other', component: 'a b', month: '2026-13', page: '-1' }),
    ).toEqual({ type: null, component: null, month: null, page: 1 })
    expect(parseEventFilters({ type: ['maintenance', 'incident'] }).type).toBe('maintenance')
  })

  it('serialises without defaults', () => {
    expect(eventFiltersQuery({ type: null, component: null, month: null, page: 1 })).toBe('')
    expect(eventFiltersQuery({ type: 'maintenance', month: '2026-01', page: 2 })).toBe(
      'type=maintenance&month=2026-01&page=2',
    )
  })
})
