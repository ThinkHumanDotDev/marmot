import { expect, runId, SETUP_ORG, targetUrl, test, type DocId } from './fixtures'

/**
 * Monitor form validation and pause/resume. Creating a monitor and watching its first heartbeat is
 * part of the critical path (`critical-path.e2e.spec.ts`); here the monitor is seeded.
 */
const monitorName = `Seeded check ${runId()}`
let monitorId: DocId
let prometheusId: DocId

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
    const prometheus = await adminApi.createMonitor({
      name: `Error rate ${runId()}`,
      type: 'prometheus',
      url: targetUrl('/'),
      prometheusQuery: 'sum(rate(http_requests_total{code=~"5.."}[5m]))',
      prometheusDownOperator: '>',
      prometheusDownThreshold: 0.05,
      active: false,
      interval: 60,
      retryInterval: 60,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 48,
      organization,
    })
    prometheusId = prometheus.id
  })

  test.afterAll(async ({ adminApi }) => {
    if (monitorId !== undefined) await adminApi.delete('monitors', monitorId)
    if (prometheusId !== undefined) await adminApi.delete('monitors', prometheusId)
  })

  test('charts the query value of a Prometheus monitor and edits its conditions', async ({
    page,
  }) => {
    await page.goto(`/${SETUP_ORG.slug}/monitors/${prometheusId}`)
    const main = page.locator('#main-content')
    await expect(main.getByTestId('value-chart')).toBeVisible()
    await expect(main.getByTestId('response-time-chart')).toHaveCount(0)
    await expect(main.getByTestId('metric-average-value')).toBeVisible()

    await page.goto(`/${SETUP_ORG.slug}/monitors/${prometheusId}/edit`)
    // Visible form only; see the note in critical-path.e2e.spec.ts.
    const fields = page.getByTestId('monitor-form').filter({ visible: true })
    await expect(fields.getByTestId('prometheus-card')).toBeVisible()
    await expect(fields.getByLabel('PromQL query')).toHaveValue(/http_requests_total/)
    await expect(fields.getByLabel('DOWN threshold')).toHaveValue('0.05')
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

  test('creates a TLS handshake monitor with its certificate panel (#141)', async ({
    page,
    adminApi,
  }) => {
    await page.goto(`/${SETUP_ORG.slug}/monitors/new?type=tls`)
    const fields = page.getByTestId('monitor-form').filter({ visible: true })
    await expect(fields.getByTestId('monitor-type')).toContainText('TLS Handshake')
    const name = `TLS ${runId()}`
    await fields.getByLabel('Friendly name').fill(name)
    await fields.getByLabel('Hostname').fill('127.0.0.1')
    await fields.getByLabel('Server name (SNI)').fill('localhost')
    await fields.getByLabel('ALPN protocols').fill('h2, http/1.1')
    await expect(fields.getByLabel('Certificate expiry notification')).toBeVisible()
    await fields.getByTestId('monitor-submit').click()

    // The detail page of the new monitor (not the form's own `/monitors/new?type=tls`).
    await expect(page).toHaveURL(new RegExp(`/${SETUP_ORG.slug}/monitors/(?!new)[^/?]+$`))
    const id = new URL(page.url()).pathname.split('/').pop()!
    try {
      await expect(page.getByTestId('monitor-name')).toHaveText(name)
      await expect(page.getByTestId('certificate-panel')).toBeVisible()
    } finally {
      await adminApi.delete('monitors', id)
    }
  })

  test('creates a mobile PageSpeed monitor with a performance minimum (#137)', async ({
    page,
    adminApi,
  }) => {
    await page.goto(`/${SETUP_ORG.slug}/monitors/new?type=pagespeed`)
    const fields = page.getByTestId('monitor-form').filter({ visible: true })
    await expect(fields.getByTestId('monitor-type')).toContainText('PageSpeed / Lighthouse')
    await expect(fields.getByTestId('pagespeed-card')).toBeVisible()
    const name = `PageSpeed ${runId()}`
    await fields.getByLabel('Friendly name').fill(name)
    // The target server answers for PageSpeed Insights (`PAGESPEED_API_URL`): "slow" scores 54.
    await fields.getByLabel('URL', { exact: true }).fill('https://slow.example.com/')
    await fields.getByLabel('Performance minimum score').fill('70')

    // The interval starts at, and may not go below, 15 minutes.
    const interval = fields.getByLabel('Heartbeat interval')
    await expect(interval).toHaveValue('900')
    await expect(interval).toHaveAttribute('min', '900')
    await interval.fill('300')
    await fields.getByTestId('monitor-submit').click()
    await expect(
      page.getByText('PageSpeed monitors run at most every 15 minutes: at least 900 seconds'),
    ).toBeVisible()
    await interval.fill('900')
    await fields.getByTestId('monitor-submit').click()

    await expect(page).toHaveURL(new RegExp(`/${SETUP_ORG.slug}/monitors/(?!new)[^/?]+$`))
    const id = new URL(page.url()).pathname.split('/').pop()!
    try {
      const [monitor] = await adminApi.find('monitors', { id: { equals: id } })
      expect(monitor).toMatchObject({
        type: 'pagespeed',
        pagespeedBackend: 'psi',
        pagespeedStrategy: 'mobile',
        pagespeedMinPerformance: 70,
        interval: 900,
      })
      // The first run lands below the minimum: degraded, scores charted, report linked.
      await expect(async () => {
        await page.reload()
        await expect(page.getByTestId('pagespeed-latest')).toBeVisible({ timeout: 1_000 })
      }).toPass({ timeout: 45_000 })
      await expect(page.getByTestId('pagespeed-score-performance')).toContainText('54')
      await expect(page.getByTestId('pagespeed-report-link')).toHaveAttribute(
        'href',
        /pagespeed\.web\.dev\/analysis\?url=https%3A%2F%2Fslow\.example\.com/,
      )
      await expect(page.getByTestId('pagespeed-scores-chart')).toBeVisible()
      await expect(page.getByText('performance 54 < 70 (mobile)').first()).toBeVisible()
    } finally {
      await adminApi.delete('monitors', id)
    }
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

  test('adds the selection to a maintenance window and a status page group (#262)', async ({
    page,
    adminApi,
  }) => {
    const organization = await adminApi.organizationId(org.slug)
    const maintenanceWindow = await adminApi.create('maintenance', {
      organization,
      title: `Bulk window ${run}`,
      strategy: 'manual',
      active: false,
    })
    created.unshift({ collection: 'maintenance', id: maintenanceWindow.id })
    const statusPage = await adminApi.create('status-pages', {
      organization,
      title: `Bulk page ${run}`,
      slug: `e2e-bulk-page-${run}`,
      groups: [{ name: 'Core services', monitors: [] }],
    })
    created.unshift({ collection: 'status-pages', id: statusPage.id })

    await page.goto(`/${org.slug}/monitors?q=${encodeURIComponent('tag:prod')}`)
    const list = page.getByRole('list', { name: 'Monitors', exact: true })
    await expect(list.getByRole('listitem')).toHaveCount(3)
    await page.getByRole('checkbox', { name: 'Select all shown monitors' }).check()
    await expect(page.getByText('3 selected')).toBeVisible()

    const toolbar = page.getByRole('toolbar', { name: 'Bulk actions' })
    await toolbar.getByRole('button', { name: 'Maintenance' }).click()
    await page.getByRole('menuitem', { name: `Bulk window ${run}` }).click()
    await expect(page.getByText('Added 3 monitors to the maintenance window.')).toBeVisible()
    const stored = await adminApi.find<{ id: DocId; monitors?: unknown[] }>('maintenance', {
      id: { equals: String(maintenanceWindow.id) },
    })
    expect(stored[0].monitors).toHaveLength(3)

    // From the command palette: it opens the bar's menu to pick the page and the group.
    await page.getByRole('checkbox', { name: 'Select all shown monitors' }).check()
    await page.keyboard.press('ControlOrMeta+k')
    await page
      .getByRole('dialog', { name: 'Command palette' })
      .getByRole('option', { name: 'Add 3 selected monitors to a status page group…' })
      .click()
    await page.getByRole('menuitem', { name: `Bulk page ${run}` }).click()
    await page.getByRole('menuitem', { name: 'Core services' }).click()
    await expect(page.getByText('Added 3 monitors to the status page group.')).toBeVisible()
    await expect
      .poll(async () => {
        const [doc] = await adminApi.find<{ groups?: { monitors?: unknown[] }[] }>('status-pages', {
          id: { equals: String(statusPage.id) },
        })
        return doc?.groups?.[0]?.monitors?.length
      })
      .toBe(3)
  })
})

/**
 * Table view of the monitor list (#276): switch to the table, sort by 24 h uptime, hide a column,
 * reload into the same view, and select rows with the keyboard for a bulk action.
 */
test.describe('Monitor table view', () => {
  const run = runId()
  const org = { name: `Table Org ${run}`, slug: `e2e-table-${run}` }
  const created: { collection: string; id: DocId }[] = []
  const ids: Record<'up' | 'down', DocId> = {} as never

  test.beforeAll(async ({ adminApi }) => {
    const track = <T extends { id: DocId }>(collection: string, doc: T): T => {
      created.unshift({ collection, id: doc.id })
      return doc
    }
    const organization = track('organizations', await adminApi.create('organizations', org))
    const monitor = async (name: string, path: string) =>
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
        }),
      ).id
    // Named so that the name order differs from the uptime order.
    ids.up = await monitor('Alpha up', '/health')
    ids.down = await monitor('Zulu down', '/down')
    await adminApi.waitForHeartbeat(ids.up, 'up')
    await adminApi.waitForHeartbeat(ids.down, 'down')
  })

  test.afterAll(async ({ adminApi }) => {
    for (const { collection, id } of created) await adminApi.delete(collection, id)
  })

  test('switches to a sortable table that is remembered and keeps bulk selection', async ({
    page,
    adminApi,
  }) => {
    await page.goto(`/${org.slug}/monitors`)
    await expect(
      page.getByRole('list', { name: 'Monitors', exact: true }).getByRole('listitem'),
    ).toHaveCount(2)

    const views = page.getByRole('group', { name: 'View' })
    await views.getByRole('button', { name: 'Table' }).click()
    await expect(views.getByRole('button', { name: 'Table' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    const table = page.getByRole('table', { name: 'Monitors' })
    const rows = table.locator('tbody tr')
    await expect(rows).toHaveCount(2)
    await expect(rows.first()).toContainText(`Alpha up ${run}`)
    await expect(table.getByRole('columnheader', { name: /^Name/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )

    // Sorting by 24 h uptime: ascending puts the failing monitor first, again flips it.
    const uptime = table.getByRole('columnheader', { name: /Uptime \(24h\)/ })
    await uptime.getByRole('button').click()
    await expect(uptime).toHaveAttribute('aria-sort', 'ascending')
    await expect(rows.first()).toContainText(`Zulu down ${run}`)
    await uptime.getByRole('button').click()
    await expect(uptime).toHaveAttribute('aria-sort', 'descending')
    await expect(rows.first()).toContainText(`Alpha up ${run}`)

    // Hide the target column.
    await expect(table.getByRole('columnheader', { name: /^Target/ })).toBeVisible()
    await page.getByRole('button', { name: 'Columns' }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Target' }).click()
    await page.keyboard.press('Escape')
    await expect(table.getByRole('columnheader', { name: /^Target/ })).toHaveCount(0)

    // The same view after a reload.
    await page.reload()
    await expect(rows).toHaveCount(2)
    await expect(uptime).toHaveAttribute('aria-sort', 'descending')
    await expect(rows.first()).toContainText(`Alpha up ${run}`)
    await expect(table.getByRole('columnheader', { name: /^Target/ })).toHaveCount(0)

    // Keyboard selection in table order, then a bulk action from the shared bar.
    await rows.first().getByRole('checkbox').focus()
    await page.keyboard.press('Space')
    await expect(page.getByText('1 selected')).toBeVisible()
    await page.keyboard.press('Shift+ArrowDown')
    await expect(page.getByText('2 selected')).toBeVisible()
    await page
      .getByRole('toolbar', { name: 'Bulk actions' })
      .getByRole('button', { name: 'Pause' })
      .click()

    // The rows update live.
    // (generous timeout: the first bulk request compiles its route under `next dev`)
    await expect(rows.filter({ hasText: 'Paused' })).toHaveCount(2, { timeout: 30_000 })
    const monitors = await adminApi.find<{ id: DocId; active?: boolean }>('monitors', {
      organization: { equals: String(await adminApi.organizationId(org.slug)) },
    })
    expect(monitors.map((m) => m.active)).toEqual([false, false])
  })
})

/**
 * Multi-step API checks (#138): a suite against the fixture server whose second step fails shows the
 * failing step in its message and a waterfall of the three steps (the cleanup step ran) in the check
 * detail; a suite is created through the form's step editor.
 */
test.describe('Multi-step API checks', () => {
  let suiteId: DocId

  test.beforeAll(async ({ adminApi }) => {
    const organization = await adminApi.organizationId(SETUP_ORG.slug)
    const monitor = await adminApi.createMonitor({
      name: `Suite ${runId()}`,
      type: 'http-suite',
      httpSuite: {
        vars: [{ name: 'base', value: targetUrl('') }],
        secrets: [],
        steps: [
          {
            key: 'health',
            name: 'health',
            url: '{{ vars.base }}/health',
            store: [{ name: 'ok', from: '$.ok', secret: false }],
          },
          { key: 'down', name: 'dependency', url: '{{ vars.base }}/down' },
          { key: 'cleanup', name: 'cleanup', url: '{{ vars.base }}/health', alwaysRun: true },
        ],
      },
      active: true,
      interval: 60,
      retryInterval: 60,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 48,
      organization,
    })
    suiteId = monitor.id
    await adminApi.waitForHeartbeat(suiteId, 'down')
  })

  test.afterAll(async ({ adminApi }) => {
    if (suiteId !== undefined) await adminApi.delete('monitors', suiteId)
  })

  test('shows the steps of a check as a waterfall', async ({ page }) => {
    await page.goto(`/${SETUP_ORG.slug}/monitors/${suiteId}`)
    await page.getByTestId('monitor-logs-tab').click()
    const row = page.getByTestId('log-row').first()
    await expect(row).toContainText('step 2 "dependency": status 503')
    await row.click()
    const steps = page.getByTestId('log-detail').getByTestId('suite-step-row')
    await expect(steps).toHaveCount(3)
    await expect(steps.nth(0)).toHaveAttribute('data-outcome', 'passed')
    await expect(steps.nth(1)).toHaveAttribute('data-outcome', 'failed')
    await expect(steps.nth(2)).toHaveAttribute('data-outcome', 'passed')
    await expect(steps.nth(2)).toContainText('Cleanup')
  })

  test('creates a suite with the step editor', async ({ page, adminApi }) => {
    await page.goto(`/${SETUP_ORG.slug}/monitors/new?type=http-suite`)
    const fields = page.getByTestId('monitor-form').filter({ visible: true })
    await expect(fields.getByTestId('http-suite-card')).toBeVisible()
    const name = `Suite form ${runId()}`
    await fields.getByLabel('Friendly name').fill(name)
    const step = fields.getByTestId('suite-step').first()
    await step.getByLabel('URL').fill(targetUrl('/health'))
    await fields.getByTestId('suite-add-step').click()
    const second = fields.getByTestId('suite-step').nth(1)
    await second.getByLabel('URL').fill(targetUrl('/health'))
    await second.getByLabel('Always run (cleanup)').click()
    await fields.getByTestId('monitor-submit').click()

    await expect(page).toHaveURL(new RegExp(`/${SETUP_ORG.slug}/monitors/(?!new)[^/?]+$`))
    const id = new URL(page.url()).pathname.split('/').pop()!
    try {
      const [monitor] = await adminApi.find<{ httpSuite?: { steps: unknown[] } }>('monitors', {
        id: { equals: id },
      })
      expect(monitor?.httpSuite?.steps).toEqual([
        expect.objectContaining({ key: 'step1', url: targetUrl('/health'), alwaysRun: false }),
        expect.objectContaining({ key: 'step2', url: targetUrl('/health'), alwaysRun: true }),
      ])
    } finally {
      await adminApi.delete('monitors', id)
    }
  })
})
