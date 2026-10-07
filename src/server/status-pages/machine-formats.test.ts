import { describe, expect, it } from 'vitest'

import { customDomainSuffix, markdownAliasRewrite } from '@/proxy'
import { maintenanceWindowsBetween } from '@/server/maintenance/status'

import { statusSince } from './feed'
import { escapeIcalText, foldLine, icalDate } from './ical'
import { announcedMaintenance, type MaintenanceEvent } from './maintenance-events'
import { escapeMarkdown } from './markdown-output'
import { componentStatus, impactIndicator, pageStatus, type SpComponent } from './statuspage'
import { incidentPermalink, statusPageLinks } from './urls'

describe('iCalendar helpers', () => {
  it('escapes TEXT values', () => {
    expect(escapeIcalText('a,b;c\\d\nnext')).toBe('a\\,b\\;c\\\\d\\nnext')
  })

  it('folds lines at 75 octets without splitting UTF-8 characters', () => {
    const line = `SUMMARY:${'é'.repeat(80)}`
    const folded = foldLine(line)
    const parts = folded.split('\r\n')
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75)
    expect(parts.slice(1).every((p) => p.startsWith(' '))).toBe(true)
    expect(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join('')).toBe(line)
    expect(foldLine('SHORT:x')).toBe('SHORT:x')
  })

  it('formats UTC date-times', () => {
    expect(icalDate('2026-10-07T02:30:00.000Z')).toBe('20261007T023000Z')
  })
})

describe('maintenance windows', () => {
  const from = new Date('2026-10-01T00:00:00Z')
  const to = new Date('2026-10-08T00:00:00Z')

  it('lists every daily occurrence in a range, including one already running', () => {
    const windows = maintenanceWindowsBetween(
      {
        strategy: 'recurring-interval',
        intervalDay: 1,
        timeRange: { start: '23:00', end: '01:00' },
        timezone: 'UTC',
        dateRange: { start: '2026-09-01T00:00', end: null },
      },
      from,
      to,
    )
    expect(windows[0]).toEqual({
      start: '2026-09-30T23:00:00.000Z',
      end: '2026-10-01T01:00:00.000Z',
    })
    expect(windows).toHaveLength(8)
  })

  it('returns the single window only when it overlaps, and nothing for manual', () => {
    const single = {
      strategy: 'single',
      timezone: 'UTC',
      dateRange: { start: '2026-10-03T10:00', end: '2026-10-03T12:00' },
    }
    expect(maintenanceWindowsBetween(single, from, to)).toHaveLength(1)
    expect(maintenanceWindowsBetween(single, to, new Date('2026-11-01T00:00:00Z'))).toEqual([])
    expect(maintenanceWindowsBetween({ strategy: 'manual' }, from, to)).toEqual([])
  })

  it('announces running windows and the next window of each maintenance', () => {
    const base = {
      title: 't',
      description: null,
      timezone: 'UTC',
      monitorIds: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      sequence: 0,
      end: null,
    }
    const events: MaintenanceEvent[] = [
      { ...base, id: 'a-1', maintenanceId: 'a', status: 'in_progress', start: '2026-10-01T00:00Z' },
      { ...base, id: 'a-2', maintenanceId: 'a', status: 'scheduled', start: '2026-10-02T00:00Z' },
      { ...base, id: 'b-1', maintenanceId: 'b', status: 'scheduled', start: '2026-10-03T00:00Z' },
      { ...base, id: 'b-2', maintenanceId: 'b', status: 'scheduled', start: '2026-10-04T00:00Z' },
      { ...base, id: 'c', maintenanceId: 'c', status: 'scheduled', start: '2026-12-01T00:00Z' },
    ]
    const shown = announcedMaintenance(events, new Date('2026-10-01T01:00:00Z'))
    expect(shown.map((e) => e.id)).toEqual(['a-1', 'b-1'])
  })
})

