import { describe, expect, it } from 'vitest'

import { twilioSignature, validateTwilioSignature } from './signature'

// The example from https://www.twilio.com/docs/usage/security#validating-requests.
const TOKEN = '12345'
const URL = 'https://mycompany.com/myapp.php?foo=1&bar=2'
const PARAMS = {
  CallSid: 'CA1234567890ABCDE',
  Caller: '+12349013030',
  Digits: '1234',
  From: '+12349013030',
  To: '+18005551212',
}
const EXPECTED = '0/KCTR6DLpKmkAf8muzZqo1nDgQ='

describe('Twilio request signatures', () => {
  it('matches Twilio’s documented example', () => {
    expect(twilioSignature(TOKEN, URL, PARAMS)).toBe(EXPECTED)
    expect(twilioSignature(TOKEN, URL, new URLSearchParams(PARAMS))).toBe(EXPECTED)
    expect(validateTwilioSignature(TOKEN, EXPECTED, URL, PARAMS)).toBe(true)
  })

  it('sorts parameters by name whatever their order', () => {
    const reversed = new URLSearchParams(Object.entries(PARAMS).reverse())
    expect(validateTwilioSignature(TOKEN, EXPECTED, URL, reversed)).toBe(true)
  })

  it('rejects another token, URL, parameter value or a missing signature', () => {
    expect(validateTwilioSignature('54321', EXPECTED, URL, PARAMS)).toBe(false)
    expect(validateTwilioSignature(TOKEN, EXPECTED, `${URL}&x=1`, PARAMS)).toBe(false)
    expect(validateTwilioSignature(TOKEN, EXPECTED, URL, { ...PARAMS, Digits: '1' })).toBe(false)
    expect(validateTwilioSignature(TOKEN, EXPECTED, URL, { ...PARAMS, Extra: '' })).toBe(false)
    expect(validateTwilioSignature(TOKEN, null, URL, PARAMS)).toBe(false)
    expect(validateTwilioSignature(TOKEN, '', URL, PARAMS)).toBe(false)
    expect(validateTwilioSignature('', EXPECTED, URL, PARAMS)).toBe(false)
  })

  it('accepts the URL with or without the default HTTPS port, as Twilio’s libraries do', () => {
    const withPort = twilioSignature(TOKEN, 'https://mycompany.com:443/myapp.php', PARAMS)
    expect(
      validateTwilioSignature(TOKEN, withPort, 'https://mycompany.com/myapp.php', PARAMS),
    ).toBe(true)
    const without = twilioSignature(TOKEN, 'https://mycompany.com/myapp.php', PARAMS)
    expect(
      validateTwilioSignature(TOKEN, without, 'https://mycompany.com:443/myapp.php', PARAMS),
    ).toBe(true)
    expect(
      validateTwilioSignature(TOKEN, without, 'https://mycompany.com:8443/myapp.php', PARAMS),
    ).toBe(false)
  })
})
