import { ADMIN, ADMIN_STATE, ANONYMOUS, expect, resetDatabase, SETUP_ORG, test } from './fixtures'

/**
 * First-run wizard (the `setup` project; every other spec depends on it). Resets the database so
 * the instance needs setup again, creates the superadmin and the first organization through the
 * wizard and stores the signed-in session for the other specs.
 */
test.use({ storageState: ANONYMOUS })

test.describe('First-run setup', () => {
  test.beforeAll(() => {
    resetDatabase()
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

    await page.getByLabel('Name', { exact: true }).fill(ADMIN.name)
    await page.getByLabel('Email').fill(ADMIN.email)
    await page.getByLabel('Password').fill(ADMIN.password)
    await page.getByLabel('Organization name').fill(SETUP_ORG.name)
    // The slug is derived from the name until edited by hand.
    await expect(page.getByLabel('URL slug')).toHaveValue(SETUP_ORG.slug)
    await page.getByRole('button', { name: /create admin account/i }).click()

    await expect(page).toHaveURL(new RegExp(`/${SETUP_ORG.slug}/monitors$`))
    await expect(page.getByRole('heading', { level: 1, name: 'Monitors' })).toBeVisible()

    // The wizard signed the admin in: keep that session for the other specs.
    await page.context().storageState({ path: ADMIN_STATE })

    // Setup is now closed: the status flips and the wizard is gone.
    expect(await (await request.get('/api/setup/status')).json()).toEqual({ needsSetup: false })
    const closed = await request.get('/setup', { maxRedirects: 0 })
    expect([307, 308]).toContain(closed.status())
    expect(closed.headers()['location']).toMatch(/\/login$/)

    const again = await request.post('/api/setup', {
      data: {
        ...ADMIN,
        email: 'again@marmot.test',
        organizationName: SETUP_ORG.name,
        organizationSlug: `${SETUP_ORG.slug}-2`,
      },
    })
    expect(again.status()).toBe(409)
  })
})
