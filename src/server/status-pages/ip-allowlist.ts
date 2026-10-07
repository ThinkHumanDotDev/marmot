/**
 * IP allow-lists of status pages (`access: 'ip-allowlist'`): IPv4 and IPv6 CIDR ranges, matched with
 * `net.BlockList`. Parsing is shared with the outbound address policy (`parseCidr`), so `10.0.0.0/8`,
 * `2001:db8::/32`, `[2001:db8::1]` and a bare address (a single host) are all accepted.
 *
 * IPv4 clients seen through a dual-stack socket arrive as IPv4-mapped IPv6 (`::ffff:203.0.113.7`);
 * they are matched as the IPv4 address they are. Other embeddings (NAT64, 6to4) are not unwrapped:
 * an allow-list grants access, so it only matches what the operator listed.
 */
import { BlockList, isIP } from 'node:net'

import { ipv6Bytes, parseCidr, stripAddress } from '@/server/security/address-policy'

export interface IpRangeRow {
  cidr?: string | null
}

/**
 * Canonical form of one entry (`203.0.113.0/24`, `2001:db8::/32`); a bare address gets its host
 * prefix (`/32`, `/128`). Throws with a readable message when the entry is not an IP or a CIDR.
 */
export function normalizeCidr(entry: string): string {
  const { address, prefix, family } = parseCidr(entry)
  const list = new BlockList()
  // `addSubnet` throws on addresses Node cannot use (it already validated with `isIP`).
  list.addSubnet(address, prefix, family)
  return `${address.toLowerCase()}/${prefix}`
}

/** The address an allow-list compares: brackets, zone ids and the IPv4-mapped prefix removed. */
export function comparableAddress(
  raw: string,
): { address: string; family: 'ipv4' | 'ipv6' } | null {
  const address = stripAddress(raw)
  const version = isIP(address)
  if (version === 4) return { address, family: 'ipv4' }
  if (version !== 6) return null
  const b = ipv6Bytes(address)
  // ::ffff:a.b.c.d (also written ::ffff:aabb:ccdd)
  if (b && b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
    return { address: `${b[12]}.${b[13]}.${b[14]}.${b[15]}`, family: 'ipv4' }
  }
  return { address, family: 'ipv6' }
}

/** Compiled allow-list. Invalid entries (only possible in hand-edited data) are skipped. */
export class IpAllowList {
  private readonly list = new BlockList()
  readonly size: number

  constructor(cidrs: readonly string[]) {
    let size = 0
    for (const cidr of cidrs) {
      try {
        const { address, prefix, family } = parseCidr(cidr)
        const mapped = family === 'ipv6' ? comparableAddress(address) : null
        // `::ffff:10.0.0.0/104` is the IPv4 range `10.0.0.0/8`; store it that way.
        if (mapped?.family === 'ipv4' && prefix >= 96) {
          this.list.addSubnet(mapped.address, prefix - 96, 'ipv4')
        } else {
          this.list.addSubnet(address, prefix, family)
        }
        size++
      } catch {
        // skipped
      }
    }
    this.size = size
  }

  /** True when `ip` (v4 or v6) falls in one of the ranges. Unparseable input never matches. */
  allows(ip: string | null | undefined): boolean {
    if (!ip || this.size === 0) return false
    const parsed = comparableAddress(ip)
    if (!parsed) return false
    return this.list.check(parsed.address, parsed.family)
  }
}

const cache = new Map<string, IpAllowList>()
const CACHE_MAX = 200

/** Compiled allow-list for a page's `allowedIpRanges` rows, memoised by content. */
export function ipAllowListFor(rows: readonly IpRangeRow[] | null | undefined): IpAllowList {
  const cidrs = (rows ?? []).map((row) => row.cidr ?? '').filter(Boolean)
  const key = cidrs.join(',')
  let list = cache.get(key)
  if (!list) {
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    list = new IpAllowList(cidrs)
    cache.set(key, list)
  }
  return list
}
