import { describe, expect, it } from 'vitest'

import { isOidcErrorCode, OidcLoginError, oidcErrorMessage } from './errors'
import { displayNameFromClaims, normalizeEmail, pickClaims, randomLocalPassword } from './users'

describe('OIDC claim helpers', () => {
  it('picks typed claims and requires sub', () => {
    expect(
      pickClaims({ sub: 'abc', email: 'A@Example.com', email_verified: true, name: 7, extra: 1 }),
    ).toEqual({
      sub: 'abc',
      email: 'A@Example.com',
      email_verified: true,
      name: undefined,
      preferred_username: undefined,
      given_name: undefined,
      family_name: undefined,
      nickname: undefined,
    })
    expect(pickClaims({ sub: 'abc', email_verified: 'true' }).email_verified).toBe(false)
    expect(() => pickClaims({ email: 'x@y.z' })).toThrow(/sub/)
  })

  it('derives a display name in order of preference', () => {
    expect(displayNameFromClaims({ sub: 's', name: ' Jane Doe ' })).toBe('Jane Doe')
    expect(displayNameFromClaims({ sub: 's', given_name: 'Jane', family_name: 'Doe' })).toBe(
      'Jane Doe',
    )
    expect(displayNameFromClaims({ sub: 's', given_name: 'Jane' })).toBe('Jane')
    expect(displayNameFromClaims({ sub: 's', nickname: 'jd', preferred_username: 'jdoe' })).toBe(
      'jd',
    )
    expect(displayNameFromClaims({ sub: 's', preferred_username: 'jdoe' })).toBe('jdoe')
    expect(displayNameFromClaims({ sub: 's', name: '  ' })).toBeUndefined()
  })

  it('normalises emails and generates strong random passwords', () => {
    expect(normalizeEmail('  Jane@Example.COM ')).toBe('jane@example.com')
    const a = randomLocalPassword()
    const b = randomLocalPassword()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
  })
})

describe('OIDC error codes', () => {
  it('maps known codes to messages and ignores unknown input', () => {
    expect(isOidcErrorCode('oidc_state')).toBe(true)
    expect(isOidcErrorCode('constructor')).toBe(false)
    expect(isOidcErrorCode('<script>')).toBe(false)
    expect(oidcErrorMessage('signup_disabled')).toMatch(/invitation/i)
    expect(oidcErrorMessage('nope')).toBeUndefined()
    expect(oidcErrorMessage(undefined)).toBeUndefined()
    const error = new OidcLoginError('email_missing')
    expect(error.code).toBe('email_missing')
    expect(error.status).toBe(403)
    expect(error.message).toBe(oidcErrorMessage('email_missing'))
  })
})
