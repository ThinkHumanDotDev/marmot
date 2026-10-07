import { isIP } from 'node:net'
import { describe, expect, it } from 'vitest'

import { parseCidrList } from '@/server/security/address-policy'
import { cidrListError, ipLiteralVersion } from './cidr-syntax'

const SAMPLES = [
  '127.0.0.1',
  '0.0.0.0',
  '255.255.255.255',
  '256.0.0.1',
  '01.2.3.4',
  '1.2.3',
  '1.2.3.4.5',
  '127.1',
  '2130706433',
  '0x7f.0.0.1',
  '::',
  '::1',
  'fe80::1',
  'fe80::1%eth0',
  '2001:db8::',
  '::ffff:127.0.0.1',
  '64:ff9b::10.0.0.1',
  '2001:db8::1::2',
  '2001:db8:::1',
  '12345::',
  'gggg::1',
  'localhost',
  'example.com',
  '',
]

describe('ipLiteralVersion', () => {
  it.each(SAMPLES)('agrees with node:net isIP for %j', (value) => {
    const zone = value.indexOf('%')
    const expected = isIP(zone === -1 ? value : value.slice(0, zone))
    expect(ipLiteralVersion(value)).toBe(expected)
  })
})

describe('cidrListError', () => {
  it.each([
    '',
    '10.0.0.0/8',
    '10.0.0.0/8, 192.168.1.5',
    '2001:db8::/32 fd00::/8',
    '[::1]/128',
    '100.64.0.0/10,\n172.16.0.0/12',
  ])('accepts %j like the server-side parser', (raw) => {
    expect(cidrListError(raw)).toBeNull()
    expect(() => parseCidrList(raw)).not.toThrow()
  })

  it.each(['10.0.0.0/33', '::/129', '10.0.0.0/x', 'example.com', '10.0.0/8', '1.2.3.4/'])(
    'rejects %j like the server-side parser',
    (raw) => {
      expect(cidrListError(raw)).not.toBeNull()
      expect(() => parseCidrList(raw)).toThrow()
    },
  )
})
