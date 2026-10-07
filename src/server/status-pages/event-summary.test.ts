import { describe, expect, it } from 'vitest'

import { dayKey, lastDays, monthRange, pastIncidentDays } from './event-summary'
import type { PublicIncident } from './public'

const incident = (id: string, startedAt: string, active = false): PublicIncident => ({
  id,
  publicId: `${id}0000000`.slice(0, 8),
  title: `Incident ${id}`,
  status: active ? 'investigating' : 'resolved',
  impact: 'operational',
  components: [],
  updates: [
    ...(active
      ? []
      : [
          {
            id: `${id}-2`,
            status: 'resolved' as const,
            message: 'Fixed',
            postedAt: startedAt,
            editedAt: null,
            components: [{ id: 'c1', name: 'API', impact: 'operational' as const }],
          },
        ]),
    {
      id: `${id}-1`,
      status: 'investigating',
      message: 'Looking',
      postedAt: startedAt,
      editedAt: null,
      components: [{ id: 'c1', name: 'API', impact: 'major_outage' }],
    },
  ],
  content: '',
  style: 'info',
  pinned: false,
  active,
  startedAt,
  createdAt: startedAt,
  updatedAt: startedAt,
  resolvedAt: active ? null : startedAt,
})

describe('calendar helpers', () => {
  it('lists the last days in the zone, across DST changes', () => {
    // Europe/Berlin leaves DST on 2026-10-25.
    const now = new Date('2026-10-26T10:00:00Z')
    expect(lastDays(4, 'Europe/Berlin', now)).toEqual([
      '2026-10-26',
      '2026-10-25',
      '2026-10-24',
      '2026-10-23',
    ])
    // 23:30 UTC is already the next day in Tokyo.
    expect(lastDays(1, 'Asia/Tokyo', new Date('2026-10-26T23:30:00Z'))).toEqual(['2026-10-27'])
  })

  it('computes month ranges in the zone', () => {
    const { start, end } = monthRange('2026-12', 'America/New_York')
    expect(start.toISOString()).toBe('2026-12-01T05:00:00.000Z')
    expect(end.toISOString()).toBe('2027-01-01T05:00:00.000Z')
  })
})

describe('pastIncidentDays', () => {
  it('groups incidents by start day, keeps quiet days and drops older ones', () => {
    const now = new Date('2026-10-07T12:00:00Z')
    const days = pastIncidentDays(
      [
        incident('a', '2026-10-07T09:00:00Z', true),
        incident('b', '2026-10-05T23:30:00Z'), // 2026-10-06 in Berlin
        incident('c', '2026-10-05T08:00:00Z'),
        incident('d', '2026-09-01T08:00:00Z'),
      ],
      3,
      'Europe/Berlin',
      now,
    )
    expect(days.map((d) => [d.date, d.incidents.map((i) => i.title)])).toEqual([
      ['2026-10-07', ['Incident a']],
      ['2026-10-06', ['Incident b']],
      ['2026-10-05', ['Incident c']],
    ])
    expect(dayKey(days[1].start, 'Europe/Berlin')).toBe('2026-10-06')
    const [resolved] = days[1].incidents
    // The worst impact the incident had, its components and its latest update.
    expect(resolved).toMatchObject({
      kind: 'incident',
      impact: 'major_outage',
      ongoing: false,
      end: '2026-10-05T23:30:00Z',
      components: [{ id: 'c1', name: 'API' }],
      latest: { status: 'resolved', message: 'Fixed' },
    })
    expect(days[0].incidents[0]).toMatchObject({ ongoing: true, end: null })
  })
})
