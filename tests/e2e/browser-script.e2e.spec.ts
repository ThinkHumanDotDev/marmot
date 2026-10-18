import { chromium, type BrowserServer } from '@playwright/test'

import { expect, runId, SETUP_ORG, targetUrl, test } from './fixtures'

/**
 * Browser Script monitor (#139): write a script in the editor, "Run now" on the worker against a
 * remote browser (a Playwright browser server started here), see the steps pass, break the expected
 * text and see the failure with its screenshot inline, then save the monitor.
 */
let browserServer: BrowserServer

const script = (expected: string) => `await test.step('open the page', async () => {
  await page.goto('/welcome')
})
await test.step('check the heading', async () => {
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('${expected}', { timeout: 1000 })
})`

test.describe('Browser Script monitor', () => {
  test.beforeAll(async () => {
    browserServer = await chromium.launchServer({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
        : {}),
    })
  })

  test.afterAll(async () => {
    await browserServer?.close()
  })

  test('runs a script from the editor and shows the failure with a screenshot', async ({
    page,
    adminApi,
  }) => {
    await page.goto(`/${SETUP_ORG.slug}/monitors/new?type=browser-script`)
    const form = page.getByTestId('monitor-form').filter({ visible: true })
    await expect(form.getByTestId('monitor-type')).toContainText('Browser Script')
    const name = `Journey ${runId()}`
    await form.getByLabel('Friendly name').fill(name)
    const card = form.getByTestId('browser-script-card')
    await card.getByLabel('Start URL').fill(targetUrl('/'))
    await card.getByLabel('Remote browser URL').fill(browserServer.wsEndpoint())
    const editor = card.getByTestId('browser-script-editor')
    // The example script is there to start from.
    await expect(editor).toHaveValue(/test\.step/)
    await editor.fill(script('Welcome, Ada'))

    await card.getByTestId('browser-script-run').click()
    const panel = form.getByTestId('monitor-test-panel')
    const result = panel.getByTestId('check-result')
    await expect(result).toBeVisible({ timeout: 45_000 })
    await expect(result.getByTestId('check-result-message')).toHaveText('Passed (2 steps)')
    await expect(result.getByTestId('browser-step')).toHaveCount(2)

    await editor.fill(script('Welcome, Grace'))
    await card.getByTestId('browser-script-run').click()
    await expect(result.getByTestId('check-result-message')).toContainText('toHaveText failed', {
      timeout: 45_000,
    })
    await expect(result.getByTestId('browser-screenshot').getByRole('img')).toBeVisible()

    // Saved with the fixed script, the monitor opens on its detail page.
    await editor.fill(script('Welcome, Ada'))
    await form.getByTestId('monitor-submit').click()
    await expect(page).toHaveURL(new RegExp(`/${SETUP_ORG.slug}/monitors/(?!new)[^/?]+$`))
    const id = new URL(page.url()).pathname.split('/').pop()!
    try {
      await expect(page.getByTestId('monitor-name')).toHaveText(name)
    } finally {
      await adminApi.delete('monitors', id)
    }
  })
})
