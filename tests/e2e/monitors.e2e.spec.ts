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

/**
 * Monitor list search, filters and bulk actions (#124): filter to `status:down tag:prod`, select all
 * shown monitors and pause them in one action. Runs in its own organization so other specs'
 * monitors do not show up.
 */
test.describe('Monitor list bulk actions', () => {
  const run = runId()
  const org = { name: `Bulk Org ${run}`, slug: `e2e-bulk-${run}` }
  const created: { collection: string; id: DocId }[] = []
  const ids: Record<'downA' | 'downB' | 'upTagged' | 'downUntagged', DocId> = {} as never

  test.beforeAll(async ({ adminApi }) => {
    const track = <T extends { id: DocId }>(collection: string, doc: T): T => {
      created.unshift({ collection, id: doc.id })
      return doc
    }
    const organization = track('organizations', await adminApi.create('organizations', org))
    const prod = track(
      'tags',
      await adminApi.create('tags', {
        name: 'prod',
        color: '#DC2626',
        organization: organization.id,
      }),
    )
    const monitor = async (name: string, path: string, tagged: boolean) =>
      track(
        'monitors',
        await adminApi.createMonitor({
          name: `${name} ${run}`,
          type: 'http',
          url: targetUrl(path),
          active: true,
          interval: 60,
          retryInterval: 60,
          maxRetries: 0,
          resendInterval: 0,
          timeout: 48,
          organization: organization.id,
          tags: tagged ? [{ tag: prod.id }] : [],
        }),
      ).id
    ids.downA = await monitor('Down A', '/down', true)
    ids.downB = await monitor('Down B', '/down', true)
    ids.upTagged = await monitor('Up tagged', '/health', true)
    ids.downUntagged = await monitor('Down untagged', '/down', false)
    await adminApi.waitForHeartbeat(ids.downA, 'down')
    await adminApi.waitForHeartbeat(ids.downB, 'down')
    await adminApi.waitForHeartbeat(ids.upTagged, 'up')
    await adminApi.waitForHeartbeat(ids.downUntagged, 'down')
  })

  test.afterAll(async ({ adminApi }) => {
    for (const { collection, id } of created) await adminApi.delete(collection, id)
  })

  test('filters to status:down tag:prod, selects all and pauses them', async ({
    page,
    adminApi,
  }) => {
    await page.goto(`/${org.slug}/monitors`)
    const list = page.getByRole('list', { name: 'Monitors', exact: true })
    await expect(list.getByRole('link', { name: new RegExp(`Down A ${run}`) })).toBeVisible()

    // `/` focuses the search; filter tokens narrow the list and land in the URL.
    await page.getByRole('heading', { level: 1 }).click()
    await page.keyboard.press('/')
    const search = page.getByRole('searchbox', { name: 'Search monitors' })
    await expect(search).toBeFocused()
    await search.fill('status:down tag:prod')
    await expect(page).toHaveURL(/q=status%3Adown\+tag%3Aprod/)
    await expect(list.getByRole('listitem')).toHaveCount(2)
    await expect(list.getByRole('link', { name: new RegExp(`Down B ${run}`) })).toBeVisible()
    await expect(list.getByRole('link', { name: new RegExp(`Up tagged ${run}`) })).toHaveCount(0)

    // The filtered view survives a reload (shareable URL).
    await page.reload()
    await expect(search).toHaveValue('status:down tag:prod')
    await expect(list.getByRole('listitem')).toHaveCount(2)

    await page.getByRole('checkbox', { name: 'Select all shown monitors' }).check()
    await expect(page.getByText('2 selected')).toBeVisible()
    await page
      .getByRole('toolbar', { name: 'Bulk actions' })
      .getByRole('button', { name: 'Pause' })
      .click()

    // Paused monitors leave the `status:down` view live, without a reload.
    await expect(page.getByText('No monitors match')).toBeVisible()
    const monitors = await adminApi.find<{ id: DocId; active?: boolean }>('monitors', {
      organization: { equals: String(await adminApi.organizationId(org.slug)) },
    })
    const active = Object.fromEntries(monitors.map((m) => [String(m.id), m.active]))
    expect(active[String(ids.downA)]).toBe(false)
    expect(active[String(ids.downB)]).toBe(false)
    expect(active[String(ids.upTagged)]).toBe(true)
    expect(active[String(ids.downUntagged)]).toBe(true)

    // The status filter menu shows them as paused.
    await search.fill('')
    await page.getByRole('button', { name: 'Status', exact: true }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Paused' }).click()
    await page.keyboard.press('Escape')
    await expect(page).toHaveURL(/status=paused/)
    await expect(list.getByRole('listitem')).toHaveCount(2)

    // Keyboard selection: Space toggles a row, Shift+↓ extends the selection to the next one.
    await list.getByRole('checkbox').first().focus()
    await page.keyboard.press('Space')
    await expect(page.getByText('1 selected')).toBeVisible()
    await page.keyboard.press('Shift+ArrowDown')
    await expect(page.getByText('2 selected')).toBeVisible()

    // The command palette runs bulk actions on the selection.
    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await palette.getByRole('option', { name: 'Resume 2 selected monitors' }).click()
    await expect(page.getByText('No monitors match')).toBeVisible()
    await expect
      .poll(async () => {
        const docs = await adminApi.find<{ id: DocId; active?: boolean }>('monitors', {
          id: { in: `${String(ids.downA)},${String(ids.downB)}` },
        })
        return docs.map((m) => m.active)
      })
      .toEqual([true, true])
  })
})
