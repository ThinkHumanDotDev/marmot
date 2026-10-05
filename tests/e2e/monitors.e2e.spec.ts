import { expect, test, type Page } from '@playwright/test'
import { getPayload } from 'payload'

import config from '@payload-config'
import { addOrgMembership } from '@/access/memberships'

import { cleanupTestUser, seedTestUser, testUser } from '../helpers/seedUser'

const run = Date.now().toString(36)
const orgSlug = `e2e-monitors-${run}`
const monitorName = `Health check ${run}`

/** Signs in through the Marmot login page (not the Payload admin). */
async function loginToApp(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(testUser.email)
  await page.getByLabel('Password').fill(testUser.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
}

test.describe('Monitors', () => {
  let orgId: string | number

  test.beforeAll(async () => {
    await seedTestUser()
    const payload = await getPayload({ config })
    const user = await payload.find({
      collection: 'users',
      where: { email: { equals: testUser.email } },
      limit: 1,
      depth: 0,
    })
    const org = await payload.create({
      collection: 'organizations',
      data: { name: 'E2E Monitors', slug: orgSlug },
    })
    orgId = org.id
    await addOrgMembership({ payload, userId: user.docs[0].id, orgId: org.id, role: 'owner' })
  })

  test.afterAll(async () => {
    const payload = await getPayload({ config })
    if (orgId !== undefined) {
      await payload.delete({ collection: 'monitors', where: { organization: { equals: orgId } } })
      await payload.delete({ collection: 'organizations', id: orgId })
    }
    await cleanupTestUser()
  })

  test('creates an HTTP monitor and shows it on the detail page', async ({ page }) => {
    await loginToApp(page)

    await page.goto(`/${orgSlug}/monitors/new`)
    await expect(page.getByRole('heading', { name: 'New monitor' })).toBeVisible()

    // HTTP(s) is the default type; the URL field is visible straight away.
    await expect(page.getByTestId('monitor-type')).toContainText('HTTP(s)')
    await page.getByLabel('Friendly name').fill(monitorName)
    await page.getByLabel('URL', { exact: true }).fill('http://localhost:3000/api/health')
    await expect(page.getByText('Check every 1 minute')).toBeVisible()
    await page.getByTestId('monitor-submit').click()

    await page.waitForURL((url) =>
      new RegExp(`/${orgSlug}/monitors/(?!new$)[A-Za-z0-9]+$`).test(url.pathname),
    )
    await expect(page.getByTestId('monitor-name')).toHaveText(monitorName)
    await expect(page.getByTestId('monitor-target')).toContainText(
      'http://localhost:3000/api/health',
    )

    // Uptime cards and the heartbeat bar render even before the first beat arrives.
    await expect(page.getByTestId('uptime-cards')).toBeVisible()
    await expect(page.getByTestId('stat-uptime-24h')).toContainText('Uptime')
    await expect(page.getByTestId('stat-uptime-30d')).toBeVisible()
    await expect(page.getByTestId('stat-uptime-1y')).toBeVisible()
    await expect(page.getByTestId('heartbeat-bar')).toBeVisible()
    await expect(page.getByTestId('response-time-chart')).toBeVisible()
    await expect(page.getByTestId('important-events')).toBeVisible()
    await expect(page.getByTestId('certificate-panel')).toBeVisible()
  })

  test('validates the form before submitting', async ({ page }) => {
    await loginToApp(page)
    await page.goto(`/${orgSlug}/monitors/new`)
    await page.getByLabel('URL', { exact: true }).fill('')
    await page.getByTestId('monitor-submit').click()
    await expect(page.getByText('Name is required')).toBeVisible()
    await expect(page.getByText('URL is required')).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/${orgSlug}/monitors/new$`))
  })

  test('pauses and resumes from the detail page', async ({ page }) => {
    await loginToApp(page)
    const payload = await getPayload({ config })
    const { docs } = await payload.find({
      collection: 'monitors',
      where: { name: { equals: monitorName } },
      limit: 1,
      depth: 0,
    })
    expect(docs.length).toBe(1)

    await page.goto(`/${orgSlug}/monitors/${docs[0].id}`)
    await page.getByTestId('toggle-active').click()
    await expect(page.getByText('This monitor is paused.')).toBeVisible()
    await expect(page.getByTestId('toggle-active')).toHaveText(/resume/i)
    await page.getByTestId('toggle-active').click()
    await expect(page.getByText('This monitor is paused.')).toHaveCount(0)
  })
})
