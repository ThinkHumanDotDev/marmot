import { ADMIN, expect, runId, SETUP_ORG, targetUrl, test, type DocId } from './fixtures'
import { mailURL } from './e2e-env'

/**
 * SLA extras (#274): a target counting business hours only, a report sent as a test to the
 * signed-in admin (read back from the mail sink, `tests/e2e/mail-sink.mjs`) and its print view.
 */
const run = runId()
const monitorName = `SLA API ${run}`
const reportName = `Customer SLA ${run}`
let monitorId: DocId

test.describe('SLA business hours, send now and print view', () => {
  test.beforeAll(async ({ adminApi }) => {
    const organization = await adminApi.organizationId(SETUP_ORG.slug)
    const monitor = await adminApi.createMonitor({
      name: monitorName,
      type: 'http',
      url: targetUrl('/health'),
      active: false,
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
    for (const report of await adminApi.find('sla-reports', { name: { equals: reportName } })) {
      await adminApi.delete('sla-reports', report.id as DocId)
    }
    for (const target of await adminApi.find('sla-targets', {
      monitor: { equals: String(monitorId) },
    })) {
      await adminApi.delete('sla-targets', target.id as DocId)
    }
    if (monitorId !== undefined) await adminApi.delete('monitors', monitorId)
  })

  test('tracks a business-hours target, mails a test report and prints it', async ({ page }) => {
    await page.goto(`/${SETUP_ORG.slug}/sla`)

    // A target counting weekdays 09:00–17:00 only.
    await page.getByTestId('sla-target-new').click()
    const targetForm = page.getByTestId('sla-target-form')
    await targetForm.getByLabel('Monitor').click()
    await page.getByRole('option', { name: monitorName }).click()
    await targetForm.getByLabel('Business hours only').click()
    await expect(targetForm.getByLabel('Sat')).not.toBeChecked()
    await targetForm.getByLabel('To (HH:MM or 24:00)').fill('08:00')
    await targetForm.getByRole('button', { name: 'Save target' }).click()
    await expect(targetForm.getByRole('alert')).toContainText('start before the end')
    await targetForm.getByLabel('To (HH:MM or 24:00)').fill('17:00')
    await targetForm.getByLabel('Holidays').fill('2026-12-25')
    await targetForm.getByRole('button', { name: 'Save target' }).click()
    await expect(targetForm).toBeHidden()
    const item = page.locator('[data-sla-target]').filter({ hasText: monitorName })
    await expect(item.getByText('Business hours 09:00–17:00')).toBeVisible()

    // A report with recipients, opened and sent as a test to the admin.
    await page.getByTestId('sla-report-new').click()
    const reportForm = page.getByTestId('sla-report-form')
    await reportForm.getByLabel('Name').fill(reportName)
    await reportForm.getByLabel('Recipients').fill(`ops-${run}@marmot.test`)
    await reportForm.getByRole('button', { name: 'Save report' }).click()
    await expect(reportForm).toBeHidden()
    await page.getByRole('link', { name: reportName }).click()
    await expect(page.getByRole('heading', { level: 1, name: reportName })).toBeVisible()
    await expect(page.getByTestId('sla-report')).toContainText('business hours')
    await expect(page.getByTestId('sla-report')).toContainText('(UTC)')

    await page.getByRole('button', { name: 'Send test to me' }).click()
    await expect(page.getByText('Test report sent to your email address')).toBeVisible({
      timeout: 30_000,
    })
    await expect
      .poll(
        async () => {
          const res = await fetch(`${mailURL}/messages?to=${encodeURIComponent(ADMIN.email)}`)
          const messages = (await res.json()) as { subject: string }[]
          return messages.some((message) => message.subject.includes(reportName))
        },
        { message: `test report mailed to ${ADMIN.email}`, timeout: 15_000 },
      )
      .toBe(true)

    // Print view: the report without the navigation and the page's controls.
    await expect(page.getByRole('button', { name: 'Print' })).toBeVisible()
    await page.emulateMedia({ media: 'print' })
    await expect(page.locator('aside').first()).toBeHidden()
    await expect(page.getByTestId('sla-send')).toBeHidden()
    await expect(page.getByRole('button', { name: 'Print' })).toBeHidden()
    await expect(page.getByTestId('sla-report')).toBeVisible()
    await expect(page.locator('[data-slot="page-header"]').getByText(SETUP_ORG.name)).toBeVisible()
  })
})
