import { expect, test } from '@playwright/test'
import { getPayload, type Payload } from 'payload'

import config from '@payload-config'

/**
 * Public status page: seeded through the Local API, visited anonymously. Drafts must 404.
 */
const run = Date.now().toString(36)
const publishedSlug = `e2e-status-${run}`
const draftSlug = `e2e-draft-${run}`

let payload: Payload
let orgId: string | number

test.describe('Status pages', () => {
  test.beforeAll(async () => {
    payload = await getPayload({ config })

    const org = await payload.create({
      collection: 'organizations',
      data: { name: 'E2E Status Org', slug: `e2e-status-org-${run}` },
    })
    orgId = org.id

    const monitor = await payload.create({
      collection: 'monitors',
      data: {
        name: 'Marketing site',
        type: 'http',
        url: 'https://example.com',
        active: true,
        interval: 60,
        retryInterval: 60,
        maxRetries: 0,
        resendInterval: 0,
        timeout: 48,
        organization: org.id,
        status: { lastStatus: 'up', lastCheckAt: new Date().toISOString(), lastPing: 120 },
      },
    })

    await payload.create({
      collection: 'heartbeats',
      data: {
        monitor: monitor.id,
        organization: org.id,
        status: 'up',
        ping: 120,
        time: new Date().toISOString(),
      },
    })

    const page = await payload.create({
      collection: 'status-pages',
      data: {
        organization: org.id,
        title: 'E2E Acme Status',
        slug: publishedSlug,
        description: 'Everything we run, in one place.',
        published: true,
        groups: [{ name: 'Public services', monitors: [{ monitor: monitor.id, sendUrl: true }] }],
      },
    })

    await payload.create({
      collection: 'incidents',
      data: {
        statusPage: page.id,
        organization: org.id,
        title: 'E2E planned maintenance',
        content: 'We are **upgrading** the database tonight.',
        style: 'warning',
      },
    })

    await payload.create({
      collection: 'status-pages',
      data: { organization: org.id, title: 'E2E Draft', slug: draftSlug, published: false },
    })
  })

  test.afterAll(async () => {
    if (!orgId) return
    await payload.delete({ collection: 'incidents', where: { organization: { equals: orgId } } })
    await payload.delete({ collection: 'status-pages', where: { organization: { equals: orgId } } })
    await payload.delete({ collection: 'heartbeats', where: { organization: { equals: orgId } } })
    await payload.delete({ collection: 'monitors', where: { organization: { equals: orgId } } })
    await payload.delete({ collection: 'organizations', id: orgId })
  })

  test('renders a published page anonymously', async ({ page }) => {
    await page.goto(`/status/${publishedSlug}`)
    await expect(page).toHaveTitle(/E2E Acme Status/)
    await expect(page.getByRole('heading', { level: 1, name: 'E2E Acme Status' })).toBeVisible()
    await expect(page.getByText('Everything we run, in one place.')).toBeVisible()
    await expect(page.getByRole('status')).toHaveText(/All systems operational/)
    await expect(page.getByRole('heading', { level: 2, name: 'Public services' })).toBeVisible()
    await expect(page.getByRole('link', { name: /Marketing site/ })).toHaveAttribute(
      'href',
      'https://example.com',
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
})
