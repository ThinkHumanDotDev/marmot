import type { BrowserContext, Page } from '@playwright/test'

import { ADMIN, ANONYMOUS, expect, newSession, runId, signIn, targetUrl, test } from './fixtures'

/**
 * The critical path, in order, after the setup wizard (`00-setup.e2e.spec.ts`): sign in → create an
 * organization → create an HTTP monitor and watch its first heartbeat arrive live (worker →
 * Redis → realtime → browser) → create and publish a status page → the public page renders →
 * invite a member who signs up and accepts. The steps share one signed-in browser context and run
 * serially; a retry starts again from the first step with fresh names.
 */
const run = runId()
const org = { name: `Critical Path ${run}`, slug: `critical-path-${run}` }
const monitorName = `Target health ${run}`
const monitorUrl = targetUrl('/health')
const statusPage = { title: `Critical Path Status ${run}`, slug: `critical-path-status-${run}` }
const invitee = {
  name: 'Ivy Invitee',
  email: `ivy-${run}@marmot.test`,
  password: 'marmot-e2e-password',
}

test.describe.configure({ mode: 'serial' })
test.use({ storageState: ANONYMOUS })

test.describe('Critical path', () => {
  let context: BrowserContext
  let page: Page

  test.beforeAll(async ({ browser }) => {
    ;({ context, page } = await newSession(browser))
  })

  test.afterAll(async () => {
    await context?.close()
  })

  test('signs in through the login page', async () => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/login$/)
    await signIn(page, ADMIN)
    // The admin lands in the organization created by the setup wizard.
    await expect(page.getByRole('heading', { level: 1, name: 'Monitors' })).toBeVisible()
  })

  test('creates an organization', async () => {
    await page.goto('/onboarding')
    await expect(page.getByRole('heading', { name: 'New organization' })).toBeVisible()
    await page.getByLabel('Organization name').fill(org.name)
    await expect(page.getByLabel('URL slug')).toHaveValue(org.slug)
    const submit = page.getByRole('button', { name: 'Create organization' })
    // Enabled once the slug availability check has passed.
    await expect(submit).toBeEnabled()
    await submit.click()
    await page.waitForURL(new RegExp(`/${org.slug}(/monitors)?$`))
    await expect(page.getByRole('heading', { level: 1, name: 'Monitors' })).toBeVisible()
  })

  test('creates an HTTP monitor and receives its first heartbeat live', async () => {
    // Keep the dashboard open: the monitor and its heartbeat must arrive over the socket.
    await page.goto(`/${org.slug}/monitors`)
    await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 20_000 })

    const form = await context.newPage()
    await form.goto(`/${org.slug}/monitors/new`)
    await expect(form.getByRole('heading', { name: 'New monitor' })).toBeVisible()
    // HTTP(s) is the default type; the URL field is visible straight away.
    await expect(form.getByTestId('monitor-type')).toContainText('HTTP(s)')
    await form.getByLabel('Friendly name').fill(monitorName)
    await form.getByLabel('URL', { exact: true }).fill(monitorUrl)
    await form.getByTestId('monitor-submit').click()
    await form.waitForURL((url) =>
      new RegExp(`/${org.slug}/monitors/(?!new$)[A-Za-z0-9]+$`).test(url.pathname),
    )
    await expect(form.getByTestId('monitor-name')).toHaveText(monitorName)
    await expect(form.getByTestId('monitor-target')).toContainText(monitorUrl)
    await expect(form.getByTestId('uptime-cards')).toBeVisible()
    await expect(form.getByTestId('heartbeat-bar')).toBeVisible()
    await form.close()

    // Back on the dashboard, without reloading: the monitor was pushed into the list and turns up
    // once the worker's first check has been published by the realtime server.
    const row = page.getByRole('link', { name: new RegExp(monitorName) })
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect(row).toHaveAttribute('data-status', 'up', { timeout: 45_000 })
    await expect(row.getByRole('img', { name: /last 1 checks?/i })).toBeVisible()
  })

  test('creates and publishes a status page', async () => {
    await page.goto(`/${org.slug}/status-pages`)
    await page.getByRole('button', { name: /new status page/i }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Title').fill(statusPage.title)
    await dialog.getByLabel('Slug').fill(statusPage.slug)
    await dialog.getByRole('button', { name: 'Create' }).click()
    await page.waitForURL(new RegExp(`/${org.slug}/status-pages/(?!$)[A-Za-z0-9]+$`))
    await expect(page.getByText('Draft', { exact: true })).toBeVisible()

    // Visitors get a 404 while the page is a draft.
    const { context: visitor, page: anonymous } = await newSession(page.context().browser()!)
    expect((await anonymous.goto(`/status/${statusPage.slug}`))?.status()).toBe(404)

    // Put the monitor on the page.
    await page.getByRole('tab', { name: /groups/i }).click()
    await page.getByRole('button', { name: /add group/i }).click()
    await page.getByLabel('Group name').fill('Public services')
    await page.getByRole('combobox', { name: 'Add monitor' }).click()
    await page.getByRole('option', { name: new RegExp(monitorName) }).click()
    await page.getByRole('button', { name: 'Save groups' }).click()
    await expect(page.getByText('Groups saved')).toBeVisible()

    await page.getByRole('switch', { name: 'Published' }).click()
    await expect(page.getByText('Status page published')).toBeVisible()
    await expect(page.getByText('Published', { exact: true }).first()).toBeVisible()

    // The public page renders for anonymous visitors.
    const response = await anonymous.goto(`/status/${statusPage.slug}`)
    expect(response?.status()).toBe(200)
    await expect(anonymous).toHaveTitle(new RegExp(statusPage.title))
    await expect(anonymous.getByRole('heading', { level: 1, name: statusPage.title })).toBeVisible()
    await expect(
      anonymous.getByRole('heading', { level: 2, name: 'Public services' }),
    ).toBeVisible()
    await expect(anonymous.getByText(monitorName)).toBeVisible()
    await expect(anonymous.getByRole('status')).toHaveText(/All systems operational/)
    await visitor.close()
  })

  test('invites a member who signs up and accepts', async ({ browser, adminApi }) => {
    await page.goto(`/${org.slug}/members`)
    await expect(page.getByTestId('member-row')).toHaveCount(1)
    await page.getByRole('button', { name: /invite member/i }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Email').fill(invitee.email)
    await dialog.getByRole('button', { name: /send invitation/i }).click()
    await expect(
      page.getByTestId('invitation-row').filter({ hasText: invitee.email }),
    ).toBeVisible()

    // The invitee opens the emailed link in their own browser and creates an account.
    const token = await adminApi.invitationToken(invitee.email)
    const { context: inviteeContext, page: inviteePage } = await newSession(browser)
    await inviteePage.goto(`/invite/${token}`)
    await expect(inviteePage.getByRole('heading', { name: `Join ${org.name}` })).toBeVisible()
    await inviteePage.getByRole('link', { name: /create an account/i }).click()
    await inviteePage.waitForURL(/\/signup/)
    await inviteePage.getByLabel('Name').fill(invitee.name)
    await inviteePage.getByLabel('Email').fill(invitee.email)
    await inviteePage.getByLabel('Password').fill(invitee.password)
    await inviteePage.getByRole('button', { name: /create account/i }).click()

    // Signed in → back on the invite page, which accepts and redirects into the organization.
    await inviteePage.waitForURL(new RegExp(`/${org.slug}(/|$)`), { timeout: 30_000 })
    await expect(
      inviteePage.getByRole('heading', { level: 1, name: 'Monitors', exact: true }),
    ).toBeVisible()
    await expect(inviteePage.getByRole('link', { name: new RegExp(monitorName) })).toBeVisible()
    await inviteeContext.close()

    // The owner sees the new member; the invitation is gone.
    await page.reload()
    await expect(page.getByTestId('member-row').filter({ hasText: invitee.email })).toBeVisible()
    await expect(page.getByTestId('invitation-row')).toHaveCount(0)
  })
})
