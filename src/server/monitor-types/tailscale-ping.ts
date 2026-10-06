/**
 * Tailscale ping monitor: runs `tailscale ping --c 1 <hostname>` on the worker host and parses the
 * reply. Requires the `tailscale` CLI in the worker image/host.
 *
 * Ported from Uptime Kuma 2.5.5 `server/monitor-types/tailscale-ping.js` — Copyright (c) 2021
 * Louis Lam, MIT License. See THIRD_PARTY_NOTICES.md.
 */
import { spawn } from 'node:child_process'

import { registerMonitorType } from './registry'
import { checkTimeoutMs, requireHostname } from './util'

/** Hostnames are passed to a subprocess: allow DNS names, IPs and Tailscale peer names only. */
const SAFE_HOST = /^[A-Za-z0-9[][A-Za-z0-9.\-_:[\]]*$/

/** Run `tailscale ping --c 1 hostname` and resolve with stdout. */
export function runTailscalePing(
  hostname: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!SAFE_HOST.test(hostname)) {
    return Promise.reject(new Error(`Invalid hostname "${hostname}"`))
  }
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn('tailscale', ['ping', '--c', '1', hostname], {
        signal,
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      reject(err)
      return
    }
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            'The "tailscale" binary was not found on this system. Install Tailscale on the worker host (or image) to use the Tailscale Ping monitor.',
          ),
        )
      } else if (err.name === 'AbortError') {
        reject(new Error(`tailscale ping timed out after ${Math.round(timeoutMs / 1000)}s`))
      } else {
        reject(err)
      }
    })
    child.once('close', (code, sig) => {
      if (sig === 'SIGTERM') {
        reject(new Error(`tailscale ping timed out after ${Math.round(timeoutMs / 1000)}s`))
        return
      }
      if (stderr.trim() && code !== 0) {
        reject(new Error(`Error in output: ${stderr.trim()}`))
        return
      }
      if (stdout.trim()) resolve(stdout)
      else reject(new Error('No output from Tailscale ping'))
    })
  })
}

/** Parse `tailscale ping` output: resolves with the round-trip time in ms, throws otherwise. */
export function parseTailscaleOutput(output: string): number {
  for (const line of output.split('\n')) {
    if (line.includes('pong from')) {
      // "pong from host (100.x.y.z) via DERP(fra) in 23ms"
      const time = line.split(' in ')[1]?.split(' ')[0] ?? ''
      const ms = parseFloat(time)
      return Number.isFinite(ms) ? Math.round(ms) : 0
    } else if (line.includes('timed out')) {
      throw new Error(`Ping timed out: "${line}"`)
    } else if (line.includes('no matching peer')) {
      throw new Error(`Nonexistant or inaccessible due to ACLs: "${line}"`)
    } else if (line.includes('is local Tailscale IP')) {
      throw new Error(`Tailscale only works if used on other machines: "${line}"`)
    } else if (line.trim() !== '') {
      throw new Error(`Unexpected output: "${line}"`)
    }
  }
  throw new Error('No pong in Tailscale ping output')
}

registerMonitorType({
  name: 'tailscale-ping',
  label: 'Tailscale Ping',
  group: 'specific',
  async check(ctx) {
    const hostname = requireHostname(ctx.monitor)
    const output = await runTailscalePing(hostname, checkTimeoutMs(ctx.monitor), ctx.signal)
    ctx.heartbeat.ping = parseTailscaleOutput(output)
    ctx.heartbeat.msg = 'OK'
    ctx.heartbeat.status = 'up'
  },
})
