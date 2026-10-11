/**
 * Address classification for outbound connections made on behalf of organizations (monitor checks,
 * notification deliveries). Pure and synchronous: callers resolve hostnames first and classify every
 * resulting address (see `outbound-guard.ts`).
 *
 * Built on `net.BlockList`. IPv6 addresses that embed an IPv4 address (IPv4-mapped `::ffff:a.b.c.d`,
 * IPv4-compatible `::a.b.c.d`, SIIT `::ffff:0:a.b.c.d`, NAT64 `64:ff9b::/96` and 6to4 `2002::/16`)
 * are also judged by the embedded IPv4 address, so `::ffff:127.0.0.1` is as private as `127.0.0.1`.
 */
import { BlockList, isIP } from 'node:net'

/** IPv4 ranges denied by `MONITOR_DENY_PRIVATE_ADDRESSES`. */
export const PRIVATE_IPV4_CIDRS = [
  '0.0.0.0/8', // "this network"
  '10.0.0.0/8', // RFC 1918
  '100.64.0.0/10', // CGNAT (RFC 6598), also used by tailnets
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local, cloud metadata endpoints
  '172.16.0.0/12', // RFC 1918, default Docker networks
  '192.0.0.0/24', // IETF protocol assignments
  '192.168.0.0/16', // RFC 1918
  '198.18.0.0/15', // benchmarking
  '224.0.0.0/3', // multicast (224/4), reserved (240/4) and broadcast
] as const

/** IPv6 ranges denied by `MONITOR_DENY_PRIVATE_ADDRESSES`. */
export const PRIVATE_IPV6_CIDRS = [
  '::/128', // unspecified
  '::1/128', // loopback
  '64:ff9b:1::/48', // local-use NAT64 (RFC 8215)
  'fc00::/7', // unique local
  'fe80::/10', // link-local
  'fec0::/10', // site-local (deprecated)
  'ff00::/8', // multicast
] as const

export interface AddressPolicyConfig {
  /** Deny the private/loopback/link-local ranges above. */
  denyPrivate: boolean
  /** Extra ranges that are always denied (`MONITOR_DENY_CIDRS`). */
  denyCidrs?: readonly string[]
  /** Exceptions to the private ranges (`MONITOR_ALLOW_CIDRS`). They never override `denyCidrs`. */
  allowCidrs?: readonly string[]
  /** Deny every address (demo mode, #159): nothing may leave the instance. Overrides the rest. */
  denyAll?: boolean
}

export type AddressVerdict =
  | { allowed: true }
  | {
      allowed: false
      /**
       * `private`: in the private set; `denied`: in `denyCidrs`; `demo`: demo mode denies every
       * address; `invalid`: not an IP address.
       */
      reason: 'private' | 'denied' | 'demo' | 'invalid'
    }

interface ParsedCidr {
  address: string
  prefix: number
  family: 'ipv4' | 'ipv6'
}

/** Remove `[...]` around an IPv6 literal and a `%zone` suffix. */
export function stripAddress(address: string): string {
  let value = address.trim()
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  const zone = value.indexOf('%')
  if (zone !== -1 && isIP(value.slice(0, zone)) === 6) value = value.slice(0, zone)
  return value
}

/** Parse `a.b.c.d/n`, `x::y/n` or a bare address (a single host). Throws on malformed input. */
export function parseCidr(entry: string): ParsedCidr {
  const value = entry.trim()
  const slash = value.indexOf('/')
  const address = stripAddress(slash === -1 ? value : value.slice(0, slash))
  const version = isIP(address)
  if (version === 0) throw new Error(`"${entry}" is not an IP address or CIDR range`)
  const max = version === 4 ? 32 : 128
  let prefix = max
  if (slash !== -1) {
    const raw = value.slice(slash + 1)
    if (!/^\d{1,3}$/.test(raw) || Number(raw) > max) {
      throw new Error(`"${entry}" has an invalid prefix length (0-${max})`)
    }
    prefix = Number(raw)
  }
  return { address, prefix, family: version === 4 ? 'ipv4' : 'ipv6' }
}

