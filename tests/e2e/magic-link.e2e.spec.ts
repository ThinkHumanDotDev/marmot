import { ANONYMOUS, expect, runId, test } from './fixtures'
import { mailURL } from './e2e-env'

/**
 * Passwordless sign-in (#164): request a link on the login page, read it from the mail sink
 * (`tests/e2e/mail-sink.mjs`), confirm it, land signed in. The link works once.
 */
test.use({ storageState: ANONYMOUS })

const run = runId()
const user = { name: 'Link User', email: `link-${run}@marmot.test`, password: `pw-${run}-secret` }

async function lastLink(email: string): Promise<string> {
  let link: string | undefined
  await expect
    .poll(
      async () => {
        const res = await fetch(`${mailURL}/messages?to=${encodeURIComponent(email)}`)
        const messages = (await res.json()) as { subject: string; text: string }[]
        const text = messages.at(-1)?.text ?? ''
        link = text.match(/https?:\/\/\S+\/login\/magic-link\?token=[A-Za-z0-9_-]{43}\S*/)?.[0]
        return link ?? null
      },
      { message: `sign-in link mailed to ${email}`, timeout: 15_000 },
    )
    .not.toBeNull()
  return link!
}

test.describe('magic-link sign-in', () => {
  test.beforeAll(async ({ adminApi }) => {
    await adminApi.context.post('/api/globals/instance-settings', {
      data: { magicLinkEnabled: true },
    })
    await adminApi.create('users', user)
  })

  test.afterAll(async ({ adminApi }) => {
    await adminApi.context.post('/api/globals/instance-settings', {
      data: { magicLinkEnabled: null },
    })
    const [created] = await adminApi.find<{ id: string | number }>('users', {
      email: { equals: user.email },
    })
    if (created) await adminApi.delete('users', created.id)
  })

  test('emails a single-use link that signs the user in', async ({ page }) => {
    await page.goto('/login')
    await page.getByTestId('use-magic-link').click()
    await page.getByLabel('Email').fill(user.email)
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
    await expect(page.getByTestId('magic-link-sent')).toContainText(user.email)

    // An unknown address gets the very same answer.
    await page.getByRole('button', { name: 'Use another address' }).click()
    await page.getByLabel('Email').fill(`nobody-${run}@marmot.test`)
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
    await expect(page.getByTestId('magic-link-sent')).toContainText(`nobody-${run}@marmot.test`)

    const link = await lastLink(user.email)
    await page.goto(link)
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/login'))
    const me = await page.request.get('/api/users/me')
    expect(((await me.json()) as { user?: { email?: string } }).user?.email).toBe(user.email)

    // The same link does not work twice.
    await page.context().clearCookies()
    await page.goto(link)
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('alert')).toContainText(/invalid, has expired or was already used/)
  })
})
