import { describe, expect, it } from 'vitest'

import {
  isEmailInDomains,
  isValidEmailDomain,
  normalizeEmail,
  normalizeEmailDomain,
} from './status-page-access'

describe('email domains', () => {
  it('normalizes and validates domains', () => {
    expect(normalizeEmailDomain(' @Acme.COM. ')).toBe('acme.com')
    expect(isValidEmailDomain('acme.com')).toBe(true)
    expect(isValidEmailDomain('eng.acme.co.uk')).toBe(true)
    expect(isValidEmailDomain('localhost')).toBe(false)
    expect(isValidEmailDomain('acme..com')).toBe(false)
    expect(isValidEmailDomain('-acme.com')).toBe(false)
    expect(isValidEmailDomain('*.acme.com')).toBe(false)
  })

  it('accepts single plausible addresses only', () => {
    expect(normalizeEmail(' A.Person+tag@Acme.com ')).toBe('a.person+tag@acme.com')
    for (const bad of [
      null,
      42,
      '',
      'acme.com',
      '@acme.com',
      'a@b@acme.com',
      'a@acme',
      'a b@acme.com',
      'a@acme.com, b@acme.com',
      'Name <a@acme.com>',
      `${'x'.repeat(65)}@acme.com`,
    ]) {
      expect(normalizeEmail(bad), String(bad)).toBeNull()
    }
  })

  it('matches the exact domain, not subdomains or look-alikes', () => {
    const domains = ['acme.com', 'Partner.org']
    expect(isEmailInDomains('a@acme.com', domains)).toBe(true)
    expect(isEmailInDomains('b@partner.org', domains)).toBe(true)
    expect(isEmailInDomains('a@eng.acme.com', domains)).toBe(false)
    expect(isEmailInDomains('a@notacme.com', domains)).toBe(false)
    expect(isEmailInDomains('a@acme.com.evil.io', domains)).toBe(false)
    expect(isEmailInDomains('a@acme.com', [])).toBe(false)
  })
})
