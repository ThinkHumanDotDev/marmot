import { describe, expect, it } from 'vitest'

import {
  isWebhookEventSelector,
  normalizeWebhookSelectors,
  WEBHOOK_EVENT_GROUPS,
  WEBHOOK_EVENT_TYPES,
} from './webhook-events'

describe('webhook event catalogue', () => {
  it('offers lifecycle and resource events but no sign-ins or instance settings', () => {
    expect(WEBHOOK_EVENT_TYPES).toEqual(
      expect.arrayContaining([
        'monitor.down',
        'incident.opened',
        'monitor.created',
        'member.removed',
      ]),
    )
    expect(WEBHOOK_EVENT_TYPES.some((type) => type.startsWith('auth.'))).toBe(false)
    expect(WEBHOOK_EVENT_TYPES).not.toContain('instance_settings.updated')
    expect(new Set(WEBHOOK_EVENT_TYPES).size).toBe(WEBHOOK_EVENT_TYPES.length)
    expect(WEBHOOK_EVENT_GROUPS[0]).toMatchObject({ group: 'monitor' })
  })

  it('accepts exact types, group wildcards and *', () => {
    expect(isWebhookEventSelector('*')).toBe(true)
    expect(isWebhookEventSelector('incident.*')).toBe(true)
    expect(isWebhookEventSelector('nothing.*')).toBe(false)
    expect(isWebhookEventSelector('monitor.down')).toBe(true)
    expect(isWebhookEventSelector('auth.login')).toBe(false)
  })

  it('normalises selections', () => {
    expect(normalizeWebhookSelectors(['monitor.down', '*'])).toEqual(['*'])
    expect(
      normalizeWebhookSelectors(['incident.opened', 'incident.*', 'monitor.up', 'monitor.up']),
    ).toEqual(['incident.*', 'monitor.up'])
  })
})
