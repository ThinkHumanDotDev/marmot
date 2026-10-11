import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  feedLinkFromHtml,
  indicatorToStatus,
  parseAtlassian,
  parseBetterStack,
  parseFeed,
  parseIncidentIo,
  parseInstatus,
  vendorVerdict,
  VendorFormatError,
} from './vendor-status'

const fixture = (name: string): string =>
  readFileSync(join(__dirname, '__fixtures__/status-pages', name), 'utf8')
const json = (name: string): unknown => JSON.parse(fixture(name))

describe('Atlassian Statuspage summary', () => {
  const status = parseAtlassian(json('atlassian-summary.json'))

  it('reads the page indicator, the components (not groups) and the open incidents', () => {
    expect(status.provider).toBe('atlassian')
    expect(status.pageName).toBe('GitHub')
    expect(status.indicator).toBe('major')
    expect(status.components.map((c) => [c.id, c.indicator])).toEqual([
      ['8l4ygp009s5s', 'none'],
      ['brv1bkgrwx7q', 'none'],
      ['br0l2tvcx85d', 'major'],
      ['st3j38cctv9l', 'minor'],
      ['h2ftsgbw7kmk', 'maintenance'],
    ])
    // The scheduled (not started) maintenance is left out.
    expect(status.incidents.map((i) => [i.title, i.indicator, i.componentIds])).toEqual([
      ['Disruption with some GitHub Actions workflows', 'major', ['br0l2tvcx85d']],
      ['Packages database upgrade', 'maintenance', ['h2ftsgbw7kmk']],
    ])
  })

  it('goes DOWN when the filtered component reports a major outage, with the incident and its link', () => {
    const verdict = vendorVerdict(status, [{ id: 'br0l2tvcx85d', name: 'Actions' }])
    expect(verdict.status).toBe('down')
    expect(verdict.msg).toBe(
      'Actions · Major outage: Disruption with some GitHub Actions workflows (https://stspg.io/abc123def)',
    )
  })

  it('matches by id, so a renamed component keeps matching', () => {
    const verdict = vendorVerdict(status, [{ id: 'st3j38cctv9l', name: 'GitHub Pages (old name)' }])
    expect(verdict.status).toBe('degraded')
    expect(verdict.msg).toBe('Pages · Degraded')
  })

  it('reports a component id that disappeared instead of showing it as up', () => {
    const verdict = vendorVerdict(status, [
      { id: '8l4ygp009s5s', name: 'Git Operations' },
      { id: 'gone0000000', name: 'Webhooks' },
    ])
    expect(verdict.status).toBe('up')
    expect(verdict.missing).toEqual([{ id: 'gone0000000', name: 'Webhooks' }])
    expect(verdict.msg).toContain('component no longer on the status page: Webhooks (gone0000000)')
  })

  it('uses the whole page without a filter, and maintenance maps to maintenance', () => {
    expect(vendorVerdict(status, []).status).toBe('down')
    expect(vendorVerdict(status, [{ id: 'h2ftsgbw7kmk' }]).status).toBe('maintenance')
  })

  it('refuses a document that is not a summary', () => {
    expect(() => parseAtlassian({ hello: 'world' })).toThrow(VendorFormatError)
  })
})

describe('Instatus', () => {
  const status = parseInstatus(json('instatus-summary.json'), json('instatus-components.json'))

  it('flattens component groups and ignores maintenances that have not started', () => {
    expect(status.pageName).toBe('Acme Cloud')
    expect(status.indicator).toBe('minor')
    expect(status.components.map((c) => [c.id, c.name, c.indicator])).toEqual([
      ['cl7a1b2c3d0001', 'Dashboard', 'none'],
      ['cl7a1b2c3d0011', 'API (EU)', 'major'],
      ['cl7a1b2c3d0012', 'API (US)', 'none'],
    ])
    expect(status.incidents).toHaveLength(1)
  })

  it('maps component outages', () => {
    expect(vendorVerdict(status, [{ id: 'cl7a1b2c3d0011' }]).status).toBe('down')
    expect(vendorVerdict(status, [{ id: 'cl7a1b2c3d0012' }]).status).toBe('up')
    // The page has issues and an open major incident.
    const page = vendorVerdict(status, [])
    expect(page.status).toBe('down')
    expect(page.msg).toBe(
      'Major outage: Elevated error rates on the EU API (https://status.acme-cloud.example/incident/clx9k2m3n0001abcd)',
    )
  })
})