describe('Statuspage mapping', () => {
  it('maps monitor state and incident impact to component statuses', () => {
    expect(componentStatus({ status: 'up', impact: null })).toBe('operational')
    expect(componentStatus({ status: 'unknown', impact: null })).toBe('operational')
    expect(componentStatus({ status: 'pending', impact: null })).toBe('degraded_performance')
    expect(componentStatus({ status: 'down', impact: null })).toBe('major_outage')
    expect(componentStatus({ status: 'maintenance', impact: null })).toBe('under_maintenance')
    expect(componentStatus({ status: 'up', impact: 'partial_outage' })).toBe('partial_outage')
    expect(componentStatus({ status: 'down', impact: 'degraded_performance' })).toBe('major_outage')
    expect(componentStatus({ status: 'maintenance', impact: 'major_outage' })).toBe('major_outage')
  })

  it('maps impacts to indicators', () => {
    expect(impactIndicator('operational')).toBe('none')
    expect(impactIndicator('degraded_performance')).toBe('minor')
    expect(impactIndicator('partial_outage')).toBe('major')
    expect(impactIndicator('major_outage')).toBe('critical')
  })

  it('derives the page indicator from components and active incidents', () => {
    const c = (status: SpComponent['status']) => ({ status, group: false }) as SpComponent
    expect(pageStatus([c('operational')], [], 'en', false)).toEqual({
      indicator: 'none',
      description: 'All Systems Operational',
    })
    expect(pageStatus([c('operational')], [], 'en', true).description).toBe(
      'Service Under Maintenance',
    )
    expect(pageStatus([c('degraded_performance')], [], 'en', false).indicator).toBe('minor')
    expect(pageStatus([c('major_outage'), c('operational')], [], 'en', false).indicator).toBe(
      'major',
    )
    expect(pageStatus([c('major_outage')], [], 'en', false).indicator).toBe('critical')
    expect(pageStatus([c('operational')], ['major_outage'], 'en', false).indicator).toBe('critical')
  })
})

describe('links and rewrites', () => {
  it('builds links for the main host and custom domains', () => {
    const main = statusPageLinks('https://m.example/status/acme', false)
    expect(main.markdown).toBe('https://m.example/status/acme.md')
    expect(main.api('scheduled-maintenances')).toBe(
      'https://m.example/status/acme/api/v2/scheduled-maintenances.json',
    )
    expect(main.incidentMarkdown(7)).toBe('https://m.example/status/acme/incidents/7.md')
    const custom = statusPageLinks('https://status.acme.com', true)
    expect(custom.markdown).toBe('https://status.acme.com/index.md')
    expect(custom.incident('a b')).toBe('https://status.acme.com/incidents/a%20b')
    expect(incidentPermalink('https://x', 1)).toBe('https://x/incidents/1')
  })

  it('rewrites Markdown aliases and custom-domain paths', () => {
    expect(markdownAliasRewrite('/status/acme.md')).toBe('/status/acme/index.md')
    expect(markdownAliasRewrite('/status/acme/incidents/42.md')).toBe('/status/acme/incident-md/42')
    expect(markdownAliasRewrite('/status/acme')).toBeNull()
    expect(markdownAliasRewrite('/status/acme/rss')).toBeNull()

    expect(customDomainSuffix('/')).toBe('')
    expect(customDomainSuffix('/feed/atom')).toBe('/feed/atom')
    expect(customDomainSuffix('/api/v2/summary.json')).toBe('/api/v2/summary.json')
    expect(customDomainSuffix('/incidents/42.md')).toBe('/incident-md/42')
    expect(customDomainSuffix('/incidents/42')).toBe('/incidents/42')
    expect(customDomainSuffix('/api/v2/other.json')).toBeNull()
    expect(customDomainSuffix('/admin')).toBeNull()
    expect(customDomainSuffix('/constructor')).toBeNull()
  })
})

describe('text helpers', () => {
  it('escapes Markdown syntax in plain text', () => {
    expect(escapeMarkdown('*bold* [x](y) # <b>')).toBe('\\*bold\\* \\[x\\](y) \\# \\<b\\>')
  })

  it('finds the start of the current streak', () => {
    const beats = [
      { status: 'up' as const, time: 'a' },
      { status: 'down' as const, time: 'b' },
      { status: 'down' as const, time: 'c' },
    ]
    expect(statusSince(beats, 'down')).toBe('b')
    expect(statusSince(beats, 'up')).toBeNull()
  })
})
