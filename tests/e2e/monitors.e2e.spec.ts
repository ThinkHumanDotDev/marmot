import { expect, runId, SETUP_ORG, targetUrl, test, type DocId } from './fixtures'

/**
 * Monitor form validation and pause/resume. Creating a monitor and watching its first heartbeat is
 * part of the critical path (`critical-path.e2e.spec.ts`); here the monitor is seeded.
 */
const monitorName = `Seeded check ${runId()}`
let monitorId: DocId

test.describe('Monitors', () => {
  test.beforeAll(async ({ adminApi }) => {
    const organization = await adminApi.organizationId(SETUP_ORG.slug)
    const monitor = await adminApi.createMonitor({
      name: monitorName,
      type: 'http',
      url: targetUrl('/health'),
      active: true,
      interval: 60,
      retryInterval: 60,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 48,
      organization,
    })
    monitorId = monitor.id
  })

  test.afterAll(async ({ adminApi }) => {
    if (monitorId !== undefined) await adminApi.delete('monitors', monitorId)
  })

  test('validates the form before submitting', async ({ page }) => {
    await page.goto(`/${SETUP_ORG.slug}/monitors/new`)
    await expect(page.getByRole('heading', { name: 'New monitor' })).toBeVisible()
    // Visible form only; see the note in critical-path.e2e.spec.ts.
    const fields = page.getByTestId('monitor-form').filter({ visible: true })
    await fields.getByLabel('URL', { exact: true }).fill('')
    await fields.getByTestId('monitor-submit').click()
    await expect(page.getByText('Name is required')).toBeVisible()
    await expect(page.getByText('URL is required')).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/${SETUP_ORG.slug}/monitors/new$`))
  })

  test('turns on certificate transparency alerts with expected issuers', async ({
    page,
    adminApi,
  }) => {
    await page.goto(`/${SETUP_ORG.slug}/monitors/${monitorId}/edit`)
    const fields = page.getByTestId('monitor-form').filter({ visible: true })
    // The sub-options only show once the alerts are on.
    await expect(fields.getByLabel('Expected issuers')).toHaveCount(0)
    await fields.getByLabel('Certificate transparency alerts').click()
    await fields.getByLabel('Include subdomains').click()
    await fields.getByLabel('Expected issuers').fill("Let's Encrypt\nDigiCert")
    await fields.getByTestId('monitor-submit').click()
    await page.waitForURL((url) => url.pathname === `/${SETUP_ORG.slug}/monitors/${monitorId}`)
    const [monitor] = await adminApi.find('monitors', { id: { equals: String(monitorId) } })
    expect(monitor).toMatchObject({
      ctAlerts: true,
      ctIncludeSubdomains: true,
      ctExpectedIssuers: ["Let's Encrypt", 'DigiCert'],
    })
  })

  test('pauses and resumes from the detail page', async ({ page }) => {
    await page.goto(`/${SETUP_ORG.slug}/monitors/${monitorId}`)
    await expect(page.getByTestId('monitor-name')).toHaveText(monitorName)
    await page.getByTestId('toggle-active').click()
    await expect(page.getByText('This monitor is paused.')).toBeVisible()
    await expect(page.getByTestId('toggle-active')).toHaveText(/resume/i)
    await page.getByTestId('toggle-active').click()
    await expect(page.getByText('This monitor is paused.')).toHaveCount(0)
  })
})
