import { describe, expect, it } from 'vitest'

import { isSsoErrorCode, ssoErrorMessage } from './errors'

describe('SSO error codes', () => {
  it('maps plugin, Marmot and legacy codes to messages and ignores unknown input', () => {
    expect(ssoErrorMessage('state_mismatch')).toMatch(/expired/)
    expect(ssoErrorMessage('signup_disabled')).toMatch(/invitation/i)
    expect(ssoErrorMessage('oidc_state')).toBe(ssoErrorMessage('state_mismatch'))
    expect(ssoErrorMessage('email_unverified')).toMatch(/verified/)
    expect(isSsoErrorCode('constructor')).toBe(false)
    expect(isSsoErrorCode('<script>')).toBe(false)
    expect(ssoErrorMessage('nope')).toBeUndefined()
    expect(ssoErrorMessage(undefined)).toBeUndefined()
  })
})
