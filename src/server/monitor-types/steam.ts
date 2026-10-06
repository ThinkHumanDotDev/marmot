/**
 * Steam game server monitor: asks the Steam Web API (`IGameServersService/GetServerList`) whether
 * a server is listed at `hostname:port`; UP when it is, with the server name as message. The API
 * key comes from the `steamApiKey` instance setting. Pings the host for the response time when the
 * system `ping` is available.
 *
 * Ported from Uptime Kuma 2.5.5 `server/monitor-types/steam.js` — Copyright (c) 2021 Louis Lam,
 * MIT License. See THIRD_PARTY_NOTICES.md.
 */
import dns from 'node:dns/promises'
import net from 'node:net'

import { getInstanceSettings } from '@/server/settings'

import { ping } from './ping'
import { registerMonitorType } from './registry'
import { checkTimeoutMs, errorMessage, requireHostname } from './util'

export const STEAM_API_URL = 'https://api.steampowered.com/IGameServersService/GetServerList/v1/'

/** The Steam `addr` filter only accepts IP addresses; resolve hostnames first (IPv4 preferred). */
export async function resolveSteamHostname(hostname: string): Promise<string> {
  if (net.isIP(hostname)) return hostname
  try {
    const addresses = await dns.lookup(hostname, { all: true })
    const ipv4 = addresses.find(({ address }) => net.isIP(address) === 4)
    const resolved = ipv4?.address ?? addresses[0]?.address
    if (!resolved) throw new Error('DNS lookup returned no addresses')
    return resolved
  } catch (err) {
    throw new Error(`Unable to resolve Steam server hostname "${hostname}": ${errorMessage(err)}`)
  }
}

interface SteamServerListResponse {
  response?: { servers?: { name?: string }[] }
}

/** Query the server list for `addr\<ip>:<port>`; resolves with the first server's name. */
export async function querySteamServer(
  apiKey: string,
  ip: string,
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const url = new URL(STEAM_API_URL)
  url.searchParams.set('filter', `addr\\${ip}:${port}`)
  url.searchParams.set('key', apiKey)
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]
  let res: Response
  try {
    res = await fetch(url, { headers: { Accept: '*/*' }, signal: AbortSignal.any(signals) })
  } catch (err) {
    const cause = (err as { cause?: unknown })?.cause
    throw new Error(
      `Steam API request failed: ${cause instanceof Error ? cause.message : errorMessage(err)}`,
    )
  }
  if (!res.ok) {
    throw new Error(`Steam API returned ${res.status} - ${res.statusText}`)
  }
  const data = (await res.json().catch(() => ({}))) as SteamServerListResponse
  const servers = data.response?.servers
  if (!servers || servers.length === 0) {
    throw new Error('Server not found on Steam')
  }
  return servers[0].name ?? `${ip}:${port}`
}

registerMonitorType({
  name: 'steam',
  label: 'Steam Game Server',
  group: 'game',
  async check(ctx) {
    const hostname = requireHostname(ctx.monitor)
    if (!ctx.monitor.port) throw new Error('Port is required')
    const { steamApiKey } = await getInstanceSettings(ctx.payload)
    if (!steamApiKey) {
      throw new Error(
        'Steam API key is not configured. Set steamApiKey in the instance settings (Payload admin → Instance settings).',
      )
    }
    const timeout = checkTimeoutMs(ctx.monitor)
    const ip = await resolveSteamHostname(hostname)
    const name = await querySteamServer(steamApiKey, ip, ctx.monitor.port, timeout, ctx.signal)
    ctx.heartbeat.status = 'up'
    ctx.heartbeat.msg = name
    try {
      ctx.heartbeat.ping = await ping(hostname, {
        timeoutSeconds: Math.max(1, Math.ceil(timeout / 1000)),
        signal: ctx.signal,
      })
    } catch {
      // Ping is best effort (ICMP may be blocked); the API answer already proves the server is up.
      ctx.heartbeat.ping = null
    }
  },
})
