import { expect, runId, SETUP_ORG, test, type DocId } from './fixtures'

/**
 * Custom metrics in the status page builder (#280): an admin picks two metrics for a page in the
 * editor's Metrics tab, orders them and saves; visitors see them in that order, the headline value
 * coloured and labelled by its threshold state.
 */
const run = runId()
const slug = `e2e-metrics-${run}`
const created: { collection: string; id: DocId }[] = []
let pageId: DocId | undefined
const metricUrls: string[] = []

test.describe('Status page metrics', () => {
  test.beforeAll(async ({ adminApi }) => {
    const organization = await adminApi.organizationId(SETUP_ORG.slug)
    const page = await adminApi.create('status-pages', {
      organization,
      title: 'E2E Metrics Status',
      slug,
      published: true,
    })
    pageId = page.id
    created.push({ collection: 'status-pages', id: page.id })

    for (const [name, value] of [
      [`Error rate ${run}`, 12],
      [`Queue depth ${run}`, 3],
    ] as const) {
      // Through the management API: `/api/metrics` is the Prometheus endpoint, not the collection.
      const made = await adminApi.context.fetch(`/api/orgs/${organization}/metrics`, {
        method: 'POST',
        data: {
          name,
          visible: true,
          thresholds: { warning: 5, critical: 10 },
          showThresholdState: true,
        },
      })
      expect(made.status()).toBe(201)
      const metric = ((await made.json()) as { doc: { id: string } }).doc
      metricUrls.push(`/api/orgs/${organization}/metrics/${metric.id}`)
      const res = await adminApi.context.fetch(
        `/api/orgs/${organization}/metrics/${metric.id}/points`,
        { method: 'POST', data: { value } },
      )
      expect(res.status()).toBe(202)
    }
  })

  test.afterAll(async ({ adminApi }) => {
    for (const url of metricUrls) await adminApi.context.fetch(url, { method: 'DELETE' })
    for (const { collection, id } of created) await adminApi.delete(collection, id)
  })

  test('picks and orders the metrics of a page in the builder', async ({ page, anonymousPage }) => {
    await page.goto(`/${SETUP_ORG.slug}/status-pages/${pageId}`)
    await page.getByRole('tab', { name: 'Metrics' }).click()

    const panel = page.getByTestId('page-metrics-panel')
    await panel.getByRole('button', { name: `Add Error rate ${run}` }).click()
    await panel.getByRole('button', { name: `Add Queue depth ${run}` }).click()
    await panel.getByRole('button', { name: `Move Queue depth ${run} up` }).click()
    await expect(panel.getByTestId('page-metrics-selected').getByRole('listitem')).toHaveText([
      new RegExp(`Queue depth ${run}`),
      new RegExp(`Error rate ${run}`),
    ])
    await panel.getByTestId('page-metrics-save').click()
    await expect(page.getByText('Metrics saved.')).toBeVisible()

    await anonymousPage.goto(`/status/${slug}`)
    const section = anonymousPage.getByTestId('status-page-metrics')
    await expect(section.getByRole('heading', { level: 3 })).toHaveText([
      `Queue depth ${run}`,
      `Error rate ${run}`,
    ])
    const states = section.getByTestId('metric-state')
    await expect(states).toHaveText([/Normal/, /Critical/])
    await expect(section.getByTestId('metric-current').nth(1)).toHaveAttribute(
      'data-state',
      'critical',
    )
  })
})
