import { APIError, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import config from '@payload-config'
import { renderInvitationEmail } from '@/collections/Invitations'
import { getStaticFormatter } from '@/i18n/translator'
import type { Heartbeat, Monitor, Organization } from '@/payload-types'
import { apiError, LocalizedAPIError } from '@/server/errors'
import { unauthorized, withErrors } from '@/server/http'
import { getOrganizationI18n } from '@/server/i18n'
import { certExpiryMessage } from '@/server/jobs/cert-expiry'
import { domainExpiryMessage } from '@/server/jobs/domain-expiry'
import { registerNotificationProvider } from '@/server/notification-providers'
import type { NotificationSendContext } from '@/server/notification-providers/types'
import {
  buildDefaultMessage,
  buildTestMessage,
  renderMessageTemplate,
  sendNotification,
  sendTestNotification,
} from '@/server/notifications'

/**
 * Server-side strings (#73): emails, notification bodies and API errors go through the catalogue in
 * the organization's (or request's) language, and the English catalogue reproduces the previous
 * hard-coded text byte for byte.
 */

let payload: Payload
let org: Organization

const run = Date.now().toString(36)

/** A provider that records what it was asked to send. */
const captured: NotificationSendContext[] = []
registerNotificationProvider({
  name: `i18n-capture-${run}`,
  label: 'Capture',
  group: 'generic',
  configSchema: z.object({}),
  async send(ctx) {
    captured.push(ctx)
    return 'ok'
  },
})
const channel = (organization: unknown) => ({
  type: `i18n-capture-${run}`,
  config: {},
  name: 'Ops',
  organization: organization as Organization['id'],
})

const monitor = {
  id: 1,
  name: 'Site',
  type: 'http',
  url: 'https://example.com',
} as unknown as Monitor
const down = {
  status: 'down',
  msg: 'timeout',
  time: '2026-03-10T10:30:00.000Z',
} as unknown as Heartbeat

describe('server-side i18n', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    org = await payload.create({
      collection: 'organizations',
      data: {
        name: `i18n server ${run}`,
        slug: `i18n-server-${run}`,
        settings: { timezone: 'Europe/Berlin', language: 'en' },
      },
      overrideAccess: true,
      context: { skipOwnerMembership: true },
    })
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    await payload
      .delete({ collection: 'invitations', where: { organization: { equals: org.id } } })
      .catch(() => undefined)
    await payload
      .delete({ collection: 'organizations', id: org.id, overrideAccess: true })
      .catch(() => undefined)
  })

  describe('English output is unchanged', () => {
    it('renders notification messages exactly as before', () => {
      expect(buildDefaultMessage(monitor, down)).toBe('[Site] [🔴 Down] timeout')
      expect(buildDefaultMessage(monitor, { ...down, status: 'up', msg: '' } as Heartbeat)).toBe(
        '[Site] [✅ Up] N/A',
      )
      expect(buildDefaultMessage(null, null)).toBe('[Marmot] [⚠️ Test] Test notification')
      expect(buildTestMessage('Ops')).toBe('[Marmot] [⚠️ Test] "Ops" is configured correctly.')
      expect(buildTestMessage()).toBe('[Marmot] [⚠️ Test] Testing')
      expect(renderMessageTemplate('{{ name }}|{{ status }}', 'x', null, null)).toBe(
        'Monitor Name not available|⚠️ Test',
      )
    })

    it('renders expiry warnings exactly as before', () => {
      expect(
        certExpiryMessage(monitor, { certType: 'server', subjectCN: null, daysRemaining: 7 }),
      ).toBe('[Site][https://example.com] server certificate (no CN) will expire in 7 days')
      // No digit grouping: long-lived certificates printed `36498 days` before the catalogue too.
      expect(
        certExpiryMessage(monitor, { certType: 'root CA', subjectCN: 'R', daysRemaining: 36498 }),
      ).toBe('[Site][https://example.com] root CA certificate R will expire in 36498 days')
      expect(domainExpiryMessage({ name: 'Site', hostname: 'example.com' }, 'example.com', 1)).toBe(
        '[Site][example.com] Domain name example.com will expire in 1 days',
      )
    })

    it('renders the invitation email in the organization time zone', () => {
      const expiresAt = '2026-10-14T10:00:00.000Z'
      const mail = renderInvitationEmail({
        email: 'new@example.com',
        role: 'admin',
        url: 'https://marmot.test/invite/abc',
        expiresAt,
        organizationName: 'Acme & Co',
        i18n: { locale: 'en', timeZone: 'Europe/Berlin' },
      })
      const date = getStaticFormatter('en', 'Europe/Berlin').dateTime(new Date(expiresAt), 'zoned')
      expect(date).toBe('Oct 14, 2026, 12:00 PM GMT+2')
      expect(mail).toEqual({
        to: 'new@example.com',
        subject: 'You have been invited to Acme & Co on Marmot',
        text: `You have been invited to join Acme & Co as admin.\n\nAccept the invitation: https://marmot.test/invite/abc\n\nThis link expires on ${date}.`,
        html: `<p>You have been invited to join <strong>Acme &amp; Co</strong> as <strong>admin</strong>.</p><p><a href="https://marmot.test/invite/abc">Accept the invitation</a></p><p>This link expires on ${date}.</p>`,
      })
    })
  })

  describe('organization language', () => {
    it('reads language and time zone from the organization, by id or document', async () => {
      expect(await getOrganizationI18n(payload, org.id)).toEqual({
        locale: 'en',
        timeZone: 'Europe/Berlin',
      })
      expect(await getOrganizationI18n(payload, org)).toEqual({
        locale: 'en',
        timeZone: 'Europe/Berlin',
      })
      // Unknown or missing organizations fall back instead of failing a delivery.
      expect(await getOrganizationI18n(payload, null)).toEqual({ locale: 'en', timeZone: 'UTC' })
      expect(await getOrganizationI18n(payload, { settings: { language: 'xx' as never } })).toEqual(
        { locale: 'en', timeZone: 'UTC' },
      )
    })

    it("looks up the channel organization's language for notifications", async () => {
      const findByID = vi.spyOn(payload, 'findByID')
      captured.length = 0

      await sendNotification(payload, channel(org.id), { monitor, heartbeat: down })
      expect(findByID).toHaveBeenCalledWith(
        expect.objectContaining({ collection: 'organizations', id: org.id }),
      )
      expect(captured[0]).toMatchObject({ locale: 'en', message: '[Site] [🔴 Down] timeout' })

      // One sample per event the channel accepts (the defaults here, #126).
      await sendTestNotification(payload, channel(org.id))
      expect(captured.slice(1).map((ctx) => [ctx.locale, ctx.event, ctx.message])).toEqual([
        ['en', 'down', '[Marmot] [⚠️ Test] Down: "Ops" is configured correctly.'],
        ['en', 'up', '[Marmot] [⚠️ Test] Recovery: "Ops" is configured correctly.'],
        ['en', 'reminder', '[Marmot] [⚠️ Test] Reminders: "Ops" is configured correctly.'],
        [
          'en',
          'certificate',
          '[Marmot] [⚠️ Test] Certificate and domain expiry: "Ops" is configured correctly.',
        ],
      ])

      // A caller that already knows the language (the queue worker) skips the lookup.
      findByID.mockClear()
      await sendNotification(payload, channel(org.id), {
        monitor,
        heartbeat: down,
        locale: 'en',
      })
      expect(findByID).not.toHaveBeenCalledWith(
        expect.objectContaining({ collection: 'organizations' }),
      )
      findByID.mockRestore()
    })

    it("sends the invitation email in the organization's language and time zone", async () => {
      const sendEmail = vi.spyOn(payload, 'sendEmail').mockResolvedValue(undefined)
      const invitation = await payload.create({
        collection: 'invitations',
        data: { email: `i18n-invite+${run}@marmot.test`, role: 'member', organization: org.id },
        overrideAccess: true,
      })
      expect(sendEmail).toHaveBeenCalledTimes(1)
      const mail = sendEmail.mock.calls[0][0] as { subject: string; text: string }
      expect(mail.subject).toBe(`You have been invited to ${org.name} on Marmot`)
      const date = getStaticFormatter('en', 'Europe/Berlin').dateTime(
        new Date(invitation.expiresAt as string),
        'zoned',
      )
      expect(mail.text).toContain(`This link expires on ${date}.`)
      sendEmail.mockRestore()
    })
  })

  describe('API errors', () => {
    it('keeps APIError semantics and English text for catalogue errors', () => {
      const error = apiError('memberNotFound', 404)
      expect(error).toBeInstanceOf(APIError)
      expect(error).toBeInstanceOf(LocalizedAPIError)
      expect(error.status).toBe(404)
      expect(error.key).toBe('memberNotFound')
      expect(error.message).toBe('Member not found.')
      expect(apiError('soleOwner', 409, { organizations: 'A, B' }).message).toBe(
        'You are the only owner of A, B. Transfer ownership or delete the organization first.',
      )
      expect(apiError('invitationNotPending', 409, { status: 'revoked' }).message).toBe(
        'This invitation is revoked.',
      )
      expect(apiError('invitationNotPending', 409, { status: 'unknown' }).message).toBe(
        'This invitation is no longer pending.',
      )
    })

    it('renders error responses in the request locale', async () => {
      const request = new Request('http://marmot.test/api/x', {
        headers: { 'accept-language': 'en-GB,en;q=0.8' },
      })
      const handler = withErrors(async (_request: Request) => {
        throw apiError('passwordTooShort', 400, { min: 8 })
      })
      const response = await handler(request)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        errors: [{ message: 'The new password must be at least 8 characters.' }],
      })

      const denied = unauthorized(request)
      expect(denied.status).toBe(401)
      expect(await denied.json()).toEqual({ errors: [{ message: 'You must be signed in.' }] })
    })
  })
})
