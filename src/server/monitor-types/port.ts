/**
 * TCP port monitor: UP when a TCP connection to `hostname:port` succeeds.
 * Ported from Uptime Kuma 2.5.5 `server/monitor-types/tcp.js` (`checkTcp`) — MIT, Louis Lam.
 * Uses `net.connect` instead of the `tcp-ping` package.
 */
import net from 'node:net'
import { performance } from 'node:perf_hooks'

import { roundPhase } from '@/lib/request-timing'
import { resolveGuardedTarget } from '@/server/security/outbound-guard'

import { registerMonitorType } from './registry'

/** Time to connect, split into the DNS lookup (null for an IP literal) and the TCP connect. */
export interface TcpTiming {
  /** Total time to connect in ms (lookup included), the heartbeat's ping. */
  ms: number
  dns: number | null
  connect: number
}

/** Connect once and resolve with the time to connect in ms. */
export function tcping(hostname: string, port: number, signal?: AbortSignal): Promise<TcpTiming> {
  return new Promise((resolve, reject) => {
    const start = performance.now()
    let lookupAt: number | undefined
    const socket = net.connect({ host: hostname, port, signal })
    const fail = (err: Error) => {
      socket.destroy()
      reject(err)
    }
    socket.once('lookup', () => (lookupAt ??= performance.now()))
    socket.once('connect', () => {
      const end = performance.now()
      socket.end()
      socket.destroy()
      resolve({
        ms: Math.round(end - start),
        dns: lookupAt === undefined ? null : roundPhase(lookupAt - start),
        connect: roundPhase(end - (lookupAt ?? start)),
      })
    })
    socket.once('error', fail)
    socket.once('timeout', () => fail(new Error('Connection timed out')))
  })
}

registerMonitorType({
  name: 'port',
  label: 'TCP Port',
  group: 'general',
  async check(ctx) {
    const { hostname, port } = ctx.monitor
    if (!hostname || !port) {
      throw new Error('Hostname and port are required')
    }
    // Outbound address guard: connect to the vetted address (null when the guard is off). The
    // guard's resolution then is the DNS phase; the socket connects to an IP literal.
    const guardStart = performance.now()
    const vetted = await resolveGuardedTarget(hostname)
    const guardDns =
      vetted && !net.isIP(hostname.replace(/^\[|\]$/g, ''))
        ? roundPhase(performance.now() - guardStart)
        : null
    let result: TcpTiming
    try {
      result = await tcping(vetted?.address ?? hostname, port, ctx.signal)
    } catch (err) {
      throw new Error(
        `Connection failed${err instanceof Error && err.message ? `: ${err.message}` : ''}`,
      )
    }
    ctx.heartbeat.ping = result.ms
    ctx.heartbeat.msg = `${result.ms} ms`
    ctx.heartbeat.status = 'up'
    ctx.timing = {
      dns: result.dns ?? guardDns,
      connect: result.connect,
      tls: null,
      ttfb: null,
      transfer: null,
    }
  },
})
