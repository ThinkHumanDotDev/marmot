/**
 * Ping monitor: UP when the system `ping` binary gets a reply from `hostname`.
 * Inspired by Uptime Kuma 2.5.5 `server/util-server.js` (`ping`/`pingAsync`, which wrap the `ping`
 * npm package) — MIT, Louis Lam. Marmot spawns `ping` directly so no native dependency is needed.
 */
import { spawn } from 'node:child_process'

import { resolveGuardedTarget } from '@/server/security/outbound-guard'

import { registerMonitorType } from './registry'

export interface PingOptions {
  /** Per-reply timeout in seconds (`-W` on Linux). */
  timeoutSeconds?: number
  /** Number of echo requests (`-c`). */
  count?: number
  signal?: AbortSignal
}

/** Strip a scheme / brackets so `https://host` or `[::1]` work as hostnames. */
export function normalizePingHost(dest: string): string {
  try {
    const url = new URL(`http://${dest}`)
    let host = url.hostname
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
    return host || dest
  } catch {
    return dest
  }
}

/** Parse `time=12.3 ms` out of ping's output; returns the first match rounded to ms. */
export function parsePingTime(output: string): number | null {
  const match = output.match(/time[=<]\s*([\d.]+)\s*ms/i)
  return match ? Math.round(parseFloat(match[1])) : null
}

/**
 * Run the system ping once. Rejects with a readable error when the binary is missing or the host
 * does not answer.
 */
export function ping(hostname: string, options: PingOptions = {}): Promise<number> {
  const host = normalizePingHost(hostname)
  const timeout = Math.max(1, Math.ceil(options.timeoutSeconds ?? 10))
  const count = options.count ?? 1
  const args = ['-c', String(count), '-W', String(timeout), '-n', host]

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn('ping', args, { signal: options.signal, stdio: ['ignore', 'pipe', 'pipe'] })
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
            'The "ping" binary was not found on this system. Install iputils-ping (or equivalent) in the worker image, or use a TCP/HTTP monitor instead.',
          ),
        )
      } else if (err.name === 'AbortError') {
        reject(new Error(`ping timed out after ${timeout}s`))
      } else {
        reject(err)
      }
    })
    child.once('close', (code) => {
      const time = parsePingTime(stdout)
      if (code === 0 && time !== null) {
        resolve(time)
        return
      }
      const output = (stderr || stdout).trim().split('\n').filter(Boolean).pop() ?? ''
      reject(new Error(output || `ping exited with code ${code}`))
    })
  })
}

registerMonitorType({
  name: 'ping',
  label: 'Ping',
  group: 'general',
  async check(ctx) {
    if (!ctx.monitor.hostname) {
      throw new Error('Hostname is required')
    }
    const timeoutSeconds =
      ctx.monitor.timeout && ctx.monitor.timeout > 0 ? ctx.monitor.timeout : undefined
    // Outbound address guard: ping the vetted address (null when the guard is off).
    const vetted = await resolveGuardedTarget(normalizePingHost(ctx.monitor.hostname))
    ctx.heartbeat.ping = await ping(vetted?.address ?? ctx.monitor.hostname, {
      timeoutSeconds,
      signal: ctx.signal,
    })
    ctx.heartbeat.msg = ''
    ctx.heartbeat.status = 'up'
  },
})
