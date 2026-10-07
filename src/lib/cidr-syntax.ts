/**
 * Syntax check for the comma-separated CIDR lists in `MONITOR_DENY_CIDRS` / `MONITOR_ALLOW_CIDRS`.
 *
 * `src/env.ts` is part of the browser bundle, so this module must not import Node built-ins
 * (`node:net` included): IPv4 is matched with a strict dotted-quad pattern and IPv6 is validated by
 * the WHATWG URL parser, which exists in both runtimes. Matching addresses against the lists is
 * server-only and lives in `src/server/security/address-policy.ts`.
 */

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`)

/** 4 or 6 for a valid IP literal (no brackets, an IPv6 `%zone` is ignored), 0 otherwise. */
export function ipLiteralVersion(value: string): 0 | 4 | 6 {
  if (IPV4.test(value)) return 4
  if (!value.includes(':')) return 0
  const zone = value.indexOf('%')
  const address = zone === -1 ? value : value.slice(0, zone)
  if (!/^[0-9a-f:.]+$/i.test(address)) return 0
  try {
    new URL(`http://[${address}]/`)
    return 6
  } catch {
    return 0
  }
}

/**
 * Why `raw` is not a valid CIDR list (`a.b.c.d/n`, `x::y/n` or bare addresses, separated by
 * commas or whitespace), or `null` when every entry is valid.
 */
export function cidrListError(raw: string | null | undefined): string | null {
  const entries = (raw ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
  for (const entry of entries) {
    const slash = entry.indexOf('/')
    let address = slash === -1 ? entry : entry.slice(0, slash)
    if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1)
    const version = ipLiteralVersion(address)
    if (version === 0) return `"${entry}" is not an IP address or CIDR range`
    if (slash !== -1) {
      const prefix = entry.slice(slash + 1)
      const max = version === 4 ? 32 : 128
      if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > max) {
        return `"${entry}" has an invalid prefix length (0-${max})`
      }
    }
  }
  return null
}
