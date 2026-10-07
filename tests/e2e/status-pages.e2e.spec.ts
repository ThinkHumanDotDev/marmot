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
const protectedSlug = `e2e-protected-${run}`
const protectedPassword = 'e2e page password'
const teamSlug = `e2e-team-${run}`
const officeSlug = `e2e-office-${run}`

const created: { collection: string; id: DocId }[] = []

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
      await adminApi.create('status-pages', {
        organization: org.id,
        title: 'E2E Acme Status',
        slug: publishedSlug,
        description: 'Everything we run, in one place.',
        published: true,
        groups: [{ name: 'Public services', monitors: [{ monitor: monitor.id, sendUrl: true }] }],
      }),
    )

    track(
      'incidents',
      await adminApi.create('incidents', {
        statusPage: page.id,
        organization: org.id,
        title: 'E2E planned maintenance',
        content: 'We are **upgrading** the database tonight.',
        style: 'warning',
      }),
    )

    track(
      'status-pages',
      await adminApi.create('status-pages', {
        organization: org.id,
        title: 'E2E Draft',
        slug: draftSlug,
        published: false,
      }),
    )

    track(
      'status-pages',
      await adminApi.create('status-pages', {
        organization: org.id,
        title: 'E2E Internal Status',
        slug: protectedSlug,
        description: 'Only for the team.',
        published: true,
        access: 'password',
        password: protectedPassword,
        groups: [{ name: 'Internal services', monitors: [{ monitor: monitor.id }] }],
      }),
    )
    track(
      'status-pages',
      await adminApi.create('status-pages', {
        organization: org.id,
        title: 'E2E Team Status',
        slug: teamSlug,
        published: true,
        access: 'email-domain',
        allowedEmailDomains: [{ domain: 'example.com' }],
        groups: [{ name: 'Team services', monitors: [{ monitor: monitor.id }] }],
      }),
    )
    track(
      'status-pages',
      await adminApi.create('status-pages', {
        organization: org.id,
        title: 'E2E Office Status',
        slug: officeSlug,
        published: true,
        access: 'ip-allowlist',
        // Documentation range: no test client comes from there.
        allowedIpRanges: [{ cidr: '192.0.2.0/24' }],
        groups: [{ name: 'Office services', monitors: [{ monitor: monitor.id }] }],
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
    await expect(
      page.getByRole('heading', { level: 3, name: 'E2E planned maintenance' }),
    ).toBeVisible()
    await expect(page.locator('strong', { hasText: 'upgrading' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Powered by Marmot' })).toBeVisible()
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/)
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

  test('password-protected page: login form, then the page and its feeds', async ({
    page,
    request,
  }) => {
    // Anonymous machine clients get 401 everywhere.
    expect((await request.get(`/api/status-pages/${protectedSlug}/public`)).status()).toBe(401)
    expect((await request.get(`/status/${protectedSlug}/rss`)).status()).toBe(401)

    await page.goto(`/status/${protectedSlug}`)
    await expect(page).toHaveURL(new RegExp(`/status/${protectedSlug}/login$`))
    await expect(page.getByRole('heading', { level: 1, name: 'E2E Internal Status' })).toBeVisible()
    await expect(page.getByText('Only for the team.')).toHaveCount(0)
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/)

    await page.getByLabel('Password').fill('not the password')
    await page.getByRole('button', { name: 'View status page' }).click()
    await expect(page.getByText('That password is not correct.')).toBeVisible()

    await page.getByLabel('Password').fill(protectedPassword)
    await page.getByRole('button', { name: 'View status page' }).click()
    await expect(page).toHaveURL(new RegExp(`/status/${protectedSlug}$`))
    await expect(page.getByRole('heading', { level: 2, name: 'Internal services' })).toBeVisible()
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/)

    // The browser context now carries the access cookie for the API and the feed.
    const api = await page.request.get(`/api/status-pages/${protectedSlug}/public`)
    expect(api.status()).toBe(200)
    expect(api.headers()['cache-control']).toBe('private, no-store')
    expect((await page.request.get(`/status/${protectedSlug}/rss`)).status()).toBe(200)
  })

  test('email-domain page: email form, then the same "check your inbox" for any address', async ({
    page,
    request,
  }) => {
    expect((await request.get(`/api/status-pages/${teamSlug}/public`)).status()).toBe(401)

    await page.goto(`/status/${teamSlug}`)
    await expect(page).toHaveURL(new RegExp(`/status/${teamSlug}/login$`))
    await expect(page.getByRole('heading', { level: 1, name: 'E2E Team Status' })).toBeVisible()
    await expect(page.getByText('Team services')).toHaveCount(0)

    await page.getByLabel('Email address').fill(`someone-${run}@not-allowed.example.org`)
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
    await expect(page).toHaveURL(new RegExp(`/status/${teamSlug}/login\\?sent=1$`))
    await expect(page.getByText(/a sign-in link is on its way/)).toBeVisible()

    // A link that was never issued does not sign anyone in.
    await page.goto(`/status/${teamSlug}/login?token=${'x'.repeat(43)}`)
    await page.getByRole('button', { name: 'Continue to the status page' }).click()
    await expect(page.getByText(/invalid, has expired or was already used/)).toBeVisible()
  })

  test('IP allow-listed page: restricted screen and 403 outside the ranges', async ({
    page,
    request,
  }) => {
    expect((await request.get(`/api/status-pages/${officeSlug}/public`)).status()).toBe(403)
    expect((await request.get(`/status/${officeSlug}/rss`)).status()).toBe(403)

    await page.goto(`/status/${officeSlug}`)
    await expect(page.getByRole('heading', { level: 1, name: 'E2E Office Status' })).toBeVisible()
    await expect(page.getByText(/only available from approved networks/)).toBeVisible()
    await expect(page.getByText('Office services')).toHaveCount(0)
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/)
  })
})
