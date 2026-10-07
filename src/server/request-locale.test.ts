import { describe, expect, it, vi } from 'vitest'

import type { Locale } from '@/i18n/locales'
import type { Heartbeat, Monitor } from '@/payload-types'

/**
 * A pretend second language (`xx`) whose catalogue is English with an `XX ` prefix on every
 * message, so each test can tell which catalogue produced a string. Marmot ships English only.
 */
vi.mock('@/i18n/locales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n/locales')>()
  const locales = ['en', 'xx'] as const
  return {
    ...actual,
    locales,
    isLocale: (value: unknown, supported: readonly string[] = locales) =>
      typeof value === 'string' && supported.includes(value),
  }
})

vi.mock('@/i18n/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n/messages')>()
  const prefix = (value: unknown): unknown =>
    typeof value === 'string'
      ? `XX ${value}`
      : Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, prefix(v)]))
  const messages = { en: actual.messages.en, xx: prefix(actual.messages.en) }
  return {
    ...actual,
    messages,
    getMessages: (locale: string) =>
      messages[locale as keyof typeof messages] ?? actual.messages.en,
  }
})

const { errorText, rememberRequestUser, requestLocale, slugMessageIn, userErrorText } =
  await import('@/server/request-locale')
const { apiError } = await import('@/server/errors')
const { validateOrganizationSlug } = await import('@/lib/reserved-slugs')
const { validatePermissionOverrides } = await import('@/collections/Organizations')
const { entitlementMessage } = await import('@/lib/entitlements')
const { toApiError } = await import('@/server/billing/entitlements')
const { EntitlementError } = await import('@/lib/entitlements')
const { buildTeamsPayload } = await import('@/server/notification-providers/teams')
const { buildSlackBlocks } = await import('@/server/notification-providers/slack')
const { providerText } = await import('@/server/notifications/message')
const { parseImportFile } = await import('@/server/import-export')
const { importText } = await import('@/server/import-export/text')
const { describeNotificationProviders } = await import('@/server/notification-providers')

const XX = 'xx' as Locale
const request = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/x', { headers })

describe('API error locale', () => {
  it('follows Accept-Language and the cookie for signed-out requests', () => {
    expect(errorText(request(), 'monitorNotFound')).toBe('Monitor not found')
    expect(errorText(request({ 'accept-language': 'xx' }), 'monitorNotFound')).toBe(
      'XX Monitor not found',
    )
    expect(requestLocale(request({ cookie: 'marmot-locale=xx' }))).toBe('xx')
  })

  it("prefers the authenticated user's language over the headers", () => {
    const req = request({ 'accept-language': 'en' })
    rememberRequestUser(req, { language: XX })
    expect(errorText(req, 'unauthenticated')).toBe('XX Unauthorized')
  })

  it('renders apiError messages in another locale but keeps English as the message', () => {
    const error = apiError('ssoEnforced', 403)
    expect(error.message).toMatch(/^Your organization requires single sign-on/)
    expect(error.messageIn(XX)).toMatch(/^XX Your organization requires single sign-on/)
  })

  it("writes collection validation messages in req.user's language", () => {
    expect(userErrorText({ user: { language: 'xx' } }, 'tagDuplicate')).toBe(
      'XX Each tag may only be added once.',
    )
    expect(userErrorText({ user: null }, 'tagDuplicate')).toBe('Each tag may only be added once.')
  })

  it('renders plurals and selects exactly like the old English text', () => {
    const t = (key: Parameters<typeof errorText>[1], values?: Record<string, string | number>) =>
      errorText(request(), key, values)
    expect(t('unknownMonitors', { count: 1, ids: '7' })).toBe('Unknown monitor: 7')
    expect(t('unknownMonitors', { count: 2, ids: '7, 8' })).toBe('Unknown monitors: 7, 8')
    expect(t('monitorIdsExpected')).toBe('Expected { monitors: [id, …] }')
    expect(t('maintenanceForeignReference', { kind: 'statusPage' })).toBe(
      'Every status page must belong to the same organization.',
    )
    expect(t('serverSmtpTooManyRecipients', { max: 10 })).toBe(
      'Messages sent through the server SMTP settings can have at most 10 recipients (to, cc and bcc combined).',
    )
  })

  it('keeps the plan limit message identical to entitlementMessage', () => {
    for (const resource of ['monitors', 'members', 'statusPages'] as const) {
      for (const limit of [1, 3, 1000]) {
        const error = toApiError(new EntitlementError(resource, limit, limit), 'free')
        expect(error.message).toBe(entitlementMessage(resource, limit))
        expect(error.data).toMatchObject({ code: 'entitlement_exceeded', resource, limit })
      }
    }
  })
})

