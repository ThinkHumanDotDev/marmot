import { describe, expect, it } from 'vitest'

import { locales } from '@/i18n/locales'

import { config, customDomainRewrite, customDomainSuffix, statusPathRewrite } from './proxy'

describe('language prefixes (#114)', () => {
  it('strips the prefix after the slug and reports the language', () => {
    expect(statusPathRewrite('/status/acme/fr')).toEqual({ pathname: '/status/acme', locale: 'fr' })
    expect(statusPathRewrite('/status/acme/de/events')).toEqual({
      pathname: '/status/acme/events',
      locale: 'de',
    })
    expect(statusPathRewrite('/status/acme/es/events/incident/k3x9a0b1.md')).toEqual({
      pathname: '/status/acme/event-md/incident/k3x9a0b1',
      locale: 'es',
    })
    expect(statusPathRewrite('/status/acme/events')).toEqual({
      pathname: '/status/acme/events',
      locale: null,
    })
    // Unknown codes are left to the router (404); a slug that looks like a language still works.
    expect(statusPathRewrite('/status/acme/xx')).toEqual({
      pathname: '/status/acme/xx',
      locale: null,
    })
    expect(statusPathRewrite('/status/fr')).toEqual({ pathname: '/status/fr', locale: null })
  })

  it('maps prefixed custom-domain paths', () => {
    expect(customDomainRewrite('/fr')).toEqual({ suffix: '', locale: 'fr' })
    expect(customDomainRewrite('/fr/events')).toEqual({ suffix: '/events', locale: 'fr' })
    expect(customDomainRewrite('/de/rss')).toEqual({ suffix: '/rss', locale: 'de' })
    expect(customDomainRewrite('/rss')).toEqual({ suffix: '/rss', locale: null })
    expect(customDomainRewrite('/fr/admin')).toBeUndefined()
  })

  it('matches every shipped language in the proxy matcher', () => {
    const pattern = `(${locales.join('|')})`
    expect(config.matcher).toContain(`/:locale${pattern}`)
    expect(config.matcher).toContain(`/:locale${pattern}/:path*`)
  })
})

describe('custom domain rewrites', () => {
  it('maps the page paths, the history and permalinks', () => {
    expect(customDomainSuffix('/')).toBe('')
    expect(customDomainSuffix('/rss')).toBe('/rss')
    expect(customDomainSuffix('/events')).toBe('/events')
    expect(customDomainSuffix('/events/incident/k3x9a0b1')).toBe('/events/incident/k3x9a0b1')
    expect(customDomainSuffix('/events/maintenance/k3x9a0b1')).toBe('/events/maintenance/k3x9a0b1')
    expect(customDomainSuffix('/sitemap.xml')).toBe('/sitemap.xml')
    expect(customDomainSuffix('/robots.txt')).toBe('/robots.txt')
  })

  it('leaves everything else alone', () => {
    for (const path of [
      '/api/status-pages/x/public',
      '/events/other/k3x9a0b1',
      '/events/incident/../admin',
      '/events/incident/K3X9A0B1',
      '/constructor',
      '/admin',
    ]) {
      expect(customDomainSuffix(path), path).toBeUndefined()
    }
  })
})
