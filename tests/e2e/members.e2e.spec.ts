import { expect, test, type Page } from '@playwright/test'

import {
  cleanupOrganization,
  cleanupUsers,
  findInvitationToken,
  seedOrganization,
  seedUser,
} from '../helpers/org'

const run = Date.now().toString(36)
const owner = {
  email: `owner-${run}@marmot.local`,
  password: 'marmot-e2e-password',
  name: 'Olive Owner',
}
const invitee = {
  email: `invitee-${run}@marmot.local`,
  password: 'marmot-e2e-password',
  name: 'Ivy Invitee',
}
const org = { name: 'E2E Members', slug: `e2e-members-${run}` }

async function signIn(page: Page, user: { email: string; password: string }, next?: string) {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : '/login')
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Password').fill(user.password)
  await page.getByRole('button', { name: /^sign in$/i }).click()
}

test.describe('Members', () => {
  test.beforeAll(async () => {
    const ownerUser = await seedUser(owner)
    await seedUser(invitee)
    await seedOrganization(ownerUser, org)
  })

  test.afterAll(async () => {
    await cleanupOrganization(org.slug)
    await cleanupUsers([owner.email, invitee.email])
  })

  test('owner invites by email, invitee accepts the link and shows up as a member', async ({
    browser,
  }) => {
    // Owner: sign in and send the invitation.
    const ownerContext = await browser.newContext()
    const ownerPage = await ownerContext.newPage()
    await signIn(ownerPage, owner, `/${org.slug}/members`)
    await ownerPage.waitForURL(new RegExp(`/${org.slug}/members$`))

    await expect(ownerPage.getByTestId('member-row')).toHaveCount(1)
    await ownerPage.getByRole('button', { name: /invite member/i }).click()
    const dialog = ownerPage.getByRole('dialog')
    await dialog.getByLabel('Email').fill(invitee.email)
    await dialog.getByRole('button', { name: /send invitation/i }).click()

    await expect(
      ownerPage.getByTestId('invitation-row').filter({ hasText: invitee.email }),
    ).toBeVisible()

    // Invitee: open the link from the email in a fresh browser context.
    const token = await findInvitationToken(invitee.email)
    const inviteeContext = await browser.newContext()
    const inviteePage = await inviteeContext.newPage()
    await inviteePage.goto(`/invite/${token}`)
    await expect(inviteePage.getByRole('heading', { name: `Join ${org.name}` })).toBeVisible()
    await inviteePage.getByRole('link', { name: /sign in to accept/i }).click()
    await inviteePage.getByLabel('Email').fill(invitee.email)
    await inviteePage.getByLabel('Password').fill(invitee.password)
    await inviteePage.getByRole('button', { name: /^sign in$/i }).click()

    // Signed in → the invite page accepts automatically and redirects into the organization.
    await inviteePage.waitForURL(new RegExp(`/${org.slug}(/|$)`), { timeout: 30_000 })
    await expect(inviteePage.getByRole('heading', { name: /monitors/i })).toBeVisible()

    // Owner: the new member is listed and the invitation is gone.
    await ownerPage.reload()
    await expect(
      ownerPage.getByTestId('member-row').filter({ hasText: invitee.email }),
    ).toBeVisible()
    await expect(ownerPage.getByTestId('invitation-row')).toHaveCount(0)

    await inviteeContext.close()
    await ownerContext.close()
  })
})
