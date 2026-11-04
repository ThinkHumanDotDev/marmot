import { expect, runId, SETUP_ORG, test } from './fixtures'

/**
 * Host monitors (#136): create one with the form (default thresholds, one added), then report a
 * sample the way the agent does and see it on the monitor page.
 */
test.describe('Host monitors', () => {
  test('creates a host monitor and shows the sample its agent sends', async ({
    page,
    adminApi,
    playwright,
    baseURL,
  }) => {
    await page.goto(`/${SETUP_ORG.slug}/monitors/new?type=host`)
    const fields = page.getByTestId('monitor-form').filter({ visible: true })
    await expect(fields.getByTestId('host-thresholds-card')).toBeVisible()
    const rows = fields.getByTestId('host-threshold-row')
    await expect(rows).toHaveCount(3)
    const name = `Host ${runId()}`
    await fields.getByLabel('Friendly name').fill(name)
    await fields.getByTestId('host-threshold-add').click()
    await expect(rows).toHaveCount(4)
    await rows.nth(3).getByLabel('Target').fill('/data')
    await rows.nth(3).getByLabel('Value').fill('80')
    await fields.getByTestId('monitor-submit').click()

    // Creating the monitor and compiling its page can take a while on a cold dev server.
    await expect(page).toHaveURL(new RegExp(`/${SETUP_ORG.slug}/monitors/(?!new)[^/?]+$`), {
      timeout: 30_000,
    })
    const id = new URL(page.url()).pathname.split('/').pop()!
    try {
      const [monitor] = await adminApi.find<{
        pushToken: string
        hostThresholds: { metric: string; target: string | null; value: number }[]
      }>('monitors', { id: { equals: id } })
      expect(monitor.hostThresholds).toHaveLength(4)
      expect(monitor.hostThresholds[3]).toMatchObject({
        metric: 'disk',
        target: '/data',
        value: 80,
      })

      const panel = page.getByTestId('host-agent-panel')
      await expect(panel).toBeVisible()
      await expect(panel.getByTestId('host-agent-snippet-docker')).toContainText(
        `MARMOT_HOST_TOKEN=${monitor.pushToken}`,
      )
      await expect(panel.getByTestId('host-agent-last-sample')).toHaveText('Never')

      const agent = await playwright.request.newContext({ baseURL })
      const res = await agent.post('/api/agent/v1/metrics', {
        headers: { authorization: `Bearer ${monitor.pushToken}` },
        data: {
          hostname: 'e2e-host',
          os: 'Debian GNU/Linux 12',
          agentVersion: '9.9.9',
          cpu: 10,
          memory: { used: 1, total: 4 },
          disks: [{ mount: '/', used: 40, total: 100 }],
        },
      })
      expect(res.status()).toBe(200)
      await agent.dispose()

      await page.reload()
      await expect(panel.getByTestId('host-agent-hostname')).toContainText('e2e-host')
      await expect(panel.getByTestId('host-agent-last-sample')).not.toHaveText('Never')
    } finally {
      await adminApi.delete('monitors', id)
    }
  })
})
