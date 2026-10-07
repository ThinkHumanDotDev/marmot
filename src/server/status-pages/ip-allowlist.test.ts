import { describe, expect, it } from 'vitest'

import { comparableAddress, IpAllowList, ipAllowListFor, normalizeCidr } from './ip-allowlist'

describe('normalizeCidr', () => {
  it('accepts IPv4 and IPv6 ranges and bare addresses', () => {
    expect(normalizeCidr(' 203.0.113.0/24 ')).toBe('203.0.113.0/24')
    expect(normalizeCidr('198.51.100.7')).toBe('198.51.100.7/32')
    expect(normalizeCidr('2001:DB8::/32')).toBe('2001:db8::/32')
    expect(normalizeCidr('[2001:db8::1]')).toBe('2001:db8::1/128')
    expect(normalizeCidr('0.0.0.0/0')).toBe('0.0.0.0/0')
    expect(normalizeCidr('::/0')).toBe('::/0')
  })

  it('rejects anything else', () => {
    for (const bad of [
      '',
      'office',
      '10.0.0.0/33',
      '2001:db8::/129',
      '10.0.0.0/-1',
      '10.0.0.0/8/8',
      '256.1.1.1',
      '10.0.0/8',
      'example.com/24',
      '10.0.0.0/ 8',
    ]) {
      expect(() => normalizeCidr(bad), bad).toThrow()
    }
  })
})

describe('comparableAddress', () => {
  it('unwraps IPv4-mapped IPv6 in both notations', () => {
    expect(comparableAddress('::ffff:203.0.113.9')).toEqual({
      address: '203.0.113.9',
      family: 'ipv4',
    })
    expect(comparableAddress('::ffff:cb00:7109')).toEqual({
      address: '203.0.113.9',
      family: 'ipv4',
    })
    expect(comparableAddress('[2001:db8::1]')).toEqual({ address: '2001:db8::1', family: 'ipv6' })
    expect(comparableAddress('fe80::1%eth0')).toEqual({ address: 'fe80::1', family: 'ipv6' })
    expect(comparableAddress('nope')).toBeNull()
  })
})

describe('IpAllowList', () => {
  const list = new IpAllowList([
    '203.0.113.0/24',
    '198.51.100.7',
    '2001:db8:abcd::/48',
    '::ffff:10.0.0.0/104',
  ])

  it('matches IPv4 ranges and single hosts', () => {
    expect(list.allows('203.0.113.1')).toBe(true)
    expect(list.allows('203.0.113.255')).toBe(true)
    expect(list.allows('203.0.114.1')).toBe(false)
    expect(list.allows('198.51.100.7')).toBe(true)
    expect(list.allows('198.51.100.8')).toBe(false)
  })

  it('matches IPv6 ranges', () => {
    expect(list.allows('2001:db8:abcd:12::1')).toBe(true)
    expect(list.allows('2001:DB8:ABCD::')).toBe(true)
    expect(list.allows('2001:db8:abce::1')).toBe(false)
    expect(list.allows('::1')).toBe(false)
  })

  it('matches IPv4-mapped clients against IPv4 ranges, and mapped ranges as IPv4', () => {
    expect(list.allows('::ffff:203.0.113.20')).toBe(true)
    expect(list.allows('::ffff:cb00:7114')).toBe(true)
    expect(list.allows('10.20.30.40')).toBe(true)
    expect(list.allows('11.0.0.1')).toBe(false)
  })

  it('does not unwrap other IPv4 embeddings (NAT64, 6to4)', () => {
    expect(list.allows('64:ff9b::cb00:7101')).toBe(false)
    expect(list.allows('2002:cb00:7101::1')).toBe(false)
  })

  it('never matches missing or malformed addresses, or an empty list', () => {
    expect(list.allows(null)).toBe(false)
    expect(list.allows('')).toBe(false)
    expect(list.allows('203.0.113.1, 10.0.0.1')).toBe(false)
    expect(list.allows('not-an-ip')).toBe(false)
    expect(new IpAllowList([]).allows('203.0.113.1')).toBe(false)
  })

  it('skips invalid stored entries instead of failing', () => {
    const partial = new IpAllowList(['nonsense', '192.0.2.0/24'])
    expect(partial.size).toBe(1)
    expect(partial.allows('192.0.2.10')).toBe(true)
  })

  it('memoises compiled lists by content', () => {
    const a = ipAllowListFor([{ cidr: '192.0.2.0/24' }])
    expect(ipAllowListFor([{ cidr: '192.0.2.0/24' }])).toBe(a)
    expect(ipAllowListFor([{ cidr: '192.0.3.0/24' }])).not.toBe(a)
    expect(ipAllowListFor(null).allows('192.0.2.1')).toBe(false)
  })
})
