import { expect, test } from '@playwright/test'

test.describe('Frontend', () => {
  test('redirects signed-out visitors to the login page', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/login$/)
    await expect(page).toHaveTitle(/Marmot/)
    await expect(page.getByRole('heading', { name: /sign in to marmot/i })).toBeVisible()
    await expect(page.getByLabel('Email')).toBeVisible()
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible()
  })

  test('rejects wrong credentials without leaving the page', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email').fill('nobody@marmot.local')
    await page.getByLabel('Password').fill('definitely-not-the-password')
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(
      page.getByRole('alert').filter({ hasText: /incorrect email or password/i }),
    ).toBeVisible()
    await expect(page).toHaveURL(/\/login$/)
  })

  test('auth config endpoint reports signup availability', async ({ request }) => {
    const res = await request.get('/api/auth/config')
    expect(res.ok()).toBeTruthy()
    expect(await res.json()).toEqual({ signupEnabled: expect.any(Boolean) })
  })

  test('health endpoint reports ok', async ({ request }) => {
    const res = await request.get('/api/health')
    expect(res.ok()).toBeTruthy()
    expect(await res.json()).toMatchObject({ ok: true })
  })
})