describe('validation messages', () => {
  it('renders slug problems in English by default and in the given locale', () => {
    expect(validateOrganizationSlug('a')).toBe('Slug must be at least 2 characters.')
    expect(validateOrganizationSlug('admin')).toBe(
      '"admin" is reserved. Please choose another slug.',
    )
    expect(validateOrganizationSlug('admin', slugMessageIn(XX))).toBe(
      'XX "admin" is reserved. Please choose another slug.',
    )
    expect(validateOrganizationSlug('acme', slugMessageIn(XX))).toBe(true)
  })

  it('renders permission override problems in the given locale', () => {
    expect(validatePermissionOverrides({ nope: 'admin' })).toBe('Unknown permission "nope".')
    expect(validatePermissionOverrides({ nope: 'admin' }, XX)).toBe('XX Unknown permission "nope".')
    expect(validatePermissionOverrides({})).toBe(true)
  })
})

describe('provider payload wording', () => {
  const monitor = {
    id: 1,
    name: 'API',
    type: 'http',
    url: 'https://api.example.com',
  } as unknown as Monitor
  const heartbeat = {
    status: 'down',
    msg: 'timeout',
    time: '2026-10-07T10:00:00.000Z',
  } as unknown as Heartbeat

  it('builds Teams cards in the organization language, English by default', () => {
    const en = JSON.stringify(buildTeamsPayload({ monitor, heartbeat, message: 'm' }))
    const xx = JSON.stringify(buildTeamsPayload({ monitor, heartbeat, message: 'm', locale: XX }))
    expect(en).toContain('"title":"Visit Monitor URL"')
    expect(en).toContain('[API] went down')
    expect(xx).toContain('"title":"XX Visit Monitor URL"')
    expect(xx).toContain('XX [API] went down')
  })

  it('builds Slack blocks in the organization language', () => {
    expect(JSON.stringify(buildSlackBlocks(monitor, heartbeat, 'API', 'm'))).toContain('*Time*')
    expect(JSON.stringify(buildSlackBlocks(monitor, heartbeat, 'API', 'm', XX))).toContain(
      '*XX Time*',
    )
    expect(providerText(XX)('alertFor', { text: 'API' })).toBe('XX Marmot Alert: API')
  })

  it('translates provider form descriptors', () => {
    const discord = describeNotificationProviders(XX).find((d) => d.name === 'discord')!
    expect(discord.label).toBe('XX Discord')
    expect(discord.fields.find((f) => f.name === 'webhookUrl')?.label).toBe(
      'XX Discord webhook URL',
    )
  })
})

describe('import reports', () => {
  it('writes skip reasons and warnings in the given locale', () => {
    const backup = {
      version: '1.23.0',
      notificationList: [{ id: 1, name: 'Broken', config: '{' }],
      monitorList: [],
    }
    const en = parseImportFile(backup)
    expect(en.warnings).toEqual(['Uptime Kuma backup version 1.23.0'])
    expect(en.skipped.notifications).toEqual([
      { name: 'Broken', reason: 'Notification config is not valid JSON' },
    ])
    const xx = parseImportFile(backup, undefined, importText(XX))
    expect(xx.warnings).toEqual(['XX Uptime Kuma backup version 1.23.0'])
    expect(xx.skipped.notifications[0].reason).toBe('XX Notification config is not valid JSON')
  })
})
