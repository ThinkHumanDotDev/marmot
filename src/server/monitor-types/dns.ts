/**
 * DNS monitor: resolves `hostname` with the configured resolver(s) and reports the records.
 * Ported from Uptime Kuma 2.5.5 `server/monitor-types/dns.js` — Copyright (c) 2021 Louis Lam,
 * MIT License. See THIRD_PARTY_NOTICES.md. (Condition evaluation is left to the conditions issue.)
 */
import { Resolver } from 'node:dns/promises'
import net from 'node:net'

import { assertHostsAllowed } from '@/server/security/outbound-guard'

import { registerMonitorType } from './registry'

export type DnsRecordType =
  'A' | 'AAAA' | 'CAA' | 'CNAME' | 'MX' | 'NS' | 'PTR' | 'SOA' | 'SRV' | 'TXT'

/**
 * Parse a comma-separated list of resolver servers and resolve hostnames to IPs
 * (so docker service names like `adguard` work).
 */
export async function resolveDnsResolverServers(dnsResolveServer: string): Promise<string[]> {
  const addresses = dnsResolveServer
    .replace(/\s/g, '')
    .split(',')
    .filter((x) => x !== '')
  if (!addresses.length) {
    throw new Error(
      'No Resolver Servers specified. Please specify at least one resolver server like 1.1.1.1 or a hostname',
    )
  }
  const resolver = new Resolver()
  const ips = await Promise.all(
    addresses.map(async (entry) => {
      if (net.isIP(entry)) return [entry]
      const [v4, v6] = await Promise.allSettled([
        resolver.resolve4(entry),
        resolver.resolve6(entry),
      ])
      return [
        ...(v4.status === 'fulfilled' ? v4.value : []),
        ...(v6.status === 'fulfilled' ? v6.value : []),
      ]
    }),
  )
  const parsed = ips.flat()
  if (!parsed.length) {
    throw new Error(
      'None of the configured resolver servers could be resolved to an IP address. Please provide a comma-separated list of valid resolver hostnames or IP addresses.',
    )
  }
  return parsed
}

/** Resolve `hostname` using the given servers/port. */
export async function dnsResolve(
  hostname: string,
  resolverServers: string[],
  resolverPort: number,
  rrtype: DnsRecordType,
  timeoutMs?: number,
): Promise<unknown> {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 })
  resolver.setServers(resolverServers.map((server) => `[${server}]:${resolverPort}`))
  if (rrtype === 'PTR') {
    return resolver.reverse(hostname)
  }
  return resolver.resolve(hostname, rrtype)
}

/** Human-readable summary of a resolve() result, per record type. */
export function formatDnsResult(rrtype: DnsRecordType, dnsRes: unknown): string {
  switch (rrtype) {
    case 'A':
    case 'AAAA':
    case 'PTR':
      return `Records: ${(dnsRes as string[]).join(' | ')}`
    case 'TXT':
      return `Records: ${(dnsRes as string[][]).map((r) => r.join('')).join(' | ')}`
    case 'CNAME':
      return (dnsRes as string[])[0] ?? ''
    case 'CAA':
      return `Records: ${(dnsRes as { issue?: string }[])
        .map((record) => record.issue)
        .filter(Boolean)
        .join(' | ')}`
    case 'MX':
      return (dnsRes as { exchange: string; priority: number }[])
        .map((record) => `Hostname: ${record.exchange} - Priority: ${record.priority}`)
        .join(' | ')
    case 'NS':
      return `Servers: ${(dnsRes as string[]).join(' | ')}`
    case 'SOA': {
      const soa = dnsRes as {
        nsname: string
        hostmaster: string
        serial: number
        refresh: number
        retry: number
        expire: number
        minttl: number
      }
      return `NS-Name: ${soa.nsname} | Hostmaster: ${soa.hostmaster} | Serial: ${soa.serial} | Refresh: ${soa.refresh} | Retry: ${soa.retry} | Expire: ${soa.expire} | MinTTL: ${soa.minttl}`
    }
    case 'SRV':
      return (dnsRes as { name: string; port: number; priority: number; weight: number }[])
        .map(
          (record) =>
            `Name: ${record.name} | Port: ${record.port} | Priority: ${record.priority} | Weight: ${record.weight}`,
        )
        .join(' | ')
    default:
      return JSON.stringify(dnsRes)
  }
}

registerMonitorType({
  name: 'dns',
  label: 'DNS',
  group: 'specific',
  supportsConditions: true,
  async check(ctx) {
    const { hostname } = ctx.monitor
    if (!hostname) throw new Error('Hostname is required')
    const rrtype = (ctx.monitor.dnsResolveType ?? 'A') as DnsRecordType
    const port = ctx.monitor.port ?? 53
    const timeoutMs =
      ctx.monitor.timeout && ctx.monitor.timeout > 0 ? ctx.monitor.timeout * 1000 : undefined

    const startTime = Date.now()
    const servers = await resolveDnsResolverServers(ctx.monitor.dnsResolveServer ?? '1.1.1.1')
    // Outbound address guard: the queries go to exactly these (already resolved) server addresses.
    await assertHostsAllowed(servers)
    const dnsRes = await dnsResolve(hostname, servers, port, rrtype, timeoutMs)
    ctx.heartbeat.ping = Date.now() - startTime

    ctx.heartbeat.msg = formatDnsResult(rrtype, dnsRes)
    ctx.heartbeat.status = 'up'
  },
})
