import { mailURL } from './e2e-env'
import { ANONYMOUS, SETUP_ORG, expect, newSession, runId, test, type DocId } from './fixtures'

/**
 * Audience-specific status pages (#151, #278): a member signs in with the emailed link, sees only
 * their audience's components with a "viewing as" bar, and signs out; in the builder, "View as
 * audience" previews another audience and the subscriber list shows each subscriber's audiences.
 */
const run = runId()
const slug = `e2e-audience-${run}`
const member = `member-${run}@acme-${run}.test`

const created: { collection: string; id: DocId }[] = []
let pageId: DocId

async function lastStatusPageLink(email: string): Promise<string> {
  let link: string | undefined
  await expect
    .poll(
      async () => {
        const res = await fetch(`${mailURL}/messages?to=${encodeURIComponent(email)}`)
        const messages = (await res.json()) as { text: string }[]
        const text = messages.at(-1)?.text ?? ''
        link = text.match(/https?:\/\/\S+\/login\?token=[A-Za-z0-9_-]{43}/)?.[0]
        return link ?? null
      },
      { message: `status page sign-in link mailed to ${email}`, timeout: 15_000 },
    )
    .not.toBeNull()
  return link!
}

test.describe('Audience status pages', () => {
  test.beforeAll(async ({ adminApi }) => {
    const org = await adminApi.organizationId(SETUP_ORG.slug)
    const page = await adminApi.create<{ id: DocId; groups: { monitors: { id: string }[] }[] }>(
      'status-pages',
      {
        organization: org,
        title: 'E2E Customer Status',
        slug,
        published: true,
        access: 'audience',
        subscriptions: { enabled: true, channels: ['email'], deliveryMode: 'review' },
        groups: [
          { name: 'Acme cluster', monitors: [{ type: 'static', name: 'Acme gateway' }] },
          { name: 'Beta cluster', monitors: [{ type: 'static', name: 'Beta gateway' }] },
        ],
      },
    )
    pageId = page.id
    created.unshift({ collection: 'status-pages', id: page.id })
    const [acmeC, betaC] = page.groups.map((g) => g.monitors[0].id)
    const acme = await adminApi.create('status-page-audiences', {
      statusPage: page.id,
      organization: org,
      name: 'Acme Corp',
      components: [acmeC],
      emails: [member],
    })
    const beta = await adminApi.create('status-page-audiences', {
      statusPage: page.id,
      organization: org,
      name: 'Beta Ltd',
      components: [betaC],
      emailDomains: [`beta-${run}.test`],
    })
    created.unshift({ collection: 'status-page-audiences', id: acme.id })
    created.unshift({ collection: 'status-page-audiences', id: beta.id })
    const subscriber = await adminApi.create('status-page-subscribers', {
      statusPage: page.id,
      organization: org,
      channel: 'email',
      target: `ops-${run}@beta-${run}.test`,
      audiences: [beta.id],
      source: 'added_by_owner',
    })
    created.unshift({ collection: 'status-page-subscribers', id: subscriber.id })
  })

  test.afterAll(async ({ adminApi }) => {
    for (const { collection, id } of created) await adminApi.delete(collection, id).catch(() => {})
  })

  test('a member signs in with the emailed link, sees their audience and signs out', async ({
    browser,
  }) => {
    const { context, page } = await newSession(browser, ANONYMOUS)
    try {
      await page.goto(`/status/${slug}`)
      await expect(page).toHaveURL(new RegExp(`/status/${slug}/login$`))
      await expect(page.getByText(/only available to invited customers and teams/)).toBeVisible()
      await page.getByLabel('Email address').fill(member)
      await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
      await expect(page.getByText(/a sign-in link is on its way/)).toBeVisible()

      await page.goto(await lastStatusPageLink(member))
      await page.getByRole('button', { name: 'Continue to the status page' }).click()
      await expect(page).toHaveURL(new RegExp(`/status/${slug}$`))
      await expect(
        page.getByRole('heading', { level: 1, name: 'E2E Customer Status' }),
      ).toBeVisible()
      await expect(page.getByText('Acme gateway')).toBeVisible()
      await expect(page.getByText('Beta gateway')).toHaveCount(0)

      const bar = page.locator('[data-viewing-as]')
      await expect(bar).toContainText(`Signed in as ${member}`)
      await expect(bar).toContainText('Viewing as Acme Corp')

      await bar.getByRole('button', { name: 'Sign out' }).click()
      await expect(page).toHaveURL(new RegExp(`/status/${slug}/login$`))
      await page.goto(`/status/${slug}`)
      await expect(page).toHaveURL(new RegExp(`/status/${slug}/login$`))
    } finally {
      await context.close()
    }
  })

  test('the builder previews an audience and lists subscribers with their audiences', async ({
    page,
  }) => {
    await page.goto(`/${SETUP_ORG.slug}/status-pages/${pageId}`)
    await page.getByRole('tab', { name: 'Audiences' }).click()
    await expect(page.getByTestId('audience-list')).toContainText('Acme Corp')

    await page.getByRole('combobox', { name: 'Choose an audience' }).click()
    await page.getByRole('option', { name: 'Beta Ltd' }).click()
    const preview = page.getByTestId('audience-preview')
    await expect(preview.getByText('Beta gateway')).toBeVisible()
    await expect(preview.getByText('Acme gateway')).toHaveCount(0)

    await page.getByRole('tab', { name: 'Subscribers' }).click()
    const row = page.getByRole('row', { name: new RegExp(`ops-${run}@beta-${run}\\.test`) })
    await expect(row.locator('[data-subscriber-audiences]')).toHaveText(/Beta Ltd/)

    // Add the other audience from the list.
    await row.getByRole('button', { name: /Edit the audiences of/ }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('checkbox', { name: 'Acme Corp' }).check()
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Audiences updated')).toBeVisible()
    await expect(row.locator('[data-subscriber-audiences]')).toHaveText(/Acme Corp/)
  })
})
