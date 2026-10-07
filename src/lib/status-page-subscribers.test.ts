import { describe, expect, it } from 'vitest'

import {
  isSlackWebhookUrl,
  isDiscordWebhookUrl,
  maskTarget,
  normalizeComponentSelection,
  normalizeTarget,
  renderSmsTemplate,
  smsSegments,
  subscriberWantsComponents,
  truncateSms,
} from './status-page-subscribers'

describe('subscriber targets', () => {
  it('normalises emails and phone numbers', () => {
    expect(normalizeTarget('email', '  Ops@Example.COM ')).toEqual({
      ok: true,
      target: 'ops@example.com',
    })
    expect(normalizeTarget('email', 'not-an-email').ok).toBe(false)
    expect(normalizeTarget('sms', '+44 (20) 7946-0018')).toEqual({
      ok: true,
      target: '+442079460018',
    })
    expect(normalizeTarget('sms', '0044 20 7946 0018')).toEqual({
      ok: true,
      target: '+442079460018',
    })
    expect(normalizeTarget('sms', '020 7946 0018').ok).toBe(false)
  })

  it('accepts only Slack incoming webhooks on the Slack channel', () => {
    expect(isSlackWebhookUrl('https://hooks.slack.com/services/T000/B000/XXXX')).toBe(true)
    expect(isSlackWebhookUrl('https://example.com/services/T000')).toBe(false)
    expect(normalizeTarget('slack', 'http://hooks.slack.com/services/T/B/X').ok).toBe(false)
    expect(isDiscordWebhookUrl('https://discord.com/api/webhooks/1/abc')).toBe(true)
    expect(normalizeTarget('webhook', 'https://user:pw@example.com/hook').ok).toBe(false)
    expect(normalizeTarget('webhook', 'ftp://example.com').ok).toBe(false)
  })

  it('masks targets for the delivery log', () => {
    expect(maskTarget('email', 'jane@example.com')).toBe('j***@example.com')
    expect(maskTarget('sms', '+442079460018')).toBe('+4420******18')
    expect(maskTarget('webhook', 'https://example.com/secret/path')).toBe('https://example.com/…')
  })
})

describe('component scoping', () => {
  it('keeps known component ids once', () => {
    expect(normalizeComponentSelection(['a', 'b', 'a', 'x'], new Set(['a', 'b']))).toEqual([
      'a',
      'b',
    ])
  })

  it('matches subscribers to affected components', () => {
    expect(subscriberWantsComponents([], ['a'])).toBe(true)
    expect(subscriberWantsComponents(['a'], [])).toBe(true)
    expect(subscriberWantsComponents(['a'], ['a', 'b'])).toBe(true)
    expect(subscriberWantsComponents(['a'], ['b'])).toBe(false)
  })
})

describe('SMS text', () => {
  it('renders {{ }} placeholders and drops unknown ones', () => {
    expect(
      renderSmsTemplate('{{ siteName }}: {{title}} is {{ status }} {{ nope }}', {
        siteName: 'Acme',
        title: 'API',
        status: 'Resolved',
      }),
    ).toBe('Acme: API is Resolved')
  })

  it('counts GSM-7 and UCS-2 segments', () => {
    expect(smsSegments('a'.repeat(160))).toBe(1)
    expect(smsSegments('a'.repeat(161))).toBe(2)
    expect(smsSegments('é'.repeat(160))).toBe(1)
    expect(smsSegments('😀'.repeat(36))).toBe(2)
  })

  it('truncates to the segment budget and keeps the URL', () => {
    const url = 'https://status.example.com'
    const text = `${'word '.repeat(200)}${url}`
    const short = truncateSms(text, 2, url)
    expect(smsSegments(short)).toBeLessThanOrEqual(2)
    expect(short.endsWith(`...${url}`)).toBe(true)
    expect(truncateSms('short', 2)).toBe('short')
  })
})
