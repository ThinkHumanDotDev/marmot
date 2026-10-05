import { expect, test, type Request } from '@playwright/test'

import { cleanupOrganization, cleanupUsers, seedOrganization, seedUser } from '../helpers/org'

const run = Date.now().toString(36)
const user = {
  email: `telemetry-${run}@marmot.local`,
  password: 'marmot-e2e-password',
  name: 'Tess Telemetry',
}
const org = { name: 'E2E Telemetry', slug: `e2e-telemetry-${run}` }

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
 * login flow and the dashboard.
 */
test.describe('Telemetry (disabled by default)', () => {
  test.skip(
    Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY),
    'this spec asserts the disabled state; a PostHog key is configured',
  )

  test.beforeAll(async () => {
    const owner = await seedUser(user)
    await seedOrganization(owner, org)
  })

  test.afterAll(async () => {
    await cleanupOrganization(org.slug)
    await cleanupUsers([user.email])
  })

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
    await page.getByLabel('Email').fill(user.email)
    await page.getByLabel('Password').fill(user.password)
    await page.getByRole('button', { name: /^sign in$/i }).click()
    await page.waitForURL(new RegExp(`/${org.slug}(/monitors)?$`))

    await page.goto(`/${org.slug}/monitors`)
    await expect(page.getByRole('heading', { level: 1, name: 'Monitors' })).toBeVisible()
    await page.goto(`/${org.slug}/notifications`)
    await page.waitForLoadState('networkidle')

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
