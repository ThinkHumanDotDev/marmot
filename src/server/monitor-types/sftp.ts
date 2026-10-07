/**
 * SFTP monitor: opens an SSH/SFTP session to `hostname:port` (default 22) with a password or
 * private key and optionally checks that `sftpPath` exists. `ssh2-sftp-client` is an optional
 * dependency loaded inside `check()`.
 *
 * Ported from Uptime Kuma 2.5.5 `server/monitor-types/sftp.js` — Copyright (c) 2021 Louis Lam,
 * MIT License. See THIRD_PARTY_NOTICES.md.
 */
import type { ConnectOptions } from 'ssh2-sftp-client'

import type { Monitor } from '@/payload-types'

import { resolveGuardedTarget } from '@/server/security/outbound-guard'

import { registerMonitorType } from './registry'
import {
  checkTimeoutMs,
  loadOptionalDriver,
  requireField,
  requireHostname,
  withAbort,
} from './util'

export const DEFAULT_SFTP_PORT = 22

/**
 * Human-readable message for an ssh2-sftp-client error. The library prefixes every message with
 * the internal method name (`getConnection: `) and sometimes leaves nothing when the socket closes
 * silently.
 */
export function formatSftpError(err: unknown, host: string, port: number): string {
  const error = err as { code?: string; message?: string }
  const code = error?.code ?? ''
  const rawMsg = (error?.message ?? '').replace(/^[\w-]+\s*:\s*/, '').trim()
  switch (code) {
    case 'ECONNREFUSED':
      return `Connection refused — ${host}:${port} actively rejected the connection`
    case 'ENOTFOUND':
      return `Host not found — cannot resolve hostname "${host}"`
    case 'ECONNRESET':
      return `Connection reset by remote host ${host}:${port}`
    case 'ENETUNREACH':
    case 'EHOSTUNREACH':
      return `Network unreachable — cannot reach ${host}:${port}`
    case 'ETIMEDOUT':
      return `Connection timed out — ${host}:${port} did not respond in time`
    default:
      return rawMsg || `Connection failed — ${host}:${port} is unreachable or offline`
  }
}

/** ssh2 connect options from the monitor's SSH settings. */
export function sftpConnectOptions(
  monitor: Pick<
    Monitor,
    | 'hostname'
    | 'port'
    | 'sshUsername'
    | 'sshAuthMethod'
    | 'sshPassword'
    | 'sshPrivateKey'
    | 'sshPassphrase'
  >,
  timeoutMs: number,
): ConnectOptions {
  const options: ConnectOptions = {
    host: requireHostname(monitor),
    port: monitor.port || DEFAULT_SFTP_PORT,
    username: requireField(monitor.sshUsername, 'Username'),
    readyTimeout: timeoutMs,
    timeout: timeoutMs,
  }
  if (monitor.sshAuthMethod === 'privateKey') {
    options.privateKey = requireField(
      monitor.sshPrivateKey,
      'SSH private key (required for key-based authentication)',
    )
    if (monitor.sshPassphrase) options.passphrase = monitor.sshPassphrase
  } else {
    options.password = monitor.sshPassword ?? ''
  }
  return options
}

registerMonitorType({
  name: 'sftp',
  label: 'SFTP',
  group: 'specific',
  async check(ctx) {
    const timeout = checkTimeoutMs(ctx.monitor)
    const options = sftpConnectOptions(ctx.monitor, timeout)
    const host = options.host as string
    const port = options.port as number
    const { default: SftpClient } = await loadOptionalDriver(
      () => import('ssh2-sftp-client'),
      'ssh2-sftp-client',
      'SFTP',
    )
    // Outbound address guard: SSH connects to the vetted address (no TLS name to keep).
    const vetted = await resolveGuardedTarget(host)
    if (vetted) options.host = vetted.address
    const sftp = new SftpClient()
    let connected = false
    const startTime = Date.now()
    try {
      await withAbort(
        sftp.connect(options),
        ctx.signal,
        () => void sftp.end().catch(() => undefined),
      )
      connected = true
      if (ctx.monitor.sftpPath) {
        const exists = await withAbort(sftp.exists(ctx.monitor.sftpPath), ctx.signal)
        if (!exists) {
          throw new Error(`Path "${ctx.monitor.sftpPath}" does not exist on the SFTP server`)
        }
      }
    } catch (err) {
      throw new Error(formatSftpError(err, host, port))
    } finally {
      if (connected) await sftp.end().catch(() => undefined)
    }
    ctx.heartbeat.ping = Date.now() - startTime
    ctx.heartbeat.msg = 'SFTP connection successful'
    ctx.heartbeat.status = 'up'
  },
})