/** Comma- (or whitespace-) separated CIDR list → entries. Throws on the first malformed entry. */
export function parseCidrList(raw: string | null | undefined): string[] {
  const entries = (raw ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
  for (const entry of entries) parseCidr(entry)
  return entries
}

function blockListOf(cidrs: readonly string[]): BlockList {
  const list = new BlockList()
  for (const cidr of cidrs) {
    const { address, prefix, family } = parseCidr(cidr)
    list.addSubnet(address, prefix, family)
  }
  return list
}

/** The 16 bytes of an IPv6 address (no brackets, no zone), or null when it does not parse. */
export function ipv6Bytes(address: string): number[] | null {
  if (isIP(address) !== 6) return null
  let text = address
  // A trailing dotted quad (`::ffff:1.2.3.4`) becomes two hex groups (`::ffff:102:304`).
  const lastColon = text.lastIndexOf(':')
  const tail = text.slice(lastColon + 1)
  if (tail.includes('.')) {
    const [a, b, c, d] = tail.split('.').map(Number)
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const double = text.indexOf('::')
  const left = double === -1 ? text : text.slice(0, double)
  const right = double === -1 ? '' : text.slice(double + 2)
  const leftGroups = left ? left.split(':') : []
  const rightGroups = right ? right.split(':') : []
  const fill = double === -1 ? 0 : 8 - leftGroups.length - rightGroups.length
  if (fill < 0) return null
  const groups = [...leftGroups, ...Array<string>(fill).fill('0'), ...rightGroups]
  if (groups.length !== 8) return null
  const bytes: number[] = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
    const n = parseInt(group, 16)
    bytes.push((n >> 8) & 0xff, n & 0xff)
  }
  return bytes
}

const v4 = (b: number[], at: number) => `${b[at]}.${b[at + 1]}.${b[at + 2]}.${b[at + 3]}`

/**
 * The IPv4 address embedded in an IPv6 address, as the network would route it: IPv4-mapped
 * (`::ffff:0:0/96`), SIIT (`::ffff:0:0:0/96`), IPv4-compatible (`::/96`, except `::` and `::1`),
 * NAT64 well-known prefix (`64:ff9b::/96`) and 6to4 (`2002::/16`). Null when there is none.
 */
export function embeddedIPv4(address: string): string | null {
  const b = ipv6Bytes(stripAddress(address))
  if (!b) return null
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0)
  // ::ffff:a.b.c.d
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4(b, 12)
  // ::ffff:0:a.b.c.d
  if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return v4(b, 12)
  // ::a.b.c.d (deprecated IPv4-compatible); `::` and `::1` are themselves.
  if (zero(0, 12) && !zero(12, 15)) return v4(b, 12)
  // 64:ff9b::a.b.c.d
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) {
    return v4(b, 12)
  }
  // 2002:aabb:ccdd::/48 (6to4)
  if (b[0] === 0x20 && b[1] === 0x02) return v4(b, 2)
  return null
}

/**
 * Classifies IP addresses against the private set, the deny list and the allow list. Precedence:
 * `denyAll` (demo mode) > `denyCidrs` (always denied) > `allowCidrs` (exceptions) > private set
 * (when `denyPrivate`).
 */
export class AddressPolicy {
  readonly denyPrivate: boolean
  readonly denyAll: boolean
  private readonly privateList: BlockList
  private readonly denyList: BlockList | null
  private readonly allowList: BlockList | null

  constructor(config: AddressPolicyConfig) {
    this.denyPrivate = config.denyPrivate
    this.denyAll = config.denyAll ?? false
    this.privateList = blockListOf([...PRIVATE_IPV4_CIDRS, ...PRIVATE_IPV6_CIDRS])
    this.denyList = config.denyCidrs?.length ? blockListOf(config.denyCidrs) : null
    this.allowList = config.allowCidrs?.length ? blockListOf(config.allowCidrs) : null
  }

  /** Whether any address can be denied at all (otherwise callers skip resolution entirely). */
  get active(): boolean {
    return this.denyAll || this.denyPrivate || this.denyList !== null
  }

  /** Judge one IP address (v4 or v6, brackets and zone ids allowed). Non-IPs are `invalid`. */
  classify(rawAddress: string): AddressVerdict {
    const address = stripAddress(rawAddress)
    const version = isIP(address)
    if (version === 0) return { allowed: false, reason: 'invalid' }
    if (this.denyAll) return { allowed: false, reason: 'demo' }

    const candidates: { address: string; type: 'ipv4' | 'ipv6' }[] = [
      { address, type: version === 4 ? 'ipv4' : 'ipv6' },
    ]
    if (version === 6) {
      const embedded = embeddedIPv4(address)
      if (embedded) candidates.push({ address: embedded, type: 'ipv4' })
    }
    const inList = (list: BlockList | null) =>
      list !== null && candidates.some((c) => list.check(c.address, c.type))

    if (inList(this.denyList)) return { allowed: false, reason: 'denied' }
    if (!this.denyPrivate) return { allowed: true }
    if (!inList(this.privateList)) return { allowed: true }
    if (inList(this.allowList)) return { allowed: true }
    return { allowed: false, reason: 'private' }
  }
}
