import { describe, expect, it } from 'vitest'

import {
  AddressPolicy,
  embeddedIPv4,
  ipv6Bytes,
  parseCidr,
  parseCidrList,
  PRIVATE_IPV4_CIDRS,
} from './address-policy'

const guard = new AddressPolicy({ denyPrivate: true })
const allowed = (policy: AddressPolicy, address: string) => policy.classify(address).allowed

describe('AddressPolicy (private set)', () => {
  it.each([
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',
    '100.127.255.254',
    '127.0.0.1',
    '127.1.2.3',
    '169.254.169.254',
    '172.16.0.1',
    '172.17.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.255',
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255',
  ])('denies IPv4 %s', (address) => {
    expect(guard.classify(address)).toEqual({ allowed: false, reason: 'private' })
  })

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '100.63.255.255',
    '100.128.0.0',
    '172.15.255.255',
    '172.32.0.0',
    '192.0.1.1',
    '192.169.0.1',
    '198.17.255.255',
    '198.20.0.0',
    '223.255.255.255',
  ])('allows public IPv4 %s', (address) => {
    expect(allowed(guard, address)).toBe(true)
  })

  it.each([
    '::',
    '::1',
    '[::1]',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0',
    'febf::1',
    'ff02::1',
    '64:ff9b:1::1',
  ])('denies IPv6 %s', (address) => {
    expect(allowed(guard, address)).toBe(false)
  })

  it.each(['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450::1', 'fbff::1'])(
    'allows public IPv6 %s',
    (address) => {
      expect(allowed(guard, address)).toBe(true)
    },
  )

  it.each([
    ['::ffff:127.0.0.1', '127.0.0.1'],
    ['::ffff:7f00:1', '127.0.0.1'],
    ['[::ffff:169.254.169.254]', '169.254.169.254'],
    ['::ffff:0:10.0.0.1', '10.0.0.1'],
    ['::127.0.0.1', '127.0.0.1'],
    ['::a9fe:a9fe', '169.254.169.254'],
    ['64:ff9b::127.0.0.1', '127.0.0.1'],
    ['64:ff9b::a00:1', '10.0.0.1'],
    ['2002:c0a8:101::1', '192.168.1.1'],
  ])('denies %s, which embeds %s', (address, embedded) => {
    expect(embeddedIPv4(address)).toBe(embedded)
    expect(allowed(guard, address)).toBe(false)
  })

  it('allows embedded public IPv4 addresses', () => {
    expect(allowed(guard, '::ffff:1.1.1.1')).toBe(true)
    expect(allowed(guard, '64:ff9b::808:808')).toBe(true)
    expect(allowed(guard, '2002:808:808::1')).toBe(true)
  })

  it('does not treat :: and ::1 as IPv4-compatible addresses', () => {
    expect(embeddedIPv4('::')).toBeNull()
    expect(embeddedIPv4('::1')).toBeNull()
    expect(embeddedIPv4('2606:4700::1111')).toBeNull()
  })

  it('denies anything that is not an IP address', () => {
    expect(guard.classify('localhost')).toEqual({ allowed: false, reason: 'invalid' })
    expect(guard.classify('2130706433')).toEqual({ allowed: false, reason: 'invalid' })
    expect(guard.classify('')).toEqual({ allowed: false, reason: 'invalid' })
  })

  it('covers every documented IPv4 range', () => {
    for (const cidr of PRIVATE_IPV4_CIDRS) {
      expect(allowed(guard, parseCidr(cidr).address)).toBe(false)
    }
  })
})

describe('AddressPolicy (lists)', () => {
  it('allows everything when off and nothing is listed', () => {
    const off = new AddressPolicy({ denyPrivate: false })
    expect(off.active).toBe(false)
    expect(allowed(off, '127.0.0.1')).toBe(true)
    expect(allowed(off, '::ffff:169.254.169.254')).toBe(true)
  })

  it('applies MONITOR_DENY_CIDRS even without the private set', () => {
    const policy = new AddressPolicy({ denyPrivate: false, denyCidrs: ['203.0.113.0/24'] })
    expect(policy.active).toBe(true)
    expect(policy.classify('203.0.113.7')).toEqual({ allowed: false, reason: 'denied' })
    expect(policy.classify('::ffff:203.0.113.7')).toEqual({ allowed: false, reason: 'denied' })
    expect(allowed(policy, '127.0.0.1')).toBe(true)
  })

  it('lets MONITOR_ALLOW_CIDRS win over the private set, including mapped forms', () => {
    const policy = new AddressPolicy({ denyPrivate: true, allowCidrs: ['10.1.0.0/16', 'fd00::/8'] })
    expect(allowed(policy, '10.1.2.3')).toBe(true)
    expect(allowed(policy, '::ffff:10.1.2.3')).toBe(true)
    expect(allowed(policy, '64:ff9b::a01:203')).toBe(true)
    expect(allowed(policy, 'fd00::5')).toBe(true)
    expect(allowed(policy, '10.2.0.1')).toBe(false)
    expect(allowed(policy, '127.0.0.1')).toBe(false)
  })

  it('never lets the allow list override MONITOR_DENY_CIDRS', () => {
    const policy = new AddressPolicy({
      denyPrivate: true,
      allowCidrs: ['10.0.0.0/8'],
      denyCidrs: ['10.0.5.0/24'],
    })
    expect(allowed(policy, '10.0.4.1')).toBe(true)
    expect(policy.classify('10.0.5.1')).toEqual({ allowed: false, reason: 'denied' })
  })

  it('treats a bare address as a single host', () => {
    const policy = new AddressPolicy({ denyPrivate: true, allowCidrs: ['127.0.0.1'] })
    expect(allowed(policy, '127.0.0.1')).toBe(true)
    expect(allowed(policy, '127.0.0.2')).toBe(false)
  })
})

describe('CIDR parsing', () => {
  it('parses lists separated by commas and whitespace', () => {
    expect(parseCidrList(' 10.0.0.0/8, fd00::/8 ,[::1]  192.168.0.1')).toEqual([
      '10.0.0.0/8',
      'fd00::/8',
      '[::1]',
      '192.168.0.1',
    ])
    expect(parseCidrList('')).toEqual([])
    expect(parseCidrList(undefined)).toEqual([])
  })

  it.each(['10.0.0.0/33', 'fd00::/129', 'example.com/8', '10.0.0.0/x', '10.0.0/8'])(
    'rejects %s',
    (entry) => {
      expect(() => parseCidrList(entry)).toThrow()
    },
  )

  it('expands IPv6 addresses to bytes', () => {
    expect(ipv6Bytes('::1')).toEqual([...Array(15).fill(0), 1])
    expect(ipv6Bytes('::ffff:1.2.3.4')?.slice(10)).toEqual([0xff, 0xff, 1, 2, 3, 4])
    expect(ipv6Bytes('1.2.3.4')).toBeNull()
  })
})
