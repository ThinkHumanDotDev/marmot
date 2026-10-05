import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const posthogNode = vi.hoisted(() => {
  const instance = {
    capture: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  }
  return {
    instance,
    PostHog: vi.fn(function PostHog() {
      return instance
    }),
  }
})

vi.mock('posthog-node', () => ({ PostHog: posthogNode.PostHog }))

import { resetEnvCache } from '@/env'

async function loadServerAnalytics() {
  vi.resetModules()
  resetEnvCache()
  return import('./analytics')
}

describe('hashAnalyticsId', () => {
  it('is stable for the same id and secret', async () => {
    const { hashAnalyticsId } = await loadServerAnalytics()
    expect(hashAnalyticsId(42, 'secret-a')).toBe(hashAnalyticsId('42', 'secret-a'))
    expect(hashAnalyticsId(42, 'secret-a')).toMatch(/^[a-f0-9]{64}$/)
  })

  it('changes with the id and with the secret, and never contains the id', async () => {
    const { hashAnalyticsId } = await loadServerAnalytics()
    expect(hashAnalyticsId(42, 'secret-a')).not.toBe(hashAnalyticsId(43, 'secret-a'))
    expect(hashAnalyticsId(42, 'secret-a')).not.toBe(hashAnalyticsId(42, 'secret-b'))
    expect(hashAnalyticsId('66f1a2b3c4d5e6f7a8b9c0d1', 'secret-a')).not.toContain(
      '66f1a2b3c4d5e6f7a8b9c0d1',
    )
  })

  it('derives the salt from PAYLOAD_SECRET without exposing it', async () => {
    const { analyticsSalt } = await loadServerAnalytics()
    expect(analyticsSalt('my-secret')).not.toContain('my-secret')
    expect(analyticsSalt('my-secret')).toBe(analyticsSalt('my-secret'))
    expect(analyticsSalt('my-secret')).not.toBe(analyticsSalt('other-secret'))
  })
})

describe('captureServerEvent', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => {
    vi.unstubAllEnvs()
    resetEnvCache()
  })

  it('never instantiates the SDK when no key is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '')
    const { captureServerEvent, isServerAnalyticsEnabled, shutdownServerAnalytics } =
      await loadServerAnalytics()
    expect(isServerAnalyticsEnabled()).toBe(false)
    captureServerEvent('instance_started', { version: '1.0.0' })
    await shutdownServerAnalytics()
    expect(posthogNode.PostHog).not.toHaveBeenCalled()
    expect(posthogNode.instance.capture).not.toHaveBeenCalled()
  })

  it('sends instance-level events without a person profile and flushes on shutdown', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test')
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://eu.i.posthog.com')
    const { captureServerEvent, instanceDistinctId, shutdownServerAnalytics } =
      await loadServerAnalytics()

    captureServerEvent('org_created', { orgId: 'hashed' })
    captureServerEvent('instance_started', { version: '1.0.0' })

    expect(posthogNode.PostHog).toHaveBeenCalledTimes(1)
    expect(posthogNode.PostHog).toHaveBeenCalledWith(
      'phc_test',
      expect.objectContaining({ host: 'https://eu.i.posthog.com', disableGeoip: true }),
    )
    expect(posthogNode.instance.capture).toHaveBeenCalledWith({
      distinctId: instanceDistinctId(),
      event: 'org_created',
      properties: { orgId: 'hashed', $process_person_profile: false },
      disableGeoip: true,
    })
    expect(instanceDistinctId()).toMatch(/^instance_[a-f0-9]{32}$/)

    await shutdownServerAnalytics()
    expect(posthogNode.instance.shutdown).toHaveBeenCalledTimes(1)
  })
})
