import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  generateWebhookSecret,
  signWebhookPayload,
  verifyWebhookSignature,
  webhookSignatureHeaders,
} from './signature'

describe('webhook signatures', () => {
  const secret = 'whsec_test'
  const body = '{"version":"1"}'

  it('signs "<timestamp>.<body>" with HMAC-SHA256', () => {
    const expected = createHmac('sha256', secret).update(`1700000000.${body}`).digest('hex')
    expect(signWebhookPayload(secret, body, 1700000000)).toBe(`t=1700000000,v1=${expected}`)
  })

  it('verifies fresh signatures and rejects tampering, other secrets and replays', () => {
    const now = 1700000000_000
    const header = signWebhookPayload(secret, body, now / 1000)
    expect(verifyWebhookSignature(secret, body, header, { now })).toBe(true)
    expect(verifyWebhookSignature(secret, `${body} `, header, { now })).toBe(false)
    expect(verifyWebhookSignature('whsec_other', body, header, { now })).toBe(false)
    expect(verifyWebhookSignature(secret, body, header, { now: now + 10 * 60_000 })).toBe(false)
    expect(verifyWebhookSignature(secret, body, null, { now })).toBe(false)
  })

  it('adds event and delivery headers', () => {
    const headers = webhookSignatureHeaders(secret, body, {
      event: 'incident_opened',
      deliveryId: '7',
    })
    expect(headers['X-Marmot-Event']).toBe('incident_opened')
    expect(headers['X-Marmot-Delivery']).toBe('7')
    expect(headers['X-Marmot-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
    expect(generateWebhookSecret()).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/)
  })

  it('signs with every secret of a rotation, and either one verifies', () => {
    const header = signWebhookPayload(['whsec_new', 'whsec_old'], body)
    expect(header.match(/v1=/g)).toHaveLength(2)
    expect(verifyWebhookSignature('whsec_new', body, header)).toBe(true)
    expect(verifyWebhookSignature('whsec_old', body, header)).toBe(true)
    expect(verifyWebhookSignature('whsec_other', body, header)).toBe(false)
  })
})