describe('Better Stack', () => {
  const status = parseBetterStack(json('betterstack-index.json'), 'https://status.example.com/')

  it('reads resources and open status reports', () => {
    expect(status.pageName).toBe('Example Ltd')
    expect(status.indicator).toBe('minor')
    expect(status.components).toEqual([
      { id: '8001', name: 'Website', indicator: 'none' },
      { id: '8002', name: 'Checkout API', indicator: 'minor' },
    ])
    expect(status.incidents).toEqual([
      {
        title: 'Slow checkout responses',
        url: 'https://status.example.com/incident/9001',
        indicator: 'minor',
        componentIds: ['8002'],
      },
    ])
    expect(vendorVerdict(status, [{ id: '8002' }]).status).toBe('degraded')
    expect(vendorVerdict(status, [{ id: '8001' }]).status).toBe('up')
  })
})

describe('incident.io', () => {
  const status = parseIncidentIo(json('incidentio-widget.json'))

  it('combines the structure with the affected components and ongoing incidents', () => {
    expect(status.pageName).toBe('incident.io')
    expect(status.indicator).toBe('major')
    expect(status.components.map((c) => [c.name, c.indicator])).toEqual([
      ['Web dashboard', 'none'],
      ['Slack integration', 'major'],
      ['Microsoft Teams integration', 'none'],
    ])
    const verdict = vendorVerdict(status, [{ id: '01GW2RH2J5WZQ6JEY8G4K3ZQ9F' }])
    expect(verdict.status).toBe('down')
    expect(verdict.msg).toContain('Slack notifications are delayed')
    expect(vendorVerdict(status, [{ id: '01GW2RGWJ9V1C6HT0W8Q0S3ZJP' }]).status).toBe('up')
  })
})

describe('RSS / Atom fallback', () => {
  const now = new Date('2026-10-11T14:00:00Z')

  it('treats a recent, unresolved newest entry as an open incident', () => {
    const status = parseFeed(fixture('statuspage-history.rss'), now)
    expect(status.pageName).toBe('Example Mail Status - Incident History')
    expect(status.incidents).toEqual([
      {
        title: 'Delayed delivery to Microsoft domains',
        url: 'https://status.example-mail.com/incidents/x1y2z3',
        indicator: 'minor',
        componentIds: [],
      },
    ])
    expect(vendorVerdict(status, []).status).toBe('degraded')
  })

  it('is up once the newest entry is resolved or older than a day', () => {
    expect(vendorVerdict(parseFeed(fixture('resolved.atom'), now), []).status).toBe('up')
    const later = new Date('2026-10-13T14:00:00Z')
    expect(vendorVerdict(parseFeed(fixture('statuspage-history.rss'), later), []).status).toBe('up')
  })

  it('finds the feed a status page advertises', () => {
    const html =
      '<html><head><link rel="alternate" type="application/atom+xml" href="/history.atom"></head></html>'
    expect(feedLinkFromHtml(html, 'https://status.example-dns.com/')).toBe(
      'https://status.example-dns.com/history.atom',
    )
    expect(feedLinkFromHtml('<html></html>', 'https://x.example')).toBeNull()
  })
})

describe('indicator mapping', () => {
  it('follows the issue: none up, minor degraded, major and critical down', () => {
    expect(indicatorToStatus('none')).toBe('up')
    expect(indicatorToStatus('minor')).toBe('degraded')
    expect(indicatorToStatus('major')).toBe('down')
    expect(indicatorToStatus('critical')).toBe('down')
    expect(indicatorToStatus('maintenance')).toBe('maintenance')
  })
})
