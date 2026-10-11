import { describe, expect, it } from 'vitest'

import { classifyPushEmail, pushEmailAddress, pushTokenFromAddress } from './push-email'

describe('classifyPushEmail', () => {
  const backup = { pushEmailFailureKeyword: 'FAILED', pushEmailSuccessKeyword: 'OK' }

  it('counts any mail as a success without keywords', () => {
    expect(classifyPushEmail({}, { subject: 'Backup OK' })).toEqual({
      kind: 'success',
      matched: null,
    })
    expect(classifyPushEmail({ pushEmailFailureKeyword: 'FAILED' }, { subject: 'done' }).kind).toBe(
      'success',
    )
  })

  it('checks failure, then success, then start, ignoring case, in subject and body', () => {
    const rules = { ...backup, pushEmailStartKeyword: 'started' }
    expect(classifyPushEmail(rules, { subject: 'Backup FAILED' }).kind).toBe('fail')
    // Both keywords: failure wins.
    expect(classifyPushEmail(rules, { subject: 'OK so far, then failed' }).kind).toBe('fail')
    expect(classifyPushEmail(rules, { subject: 'Backup ok' }).kind).toBe('success')
    expect(classifyPushEmail(rules, { subject: 'Job', text: 'Backup Started at 02:00' }).kind).toBe(
      'start',
    )
  })

  it('applies the unmatched setting only when a success keyword is set', () => {
    expect(classifyPushEmail(backup, { subject: 'Weekly report' })).toEqual({
      kind: 'ignore',
      matched: null,
    })
    expect(
      classifyPushEmail({ ...backup, pushEmailUnmatched: 'fail' }, { subject: 'Weekly report' })
        .kind,
    ).toBe('fail')
    expect(
      classifyPushEmail(
        { pushEmailFailureKeyword: 'FAILED', pushEmailUnmatched: 'fail' },
        { subject: 'Weekly report' },
      ).kind,
    ).toBe('success')
  })
})

describe('inbound addresses', () => {
  it('extracts the token on the inbound domain only', () => {
    expect(pushTokenFromAddress('abc123@ping.example.com', 'ping.example.com')).toBe('abc123')
    expect(pushTokenFromAddress('<abc123@PING.example.com>', 'ping.example.com')).toBe('abc123')
    expect(pushTokenFromAddress('abc123+nightly@ping.example.com', 'ping.example.com')).toBe(
      'abc123',
    )
    expect(pushTokenFromAddress('abc123@other.example.com', 'ping.example.com')).toBeNull()
    expect(pushTokenFromAddress('a b@ping.example.com', 'ping.example.com')).toBeNull()
    expect(pushTokenFromAddress('no-at-sign', 'ping.example.com')).toBeNull()
  })

  it('builds the address only when a domain is configured', () => {
    expect(pushEmailAddress('abc', 'ping.example.com')).toBe('abc@ping.example.com')
    expect(pushEmailAddress('abc', null)).toBeNull()
    expect(pushEmailAddress(null, 'ping.example.com')).toBeNull()
  })
})
