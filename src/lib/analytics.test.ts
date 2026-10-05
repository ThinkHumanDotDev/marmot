import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const posthogMock = vi.hoisted(() => ({
  __loaded: true,
  capture: vi.fn(),
  identify: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
  reset: vi.fn(),
}))

vi.mock('posthog-js', () => ({ default: posthogMock }))

async function loadAnalytics() {
  const mod = await import('./analytics')
  mod.__resetAnalyticsStateForTests()
  return mod
}

describe('client analytics facade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    posthogMock.__loaded = true
    vi.stubGlobal('window', {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  describe('when analytics are disabled (no key)', () => {
    beforeEach(() => vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', ''))

    it('never touches the SDK, even after consent', async () => {
      const { track, identify, setAnalyticsConsent, trackPageview, resetAnalytics } =
        await loadAnalytics()
      setAnalyticsConsent(true)
      track('monitor_created', { type: 'http' })
      trackPageview('/acme/monitors')
      identify('abc')
      resetAnalytics()
      expect(posthogMock.opt_in_capturing).not.toHaveBeenCalled()
      expect(posthogMock.capture).not.toHaveBeenCalled()
      expect(posthogMock.identify).not.toHaveBeenCalled()
      expect(posthogMock.reset).not.toHaveBeenCalled()
    })
  })

  describe('when analytics are enabled', () => {
    beforeEach(() => vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test'))

    it('drops events and identities before consent', async () => {
      const { track, identify, hasAnalyticsConsent } = await loadAnalytics()
      expect(hasAnalyticsConsent()).toBe(false)
      track('monitor_created', { type: 'http' })
      identify('hashed-user')
      expect(posthogMock.capture).not.toHaveBeenCalled()
      expect(posthogMock.identify).not.toHaveBeenCalled()
    })

    it('opts in on consent, replays the pending identity and then captures', async () => {
      const { track, identify, setAnalyticsConsent } = await loadAnalytics()
      identify('hashed-user', { plan: 'team' })
      setAnalyticsConsent(true)
      expect(posthogMock.opt_in_capturing).toHaveBeenCalledWith({ captureEventName: false })
      expect(posthogMock.identify).toHaveBeenCalledWith('hashed-user', { plan: 'team' })

      track('monitor_created', { type: 'http' })
      expect(posthogMock.capture).toHaveBeenCalledWith('monitor_created', { type: 'http' })
    })

    it('sends pageviews as route patterns only', async () => {
      const { trackPageview, setAnalyticsConsent } = await loadAnalytics()
      setAnalyticsConsent(true)
      trackPageview('/acme/monitors/42')
      expect(posthogMock.capture).toHaveBeenCalledWith('$pageview', {
        $current_url: '/[org]/monitors/[id]',
        $pathname: '/[org]/monitors/[id]',
      })
    })

    it('opts out and resets the SDK when consent is withdrawn, then drops events', async () => {
      const { track, setAnalyticsConsent } = await loadAnalytics()
      setAnalyticsConsent(true)
      setAnalyticsConsent(false)
      expect(posthogMock.opt_out_capturing).toHaveBeenCalledTimes(1)
      expect(posthogMock.reset).toHaveBeenCalledTimes(1)
      track('monitor_created')
      expect(posthogMock.capture).not.toHaveBeenCalled()
    })

    it('ignores repeated consent updates with the same value', async () => {
      const { setAnalyticsConsent } = await loadAnalytics()
      setAnalyticsConsent(true)
      setAnalyticsConsent(true)
      expect(posthogMock.opt_in_capturing).toHaveBeenCalledTimes(1)
    })

    it('does nothing while the SDK has not been initialised', async () => {
      posthogMock.__loaded = false
      const { track, setAnalyticsConsent } = await loadAnalytics()
      setAnalyticsConsent(true)
      track('monitor_created')
      expect(posthogMock.opt_in_capturing).not.toHaveBeenCalled()
      expect(posthogMock.capture).not.toHaveBeenCalled()
    })

    it('resetAnalytics forgets the identity and resets the SDK', async () => {
      const { identify, resetAnalytics, setAnalyticsConsent } = await loadAnalytics()
      identify('hashed-user')
      resetAnalytics()
      expect(posthogMock.reset).toHaveBeenCalledTimes(1)
      setAnalyticsConsent(true)
      expect(posthogMock.identify).not.toHaveBeenCalled()
    })
  })
})
