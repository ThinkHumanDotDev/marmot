import { expect, test } from '@playwright/test'

import { deleteAllUsers } from '../helpers/resetUsers'

/**
 * First-run wizard. Needs a server whose process has never seen a user (the status check caches
 * "setup complete"), which CI guarantees by booting `pnpm start` on a freshly migrated database.
 * The file is named `00-…` so Playwright (alphabetical order, one worker) runs it before the admin
 * spec seeds its superadmin.
 */
test.describe('First-run setup', () => {
  test.skip(!process.env.CI, 'requires a fresh database and server; runs in CI only')

  const run = Date.now().toString(36)
  const admin = {
    name: 'Ada Lovelace',
    email: `ada+${run}@marmot.local`,
    password: 'correct-horse-battery',
  }
  const orgName = `Analytical Engines ${run}`
  const orgSlug = `analytical-engines-${run}`

  test.beforeAll(async () => {
    await deleteAllUsers()
  })

  test('redirects a fresh instance to /setup and creates the admin and organization', async ({
    page,
    request,
  }) => {
    expect(await (await request.get('/api/setup/status')).json()).toEqual({ needsSetup: true })

    await page.goto('/')
    await expect(page).toHaveURL(/\/setup$/)
    await expect(page.getByRole('heading', { name: /welcome to marmot/i })).toBeVisible()

    // Auth pages hand over to the wizard too.
    await page.goto('/login')
    await expect(page).toHaveURL(/\/setup$/)

    await page.getByLabel('Name', { exact: true }).fill(admin.name)
    await page.getByLabel('Email').fill(admin.email)
    await page.getByLabel('Password').fill(admin.password)
    await page.getByLabel('Organization name').fill(orgName)
    // The slug is derived from the name until edited by hand.
    await expect(page.getByLabel('URL slug')).toHaveValue(orgSlug)
    await page.getByRole('button', { name: /create admin account/i }).click()

    await expect(page).toHaveURL(new RegExp(`/${orgSlug}/monitors$`))
    await expect(page.getByRole('heading', { name: 'Monitors' })).toBeVisible()

    // Setup is now closed: the status flips and the wizard is gone.
    expect(await (await request.get('/api/setup/status')).json()).toEqual({ needsSetup: false })
    const closed = await request.get('/setup', { maxRedirects: 0 })
    expect([307, 308]).toContain(closed.status())
    expect(closed.headers()['location']).toMatch(/\/login$/)

    const again = await request.post('/api/setup', {
      data: {
        ...admin,
        email: `again+${run}@marmot.local`,
        organizationName: orgName,
        organizationSlug: `${orgSlug}-2`,
      },
    })
    expect(again.status()).toBe(409)
  })
})
