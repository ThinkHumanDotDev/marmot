import { expect, test } from '@playwright/test'

test.describe('Frontend', () => {
  test('renders the landing page', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle(/Marmot/)
    await expect(page.locator('h1').first()).toHaveText('Marmot')
  })

  test('health endpoint reports ok', async ({ request }) => {
    const res = await request.get('/api/health')
    expect(res.ok()).toBeTruthy()
    expect(await res.json()).toMatchObject({ ok: true })
  })
})
