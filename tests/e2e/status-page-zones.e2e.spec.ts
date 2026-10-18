import { expect, runId, SETUP_ORG, test, type DocId } from './fixtures'

/**
 * Translated status pages, extras (#271): incident times entered in the page's time zone, and
 * share snippets with the page's language prefix. Runs as the setup admin.
 */
const run = runId()
const slug = `e2e-zones-${run}`
let pageId: DocId | undefined

test.describe('Status page zones and languages', () => {
  test.beforeAll(async ({ adminApi }) => {
    const org = await adminApi.organizationId(SETUP_ORG.slug)
    const page = await adminApi.create('status-pages', {
      organization: org,
      title: 'E2E Zones',
      slug,
      published: true,
      timeZoneMode: 'page',
      timeZone: 'Pacific/Auckland',
      defaultLocale: 'en',
      additionalLocales: ['fr'],
    })
    pageId = page.id
  })

  test.afterAll(async ({ adminApi }) => {
    if (pageId === undefined) return
    const incidents = await adminApi.find('incidents', { statusPage: { equals: String(pageId) } })
    for (const incident of incidents) await adminApi.delete('incidents', incident.id as DocId)
    await adminApi.delete('status-pages', pageId)
  })

  test('back-dates an incident in the page time zone', async ({ page, adminApi }) => {
    await page.goto(`/${SETUP_ORG.slug}/status-pages/${pageId}`)
    await page.getByRole('tab', { name: 'Incidents' }).click()
    await page.getByRole('button', { name: 'New incident' }).click()

    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Title').fill('E2E back-dated outage')
    await expect(dialog.getByText('Times are in Pacific/Auckland.')).toBeVisible()
    // 09:30 in Auckland on 15 January (NZDT, UTC+13) is 20:30 UTC the day before.
    await dialog.getByLabel('Posted at (optional)').fill('2026-01-15T09:30')
    await dialog.getByRole('button', { name: 'Open incident' }).click()
    await expect(dialog).toBeHidden()

    const [incident] = await adminApi.find<{ updates?: { postedAt: string }[] }>(
      'incidents',
      { statusPage: { equals: String(pageId) } },
      { depth: '0' },
    )
    expect(incident?.updates?.[0]?.postedAt).toBe('2026-01-14T20:30:00.000Z')
    await expect(page.locator('time[datetime="2026-01-14T20:30:00.000Z"]').first()).toBeAttached()
  })

  test('builds badge and widget snippets in the chosen language', async ({ page }) => {
    await page.goto(`/${SETUP_ORG.slug}/status-pages/${pageId}`)
    await page.getByRole('tab', { name: 'Share' }).click()

    await expect(page.locator('#badge-markdown')).toHaveValue(
      new RegExp(`/status/${slug}/badge\\.svg`),
    )
    await page.locator('#badge-locale').click()
    await page.getByRole('option', { name: 'Français' }).click()
    await expect(page.locator('#badge-markdown')).toHaveValue(
      new RegExp(`/status/${slug}/fr/badge\\.svg`),
    )
    await expect(page.getByTestId('status-page-badge-preview')).toHaveAttribute(
      'src',
      new RegExp(`/status/${slug}/fr/badge\\.svg`),
    )

    await page.locator('#widget-locale').click()
    await page.getByRole('option', { name: 'Français' }).click()
    await expect(page.locator('#widget-html')).toHaveValue(
      new RegExp(`/status/${slug}/fr/widget\\.js`),
    )
    // The live preview loads the French widget, which reads the French status.json.
    await expect(page.getByTestId('status-widget-preview').locator('script')).toHaveAttribute(
      'src',
      new RegExp(`/status/${slug}/fr/widget\\.js$`),
    )
  })
})
