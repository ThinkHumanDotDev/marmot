import { ANONYMOUS, expect, runId, targetUrl, test, type DocId } from './fixtures'

/**
 * Public status page details (incidents, API, RSS, manifest, drafts): seeded through the REST API as
 * the setup admin, visited anonymously. Creating and publishing a page through the UI is part of
 * the critical path (`critical-path.e2e.spec.ts`).
 */
const run = runId()
const monitorUrl = targetUrl('/')
const publishedSlug = `e2e-status-${run}`
const draftSlug = `e2e-draft-${run}`

const created: { collection: string; id: DocId }[] = []
const seeded: { org?: DocId; page?: DocId; component?: string } = {}

test.use({ storageState: ANONYMOUS })

test.describe('Status pages', () => {
  test.beforeAll(async ({ adminApi }) => {
    const track = <T extends { id: DocId }>(collection: string, doc: T): T => {
      created.unshift({ collection, id: doc.id })
      return doc
    }

    const org = track(
      'organizations',
      await adminApi.create('organizations', {
        name: 'E2E Status Org',
        slug: `e2e-status-org-${run}`,
      }),
    )

    const monitor = track(
      'monitors',
      await adminApi.createMonitor({
        name: 'Marketing site',
        type: 'http',
        url: monitorUrl,
        active: true,
        interval: 60,
        retryInterval: 60,
        maxRetries: 0,
        resendInterval: 0,
        timeout: 48,
        organization: org.id,
      }),
    )
    // The worker checks the local target server; the page reports it once a beat exists.
    await adminApi.waitForHeartbeat(monitor.id, 'up')

    const page = track(
      'status-pages',
      await adminApi.create<{ id: DocId; groups: { monitors: { id: string }[] }[] }>(
        'status-pages',
        {
          organization: org.id,
          title: 'E2E Acme Status',
          slug: publishedSlug,
          description: 'Everything we run, in one place.',
          published: true,
          groups: [
            { name: 'Public services', monitors: [{ monitor: monitor.id, sendUrl: true }] },
            {
              name: 'People',
              defaultOpen: false,
              monitors: [{ type: 'static', name: 'Customer support' }],
            },
          ],
        },
      ),
    )

    track(
      'incidents',
      await adminApi.create('incidents', {
        statusPage: page.id,
        organization: org.id,
        title: 'E2E planned maintenance',
        // Pre-timeline shape (content + style): still accepted and shown as one update.
        content: 'We are **upgrading** the database tonight.',
        style: 'info',
      }),
    )

    // The monitor's component id (its group row id) is what incident updates reference.
    Object.assign(seeded, { org: org.id, page: page.id, component: page.groups[0].monitors[0].id })

    track(
      'status-pages',
      await adminApi.create('status-pages', {
        organization: org.id,
        title: 'E2E Draft',
        slug: draftSlug,
        published: false,
      }),
    )
  })

  test.afterAll(async ({ adminApi }) => {
    // Newest first, so nothing is deleted while something still references it.
    for (const { collection, id } of created) await adminApi.delete(collection, id)
  })

  test('renders a published page anonymously', async ({ page }) => {
    await page.goto(`/status/${publishedSlug}`)
    await expect(page).toHaveTitle(/E2E Acme Status/)
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.getByRole('heading', { level: 1, name: 'E2E Acme Status' })).toBeVisible()
    await expect(page.getByText('Everything we run, in one place.')).toBeVisible()
    await expect(page.getByRole('status')).toHaveText(/All systems operational/)
    await expect(page.getByRole('heading', { level: 2, name: 'Public services' })).toBeVisible()
    await expect(page.getByRole('link', { name: /Marketing site/ })).toHaveAttribute(
      'href',
      monitorUrl,
    )
    // Collapsed group: closed on load, opens on click (#106).
    const people = page.getByRole('button', { name: 'People' })
    await expect(people).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByText('Customer support')).toBeHidden()
    await people.click()
    await expect(people).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByText('Customer support')).toBeVisible()
    await expect(
      page.getByRole('heading', { level: 3, name: 'E2E planned maintenance' }),
    ).toBeVisible()
    await expect(page.locator('strong', { hasText: 'upgrading' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Powered by Marmot' })).toBeVisible()
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/)
  })

  test('shows the incident timeline and component impact until resolved', async ({
    page,
    adminApi,
  }) => {
    const incident = await adminApi.create('incidents', {
      statusPage: seeded.page,
      organization: seeded.org,
      title: 'E2E site outage',
      updates: [
        {
          status: 'investigating',
          message: 'The site is unreachable.',
          components: [{ component: seeded.component, impact: 'major_outage' }],
        },
        { status: 'identified', message: 'A bad **certificate**.' },
      ],
    })
    created.unshift({ collection: 'incidents', id: incident.id })

    await page.goto(`/status/${publishedSlug}`)
    // The monitor counts as down; the static component is still up.
    await expect(page.getByRole('status')).toHaveText(/Partially degraded/)
    await expect(page.locator(`[data-monitor-impact="major_outage"]`)).toContainText(
      'Marketing site',
    )
    const card = page.locator('article', {
      has: page.getByRole('heading', { level: 3, name: 'E2E site outage' }),
    })
    // Latest update inline, the rest behind the disclosure.
    await expect(card.locator('strong', { hasText: 'certificate' })).toBeVisible()
    await expect(card.getByText('The site is unreachable.')).toBeHidden()
    await card.getByText(/Show all 2 updates/).click()
    await expect(card.getByText('The site is unreachable.')).toBeVisible()
    await expect(card.locator('time')).toHaveCount(2)

    await adminApi.update('incidents', incident.id, { active: false })
    await page.reload()
    await expect(page.getByRole('status')).toHaveText(/All systems operational/)
    await expect(page.locator('[data-monitor-impact]')).toHaveCount(0)
  })

  test('serves the public API, RSS feed and manifest', async ({ request }) => {
    const api = await request.get(`/api/status-pages/${publishedSlug}/public`)
    expect(api.ok()).toBeTruthy()
    const body = await api.json()
    expect(body.config.slug).toBe(publishedSlug)
    expect(body.groups[0].monitors[0].name).toBe('Marketing site')

    const rss = await request.get(`/status/${publishedSlug}/rss`)
    expect(rss.ok()).toBeTruthy()
    expect(rss.headers()['content-type']).toContain('application/rss+xml')
    expect(await rss.text()).toContain('E2E planned maintenance')

    const manifest = await request.get(`/status/${publishedSlug}/manifest.json`)
    expect(manifest.ok()).toBeTruthy()
    expect((await manifest.json()).name).toBe('E2E Acme Status')
  })

  test('returns 404 for unpublished and unknown pages', async ({ page, request }) => {
    const draft = await page.goto(`/status/${draftSlug}`)
    expect(draft?.status()).toBe(404)
    await expect(page.getByText(/not found/i).first()).toBeVisible()

    const api = await request.get(`/api/status-pages/${draftSlug}/public`)
    expect(api.status()).toBe(404)
    const missing = await request.get(`/status/does-not-exist-${run}/rss`)
    expect(missing.status()).toBe(404)
  })
})
