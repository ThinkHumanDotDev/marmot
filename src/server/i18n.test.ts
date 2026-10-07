import { describe, expect, it, vi } from 'vitest'

import type { Locale } from '@/i18n/locales'
import type { Heartbeat, Monitor } from '@/payload-types'

/**
 * Marmot ships English only, so a pretend second language (`xx`) makes it visible that the
 * organization's language, not the default, picks the catalogue for server-rendered text.
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
  const en = actual.messages.en
  const xx = {
    ...en,
    notifications: {
      messages: {
        ...en.notifications.messages,
        status: { ...en.notifications.messages.status, down: '🔴 XX-Down' },
        noMessage: 'XX-N/A',
        testConfigured: '"{channel}" XX-ok.',
      },
    },
    errors: { ...en.errors, memberNotFound: 'XX member?' },
  }
  const messages = { en, xx }
  return {
    ...actual,
    messages,
    getMessages: (locale: string) => messages[locale as keyof typeof messages] ?? en,
  }
})

const { getOrganizationI18n } = await import('@/server/i18n')
const { buildDefaultMessage, buildTestMessage, statusLabel } =
  await import('@/server/notifications/message')
const { apiError } = await import('@/server/errors')

/** The pretend locale; typed as a real one because the `Locale` union only knows `en`. */
const XX = 'xx' as Locale

const monitor = { id: 1, name: 'Site' } as unknown as Monitor
const down = { status: 'down', msg: '' } as unknown as Heartbeat

describe('server translator lookup', () => {
  it("takes the organization's language from the stored document", async () => {
    const findByID = vi.fn().mockResolvedValue({
      settings: { language: 'xx', timezone: 'Asia/Tokyo' },
    })
    const payload = { findByID } as never

    expect(await getOrganizationI18n(payload, 42)).toEqual({
      locale: 'xx',
      timeZone: 'Asia/Tokyo',
    })
    expect(findByID).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'organizations', id: 42 }),
    )
  })

  it('renders messages from that language catalogue, English by default', () => {
    expect(buildDefaultMessage(monitor, down, XX)).toBe('[Site] [🔴 XX-Down] XX-N/A')
    expect(buildDefaultMessage(monitor, down)).toBe('[Site] [🔴 Down] N/A')
    expect(buildTestMessage('Ops', XX)).toBe('[Marmot] [⚠️ Test] "Ops" XX-ok.')
    expect(statusLabel('up', XX)).toBe('✅ Up')
  })

  it('keeps the English message and the key on API errors', () => {
    const error = apiError('memberNotFound', 404)
    expect(error.message).toBe('Member not found.')
    expect(error.messageIn(XX)).toBe('XX member?')
  })
})
