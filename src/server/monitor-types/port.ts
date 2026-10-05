/**
 * TCP port monitor: UP when a TCP connection to `hostname:port` succeeds.
 * Ported from Uptime Kuma 2.5.5 `server/monitor-types/tcp.js` (`checkTcp`) — MIT, Louis Lam.
 * Uses `net.connect` instead of the `tcp-ping` package.
 */
import net from 'node:net'

import { registerMonitorType } from './registry'

/** Connect once and resolve with the time to connect in ms. */
export function tcping(hostname: string, port: number, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const socket = net.connect({ host: hostname, port, signal })
    const fail = (err: Error) => {
      socket.destroy()
      reject(err)
    }
    socket.once('connect', () => {
      const ms = Date.now() - start
      socket.end()
      socket.destroy()
      resolve(ms)
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
    let ms: number
    try {
      ms = await tcping(hostname, port, ctx.signal)
    } catch (err) {
      throw new Error(
        `Connection failed${err instanceof Error && err.message ? `: ${err.message}` : ''}`,
      )
    }
    ctx.heartbeat.ping = ms
    ctx.heartbeat.msg = `${ms} ms`
    ctx.heartbeat.status = 'up'
  },
})
