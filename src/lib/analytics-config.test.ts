import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  analyticsKey,
  isAnalyticsEnabled,
  posthogUiHost,
  routePattern,
  sanitizeCaptureResult,
} from './analytics-config'

describe('analyticsKey / isAnalyticsEnabled', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is disabled without a key or with a blank one', () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '')
    expect(analyticsKey()).toBeUndefined()
    expect(isAnalyticsEnabled()).toBe(false)
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '   ')
    expect(isAnalyticsEnabled()).toBe(false)
  })

  it('is enabled with a key', () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', ' phc_test ')
    expect(analyticsKey()).toBe('phc_test')
    expect(isAnalyticsEnabled()).toBe(true)
  })
})

describe('posthogUiHost', () => {
  it('maps PostHog Cloud ingestion hosts to the app host', () => {
    expect(posthogUiHost('https://us.i.posthog.com')).toBe('https://us.posthog.com')
    expect(posthogUiHost('https://eu.i.posthog.com/')).toBe('https://eu.posthog.com')
  })

  it('keeps self-hosted hosts and falls back to the US cloud', () => {
    expect(posthogUiHost('https://posthog.example.com')).toBe('https://posthog.example.com')
    expect(posthogUiHost(undefined)).toBe('https://us.posthog.com')
    expect(posthogUiHost('')).toBe('https://us.posthog.com')
  })
})

describe('routePattern', () => {
  it('replaces organization slugs and ids', () => {
    expect(routePattern('/acme/monitors')).toBe('/[org]/monitors')
    expect(routePattern('/acme/monitors/12/edit')).toBe('/[org]/monitors/[id]/edit')
    expect(routePattern('/acme/status-pages/66f1a2b3c4d5e6f7a8b9c0d1')).toBe(
      '/[org]/status-pages/[id]',
    )
    expect(routePattern('/acme/monitors/new')).toBe('/[org]/monitors/new')
    expect(routePattern('/acme')).toBe('/[org]')
  })

  it('keeps static routes and masks tokens', () => {
    expect(routePattern('/')).toBe('/')
    expect(routePattern('/login')).toBe('/login')
    expect(routePattern('/setup')).toBe('/setup')
    expect(routePattern('/invite/AbC123xyz')).toBe('/invite/[code]')
    expect(routePattern('/status/acme-prod')).toBe('/status/[slug]')
    expect(routePattern('/admin/collections/users/42')).toBe('/admin/collections/users/[id]')
  })

  it('drops query strings and hashes', () => {
    expect(routePattern('/login?next=%2Facme#top')).toBe('/login')
  })
})

describe('sanitizeCaptureResult', () => {
  it('rewrites URL properties to route patterns and drops referrers and hosts', () => {
    const result = sanitizeCaptureResult({
      event: 'monitor_created',
      properties: {
        type: 'http',
        $current_url: 'https://status.acme.com/acme/monitors/12?tab=events',
        $pathname: '/acme/monitors/12',
        $referrer: 'https://www.google.com/',
        $referring_domain: 'www.google.com',
        $host: 'status.acme.com',
        $set_once: {
          $initial_current_url: 'https://status.acme.com/invite/secret-token',
          $initial_referrer: '$direct',
          $initial_host: 'status.acme.com',
        },
      },
    })
    expect(result.properties).toEqual({
      type: 'http',
      $current_url: '/[org]/monitors/[id]',
      $pathname: '/[org]/monitors/[id]',
      $set_once: { $initial_current_url: '/invite/[code]' },
    })
  })

  it('passes null through and leaves events without properties alone', () => {
    expect(sanitizeCaptureResult(null)).toBeNull()
    expect(sanitizeCaptureResult({ event: 'x' })).toEqual({ event: 'x' })
  })
})
