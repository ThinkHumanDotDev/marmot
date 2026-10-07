import type { Locator } from '@playwright/test'

import { expect, runId, SETUP_ORG, test, type DocId } from './fixtures'

/**
 * Status page theming (#111): an admin picks a preset, overrides the primary and "down" colours for
 * dark mode, sees them in the editor preview and, after saving, on the public page. Visitors can
 * switch the colour mode with the header toggle.
 */
const run = runId()
const slug = `e2e-theme-${run}`
let pageId: DocId | undefined

/** Computed value of a CSS custom property (the inline arrow function is serialised into the page). */
const cssVar = (locator: Locator, name: string) =>
  locator.evaluate((el, n) => getComputedStyle(el).getPropertyValue(n).trim(), name)

test.describe('Status page themes', () => {
  test.beforeAll(async ({ adminApi }) => {
    const organization = await adminApi.organizationId(SETUP_ORG.slug)
    const page = await adminApi.create('status-pages', {
      organization,
      title: 'E2E Themed Status',
      slug,
      published: true,
    })
    pageId = page.id
  })

  test.afterAll(async ({ adminApi }) => {
    if (pageId !== undefined) await adminApi.delete('status-pages', pageId)
  })

  test('preset and dark-mode overrides reach the preview and the public page', async ({
    page,
    anonymousPage,
  }) => {
    await page.goto(`/${SETUP_ORG.slug}/status-pages/${pageId}`)
    await page.getByRole('tab', { name: 'Theme' }).click()

    await page.getByRole('radio', { name: /Ocean/ }).click()
    await page.getByRole('tab', { name: 'Dark mode' }).click()
    await page.locator('#token-dark-primary').fill('#ff8800')
    await page.locator('#token-dark-destructive').fill('#ff0000')

    // Invalid values are flagged before they reach the server.
    await page.locator('#token-dark-border').fill('red;}')
    await expect(page.getByText('Not a valid colour', { exact: false })).toBeVisible()
    await page.locator('#token-dark-border').fill('')

    const preview = page.locator('[data-theme-preview="dark"]')
    await expect(preview).toBeVisible()
    expect(await cssVar(preview, '--primary')).toBe('#ff8800')
    expect(await cssVar(preview, '--status-down')).toBe('#ff0000')
    expect(await cssVar(preview, '--background')).toBe('#0b1622')

    await page.getByRole('button', { name: 'Save theme' }).click()
    await expect(page.getByText('Theme saved')).toBeVisible()

    await anonymousPage.emulateMedia({ colorScheme: 'dark' })
    await anonymousPage.goto(`/status/${slug}`)
    const html = anonymousPage.locator('html')
    await expect(html).toHaveClass(/\bdark\b/)
    expect(await cssVar(html, '--primary')).toBe('#ff8800')
    expect(await cssVar(html, '--status-down')).toBe('#ff0000')

    // Light mode keeps the preset's colours; the visitor toggle switches modes and is remembered.
    await anonymousPage.emulateMedia({ colorScheme: 'light' })
    await anonymousPage.reload()
    await expect(html).not.toHaveClass(/\bdark\b/)
    expect(await cssVar(html, '--primary')).toBe('#0b5cad')

    const toggle = anonymousPage.getByRole('group', { name: 'Colour theme' })
    await toggle.getByRole('button', { name: 'Dark' }).click()
    await expect(html).toHaveClass(/\bdark\b/)
    await anonymousPage.reload()
    await expect(html).toHaveClass(/\bdark\b/)
    await expect(toggle.getByRole('button', { name: 'Dark' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })
})
