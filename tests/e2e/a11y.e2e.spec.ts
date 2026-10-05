import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { getPayload, type Payload } from 'payload'

import config from '@payload-config'

import { cleanupOrganization, cleanupUsers, seedOrganization, seedUser } from '../helpers/org'

/**
 * Accessibility smoke (issue #32): axe-core on the key pages in light and dark mode, plus the
 * keyboard paths (command palette, `g` sequences). Serious and critical violations fail the test.
 */
const run = Date.now().toString(36)
const owner = {
  email: `a11y-${run}@marmot.local`,
  password: 'marmot-a11y-password',
  name: 'Grace Hopper',
}
const org = { name: `A11y Org ${run}`, slug: `e2e-a11y-${run}` }
const monitorName = `Checkout API ${run}`
const statusPageSlug = `e2e-a11y-status-${run}`

let payload: Payload
let orgId: string | number
let monitorId: string | number

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: /^sign in$/i }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
}

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

  test.beforeAll(async () => {
    payload = await getPayload({ config })
    const user = await seedUser(owner)
    const organization = await seedOrganization(user, org)
    orgId = organization.id

    const monitor = await payload.create({
      collection: 'monitors',
      data: {
        name: monitorName,
        type: 'http',
        url: 'https://example.com/health',
        active: true,
        interval: 60,
        retryInterval: 60,
        maxRetries: 0,
        resendInterval: 0,
        timeout: 48,
        organization: orgId,
        status: { lastStatus: 'up', lastCheckAt: new Date().toISOString(), lastPing: 87 },
      } as never,
    })
    monitorId = monitor.id

    const now = Date.now()
    for (let i = 0; i < 12; i++) {
      await payload.create({
        collection: 'heartbeats',
        data: {
          monitor: monitorId,
          organization: orgId,
          status: i === 4 ? 'down' : 'up',
          important: i === 4 || i === 5,
          ping: 80 + i * 3,
          msg: i === 4 ? 'Timeout' : 'OK',
          time: new Date(now - (12 - i) * 60_000).toISOString(),
        } as never,
      })
    }

    await payload.create({
      collection: 'status-pages',
      data: {
        organization: orgId,
        title: 'A11y Status',
        slug: statusPageSlug,
        published: true,
        groups: [{ name: 'Services', monitors: [{ monitor: monitorId }] }],
      } as never,
    })
  })

  test.afterAll(async () => {
    if (orgId !== undefined) {
      await payload.delete({
        collection: 'status-pages',
        where: { organization: { equals: orgId } },
      })
      await payload.delete({ collection: 'heartbeats', where: { organization: { equals: orgId } } })
      await payload.delete({ collection: 'monitors', where: { organization: { equals: orgId } } })
    }
    await cleanupOrganization(org.slug)
    await cleanupUsers([owner.email])
  })

  test('login page has no serious violations', async ({ page }) => {
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
      ready: (page: Page) => page.getByTestId('monitor-name'),
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
      await signIn(page)
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
    await signIn(page)
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
    await expect(page.getByTestId('monitor-name')).toHaveText(monitorName)

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
