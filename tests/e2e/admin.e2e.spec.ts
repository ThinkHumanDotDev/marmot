import { expect, test } from './fixtures'

/** Payload admin panel, as the superadmin created by the setup wizard (project storage state). */
test.describe('Admin Panel', () => {
  test('can navigate to dashboard', async ({ page }) => {
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/admin\/?$/)
    await expect(page.locator('span[title="Dashboard"]').first()).toBeVisible()
  })

  test('can navigate to list view', async ({ page }) => {
    await page.goto('/admin/collections/users')
    // Payload appends list preferences such as `?depth=1&limit=10` to the URL.
    await expect(page).toHaveURL(/\/admin\/collections\/users(\?.*)?$/)
    await expect(page.locator('h1', { hasText: 'Users' }).first()).toBeVisible()
  })

  test('can navigate to edit view', async ({ page }) => {
    await page.goto('/admin/collections/users/create')
    await expect(page).toHaveURL(/\/admin\/collections\/users\/[a-zA-Z0-9-_]+/)
    await expect(page.locator('input[name="email"]')).toBeVisible()
  })
})
