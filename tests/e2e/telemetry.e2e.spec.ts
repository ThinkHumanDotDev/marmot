import type { Request } from '@playwright/test'

import { ADMIN, ANONYMOUS, expect, SETUP_ORG, signIn, test } from './fixtures'

const org = SETUP_ORG

/** Any request that would reach PostHog: the same-origin proxy or a PostHog host directly. */
const isAnalyticsRequest = (request: Request): boolean => {
  const url = new URL(request.url())
  return (
    url.pathname === '/ph' ||
    url.pathname.startsWith('/ph/') ||
    /(^|\.)posthog\.com$/i.test(url.hostname) ||
    /(^|\.)i\.posthog\.com$/i.test(url.hostname)
  )
}

/**
 * Default install: `NEXT_PUBLIC_POSTHOG_KEY` is unset (CI never sets it), so analytics must be
 * completely inert: no SDK, no consent banner and not a single request towards PostHog across the
 * login flow and the dashboard. Starts signed out and signs in as the setup admin.
 */
test.use({ storageState: ANONYMOUS })

test.describe('Telemetry (disabled by default)', () => {
  test.skip(
    Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY),
    'this spec asserts the disabled state; a PostHog key is configured',
  )

  test('makes no analytics requests and shows no consent banner', async ({ page }) => {
    const analyticsRequests: string[] = []
    page.on('request', (request) => {
      if (isAnalyticsRequest(request)) analyticsRequests.push(request.url())
    })
    // Belt and braces: even if something tried, the proxy path never leaves the browser.
    await page.route('**/ph/**', (route) => route.abort())
    await page.route(/posthog\.com/i, (route) => route.abort())

    await page.goto('/login')
    await expect(page.getByRole('heading', { name: /sign in to marmot/i })).toBeVisible()
    await signIn(page, ADMIN)

    await page.goto(`/${org.slug}/monitors`)
    await expect(page.getByRole('heading', { level: 1, name: 'Monitors' })).toBeVisible()
    // Not `networkidle`: socket.io starts on HTTP long-polling, which keeps a request open until the
    // websocket upgrade lands, so the page may never go idle. The listener above sees every request.
    await page.goto(`/${org.slug}/notifications`)
    await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible()

    // No SDK was initialised and no banner rendered.
    expect(await page.evaluate(() => 'posthog' in window)).toBe(false)
    await expect(page.getByTestId('consent-banner-root')).toHaveCount(0)
    await expect(page.getByText(/help improve marmot/i)).toHaveCount(0)

    // The account menu offers no privacy entry when analytics are off.
    await page.getByRole('button', { name: /^account:/i }).click()
    await expect(page.getByRole('menuitem', { name: /privacy settings/i })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: /sign out/i })).toBeVisible()
    await page.keyboard.press('Escape')

    expect(analyticsRequests).toEqual([])
  })
})
