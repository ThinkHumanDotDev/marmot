import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'

import { expect, runId, targetUrl, test, type DocId } from './fixtures'

/**
 * Accessibility smoke (issue #32): axe-core on the key pages in light and dark mode, plus the
 * keyboard paths (command palette, `g` sequences). Serious and critical violations fail the test.
 * Runs as the setup admin (project storage state); data is seeded through the REST API and the
 * heartbeats come from the worker checking the local target server.
 */
const run = runId()
const org = { name: `A11y Org ${run}`, slug: `e2e-a11y-${run}` }
const monitorName = `Checkout API ${run}`
const statusPageSlug = `e2e-a11y-status-${run}`

let monitorId: DocId
const created: { collection: string; id: DocId }[] = []

/** Runs axe with the WCAG 2.1 A/AA rules and fails on serious or critical findings. */
async function expectNoSeriousViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  )
  const summary = blocking.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
  }))
  expect(summary, `${label}: serious/critical axe violations`).toEqual([])
}

test.describe('Accessibility', () => {
  // Each test visits several freshly compiled pages in two colour schemes and two viewports.
  test.setTimeout(120_000)

  test.beforeAll(async ({ adminApi }) => {
    const track = <T extends { id: DocId }>(collection: string, doc: T): T => {
      created.unshift({ collection, id: doc.id })
      return doc
    }
    // The creating admin becomes the organization's owner (organizations afterChange hook).
    const organization = track('organizations', await adminApi.create('organizations', org))

    const monitor = track(
      'monitors',
      await adminApi.createMonitor({
        name: monitorName,
        type: 'http',
        url: targetUrl('/health'),
        active: true,
        interval: 60,
        retryInterval: 60,
        maxRetries: 0,
        resendInterval: 0,
        timeout: 48,
        organization: organization.id,
      }),
    )
    monitorId = monitor.id
    await adminApi.waitForHeartbeat(monitorId, 'up')

    track(
      'status-pages',
      await adminApi.create('status-pages', {
        organization: organization.id,
        title: 'A11y Status',
        slug: statusPageSlug,
        published: true,
        groups: [{ name: 'Services', monitors: [{ monitor: monitorId }] }],
      }),
    )
  })

  test.afterAll(async ({ adminApi }) => {
    // Newest first, so nothing is deleted while something still references it.
    for (const { collection, id } of created) await adminApi.delete(collection, id)
  })

  test('login page has no serious violations', async ({ anonymousPage: page }) => {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.goto('/login')
      await expect(page.getByRole('heading', { name: /sign in to marmot/i })).toBeVisible()
      await expectNoSeriousViolations(page, `login (${colorScheme})`)
    }
  })

  const appPages = [
    {
      name: 'monitors list',
      path: () => `/${org.slug}/monitors`,
      ready: (page: Page) => page.getByRole('link', { name: new RegExp(monitorName) }),
    },
    {
      name: 'monitor detail',
      path: () => `/${org.slug}/monitors/${monitorId}`,
      // The h1 rather than its test id: a hidden copy of the title can be in the DOM briefly.
      ready: (page: Page) => page.getByRole('heading', { level: 1, name: new RegExp(monitorName) }),
    },
    {
      name: 'status pages',
      path: () => `/${org.slug}/status-pages`,
      ready: (page: Page) => page.getByRole('link', { name: 'A11y Status' }),
    },
    {
      name: 'members',
      path: () => `/${org.slug}/members`,
      ready: (page: Page) => page.getByTestId('members-table'),
    },
  ]

  for (const target of appPages) {
    test(`${target.name} has no serious violations (light, dark, mobile)`, async ({ page }) => {
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        await page.goto(target.path())
        await expect(target.ready(page)).toBeVisible()
        await expect(page.locator('html')).toHaveClass(new RegExp(colorScheme))
        await expectNoSeriousViolations(page, `${target.name} (${colorScheme})`)
      }
      await page.emulateMedia({ colorScheme: 'light' })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(target.path())
      await expect(target.ready(page)).toBeVisible()
      // Nothing may force horizontal scrolling of the page at phone width.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow, `${target.name}: horizontal overflow at 390px`).toBeLessThanOrEqual(0)
      await expectNoSeriousViolations(page, `${target.name} (mobile)`)
    })
  }

  test('command palette finds monitors and runs keyboard navigation', async ({ page }) => {
    await page.goto(`/${org.slug}/members`)
    await expect(page.getByTestId('members-table')).toBeVisible()

    // ⌘K / Ctrl+K opens the palette; typing a monitor name and Enter opens its detail page.
    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await expect(palette).toBeVisible()
    await palette.getByRole('combobox').fill(monitorName)
    await expect(palette.getByRole('option', { name: new RegExp(monitorName) })).toBeVisible()
    await page.keyboard.press('Enter')
    await page.waitForURL(new RegExp(`/${org.slug}/monitors/${monitorId}$`))
    await expect(
      page.getByRole('heading', { level: 1, name: new RegExp(monitorName) }),
    ).toBeVisible()

    // Quick actions know about the monitor on screen.
    await page.keyboard.press('ControlOrMeta+k')
    await expect(palette.getByRole('option', { name: /pause “/i })).toBeVisible()
    await expect(palette.getByRole('option', { name: /new monitor/i })).toBeVisible()
    await expect(palette.getByRole('option', { name: /open a11y status/i })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()

    // kan.bn-style sequences: g s → status pages, g m → monitors.
    await page.getByRole('heading', { level: 1 }).click()
    await page.keyboard.press('g')
    await page.keyboard.press('s')
    await page.waitForURL(new RegExp(`/${org.slug}/status-pages$`))
    await page.keyboard.press('g')
    await page.keyboard.press('m')
    await page.waitForURL(new RegExp(`/${org.slug}/monitors$`))

    // On a fresh load the skip link is the first tab stop and moves focus to the main panel.
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Monitors' })).toBeVisible()
    await page.keyboard.press('Tab')
    const skip = page.getByRole('link', { name: 'Skip to content' })
    await expect(skip).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('#main-content')).toBeFocused()
  })
})
