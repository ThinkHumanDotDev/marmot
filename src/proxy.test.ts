import { describe, expect, it } from 'vitest'

import { customDomainSuffix } from './proxy'

describe('custom domain rewrites', () => {
  it('maps the page paths, the history and permalinks', () => {
    expect(customDomainSuffix('/')).toBe('')
    expect(customDomainSuffix('/rss')).toBe('/rss')
    expect(customDomainSuffix('/events')).toBe('/events')
    expect(customDomainSuffix('/events/incident/k3x9a0b1')).toBe('/events/incident/k3x9a0b1')
    expect(customDomainSuffix('/events/maintenance/k3x9a0b1')).toBe('/events/maintenance/k3x9a0b1')
    expect(customDomainSuffix('/monitors')).toBe('/monitors')
    expect(customDomainSuffix('/monitors/6702f1c4e1b2a3d4e5f60718')).toBe(
      '/monitors/6702f1c4e1b2a3d4e5f60718',
    )
    expect(customDomainSuffix('/sitemap.xml')).toBe('/sitemap.xml')
    expect(customDomainSuffix('/robots.txt')).toBe('/robots.txt')
  })

  it('leaves everything else alone', () => {
    for (const path of [
      '/api/status-pages/x/public',
      '/events/other/k3x9a0b1',
      '/events/incident/../admin',
      '/events/incident/K3X9A0B1',
      '/monitors/../admin',
      '/monitors/6702F1C4E1B2A3D4E5F60718',
      '/constructor',
      '/admin',
    ]) {
      expect(customDomainSuffix(path), path).toBeUndefined()
    }
  })
})
