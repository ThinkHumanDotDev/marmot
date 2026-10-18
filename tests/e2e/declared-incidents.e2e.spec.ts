import { expect, runId, SETUP_ORG, targetUrl, test, type DocId } from './fixtures'

/**
 * Declared incident follow-ups (#285): declaring from a monitor incident in one click, editing the
 * details, action items, the Markdown postmortem once closed and the list filters. The outage is
 * seeded through the REST API as the setup admin.
 */
const run = runId()
const monitorName = `E2E Checkout ${run}`

const created: { collection: string; id: DocId }[] = []
let outageId: DocId

test.describe('Declared incidents', () => {
  test.beforeAll(async ({ adminApi }) => {
    const orgId = await adminApi.organizationId(SETUP_ORG.slug)
    const monitor = await adminApi.create('monitors', {
      name: monitorName,
      type: 'http',
      url: targetUrl('/'),
      active: false,
      interval: 60,
      organization: orgId,
    })
    created.unshift({ collection: 'monitors', id: monitor.id })
    const outage = await adminApi.create('monitor-incidents', {
      organization: orgId,
      monitor: monitor.id,
      status: 'open',
      cause: 'connect ECONNREFUSED',
      startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      timeline: [{ type: 'opened', at: new Date().toISOString() }],
    })
    outageId = outage.id
    created.unshift({ collection: 'monitor-incidents', id: outage.id })

    // For the list: a resolved major incident and an open critical one.
    const startedAt = new Date(Date.now() - 2 * 3600_000).toISOString()
    const major = await adminApi.create('declared-incidents', {
      organization: orgId,
      title: `Seeded major ${run}`,
      severity: 'major',
      startedAt,
    })
    await adminApi.update('declared-incidents', major.id, { status: 'resolved' })
    const critical = await adminApi.create('declared-incidents', {
      organization: orgId,
      title: `Seeded critical ${run}`,
      severity: 'critical',
      startedAt,
    })
    created.unshift(
      { collection: 'declared-incidents', id: major.id },
      { collection: 'declared-incidents', id: critical.id },
    )
  })

  test.afterAll(async ({ adminApi }) => {
    const declared = await adminApi.find('declared-incidents', {
      monitorIncident: { equals: String(outageId) },
    })
    for (const doc of declared) await adminApi.delete('declared-incidents', doc.id as DocId)
    for (const { collection, id } of created) {
      await adminApi.delete(collection, id).catch(() => undefined)
    }
  })

  test('declares from a monitor incident, edits it, tracks action items and closes it', async ({
    page,
  }) => {
    test.slow()
    const outagePath = `/${SETUP_ORG.slug}/incidents/${outageId}`
    await page.goto(outagePath)
    await page.getByTestId('declare-from-monitor').click()
    await page.waitForURL(/\/declared-incidents\/[^/]+$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${monitorName} is down`)
    await expect(page.getByText(`${monitorName} outage`)).toBeVisible()

    // Title, summary and start time.
    await page.getByTestId('declared-edit').click()
    await page.getByTestId('declared-edit-title').fill(`Checkout outage ${run}`)
    await page.getByTestId('declared-edit-summary').fill('Payments fail for every customer.')
    await page.getByTestId('declared-edit-save').click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Checkout outage ${run}`)
    await expect(page.getByTestId('declared-summary')).toHaveText(
      'Payments fail for every customer.',
    )
    await expect(page.getByTestId('declared-timeline')).toContainText(
      `Renamed the incident to “Checkout outage ${run}”`,
    )

    // Action items.
    await page.getByTestId('action-item-title').fill('Alert on payment errors')
    await page.getByTestId('action-item-submit').click()
    const item = page.getByTestId('action-item')
    await expect(item).toHaveCount(1)
    // Controlled: the box flips once the change is saved.
    await item.getByRole('checkbox').click()
    await expect(item).toHaveAttribute('data-done', 'true')

    // Postmortem: written, previewed, approved; rendered from Markdown once closed.
    await page
      .getByTestId('postmortem-content')
      .fill(
        '## Root cause\n\nA **bad** deploy.\n\n<script>window.pwned = true</script>\n\n- rolled back',
      )
    await page.getByTestId('postmortem-preview').click()
    await expect(page.getByTestId('postmortem-rendered').locator('h4')).toHaveText('Root cause')
    await page.getByTestId('postmortem-preview').click()
    await page.getByTestId('postmortem-approve').click()
    await expect(page.getByTestId('postmortem-status')).toHaveText('Approved')
    await page.getByTestId('declared-to-resolved').click()
    await page.getByTestId('declared-to-closed').click()
    await page.getByTestId('declared-confirm').click()
    await expect(page.getByTestId('declared-edit')).toHaveCount(0)

    const rendered = page.getByTestId('postmortem-rendered')
    await expect(rendered.locator('h4')).toHaveText('Root cause')
    await expect(rendered.locator('strong')).toHaveText('bad')
    await expect(rendered.locator('li')).toHaveText('rolled back')
    await expect(rendered.locator('script')).toHaveCount(0)
    await expect(rendered).toContainText('<script>window.pwned = true</script>')
    expect(await page.evaluate(() => (window as { pwned?: boolean }).pwned)).toBeUndefined()

    // The outage now links to it.
    await page.goto(outagePath)
    await page.getByTestId('view-declared-incident').click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Checkout outage ${run}`)
  })

  test('filters the list by severity and summarizes it', async ({ page }) => {
    await page.goto(`/${SETUP_ORG.slug}/declared-incidents?status=all&severity=major`)
    const rows = page.getByTestId('declared-row')
    await expect(rows.filter({ hasText: `Seeded major ${run}` })).toHaveCount(1)
    await expect(rows.filter({ hasText: `Seeded critical ${run}` })).toHaveCount(0)
    await expect(page.getByTestId('declared-stat-mttr')).not.toContainText('No data')

    // Changing a filter keeps the others.
    await page.getByTestId('declared-filter-severity').click()
    await page.getByRole('option', { name: 'Critical' }).click()
    await expect(page).toHaveURL(/severity=critical/)
    await expect(page).toHaveURL(/status=all/)
    await expect(rows.filter({ hasText: `Seeded critical ${run}` })).toHaveCount(1)
    await expect(rows.filter({ hasText: `Seeded major ${run}` })).toHaveCount(0)
  })
})
