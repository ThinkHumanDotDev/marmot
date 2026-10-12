/**
 * SSH monitor: connects to `hostname:port` (default 22) and reads the server's identification
 * banner (`SSH-2.0-OpenSSH_9.6`). With `sshUsername` it also authenticates (password or private
 * key, the same fields as the SFTP monitor) and, with `sshCommand`, runs the command and checks its
 * exit code (`sshExpectedExitCode`, default 0) and, optionally, that its output contains
 * `sshExpectedOutput`. `ssh2` is an optional dependency loaded inside `check()`.
 */
import net from 'node:net'
import { performance } from 'node:perf_hooks'

import type { Client, ConnectConfig } from 'ssh2'

import type { Monitor } from '@/payload-types'
import { resolveGuardedTarget } from '@/server/security/outbound-guard'

import { registerMonitorType } from './registry'
import { formatSftpError } from './sftp'
import {
  checkTimeoutMs,
  loadOptionalDriver,
  requireField,
  requireHostname,
  responseExcerpt,
  withAbort,
} from './util'

export const DEFAULT_SSH_PORT = 22
/** RFC 4253 §4.2: the identification line is at most 255 bytes; servers may send other lines first. */
const MAX_BANNER_BYTES = 8192
/** Most command output kept for the assertion and the heartbeat message. */
export const MAX_SSH_OUTPUT_BYTES = 64 * 1024

/**
 * Find the SSH identification line in what the server sent so far. Returns the line (without
 * CRLF) or null when it has not arrived yet.
 */
export function findSshBanner(received: string): string | null {
  for (const line of received.split('\n').slice(0, -1)) {
    const trimmed = line.replace(/\r$/, '')
    if (trimmed.startsWith('SSH-')) return trimmed
  }
  return null
}

/**
 * Connect and wait for the identification line. The socket is paused afterwards with everything
 * it received pushed back, so `ssh2` can take over the same connection.
 */
export function readSshBanner(
  host: string,
  port: number,
  signal: AbortSignal,
): Promise<{ socket: net.Socket; banner: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    let received = Buffer.alloc(0)
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      fn()
    }
    const fail = (err: Error) =>
      finish(() => {
        socket.destroy()
        reject(err)
      })
    const onAbort = () => {
      const err = new Error('timeout by AbortSignal')
      err.name = 'TimeoutError'
      fail(err)
    }
    const onError = (err: Error) => fail(err)
    const onClose = () =>
      fail(new Error('The server closed the connection before sending a banner'))
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk])
      const banner = findSshBanner(received.toString('latin1'))
      if (banner) {
        finish(() => {
          socket.pause()
          socket.unshift(received)
          resolve({ socket, banner })
        })
      } else if (received.length > MAX_BANNER_BYTES) {
        fail(new Error('No SSH identification banner received (is this an SSH server?)'))
      }
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

/** ssh2 credentials from the monitor's SSH settings (the same fields as SFTP). */
export function sshAuthOptions(
  monitor: Pick<
    Monitor,
    'sshUsername' | 'sshAuthMethod' | 'sshPassword' | 'sshPrivateKey' | 'sshPassphrase'
  >,
): Pick<ConnectConfig, 'username' | 'password' | 'privateKey' | 'passphrase'> {
  const username = requireField(monitor.sshUsername, 'Username')
  if (monitor.sshAuthMethod === 'privateKey') {
    return {
      username,
      privateKey: requireField(
        monitor.sshPrivateKey,
        'SSH private key (required for key-based authentication)',
      ),
      ...(monitor.sshPassphrase ? { passphrase: monitor.sshPassphrase } : {}),
    }
  }
  return { username, password: monitor.sshPassword ?? '' }
}

export interface SshCommandResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
}

/** Run `command` on an authenticated connection and collect (capped) output and the exit status. */
export function execSshCommand(client: Client, command: string): Promise<SshCommandResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        reject(new Error(`Could not run the command: ${err.message}`))
        return
      }
      const out = { stdout: '', stderr: '' }
      const append = (key: 'stdout' | 'stderr') => (chunk: Buffer) => {
        if (out[key].length < MAX_SSH_OUTPUT_BYTES) {
          out[key] = (out[key] + chunk.toString('utf8')).slice(0, MAX_SSH_OUTPUT_BYTES)
        }
      }
      let code: number | null = null
      let signal: string | null = null
      stream.on('data', append('stdout'))
      stream.stderr.on('data', append('stderr'))
      stream.on('exit', (exitCode: number | null, exitSignal?: string) => {
        code = typeof exitCode === 'number' ? exitCode : null
        signal = exitSignal ?? null
      })
      stream.on('close', (exitCode?: number | null) => {
        if (code === null && typeof exitCode === 'number') code = exitCode
        resolve({ code, signal, ...out })
      })
      stream.on('error', (streamErr: Error) => reject(streamErr))
    })
  })
}

/** Throw unless the command result satisfies the monitor's expectations. */
export function assertSshCommand(
  result: SshCommandResult,
  expectedExitCode: number,
  expectedOutput: string | null | undefined,
): void {
  if (result.code === null) {
    throw new Error(
      `The command ended without an exit code${result.signal ? ` (signal ${result.signal})` : ''}`,
    )
  }
  if (result.code !== expectedExitCode) {
    const output = (result.stderr || result.stdout).trim()
    throw new Error(
      `The command exited with ${result.code}, expected ${expectedExitCode}${output ? `: ${responseExcerpt(output)}` : ''}`,
    )
  }
  if (expectedOutput && !result.stdout.includes(expectedOutput)) {
    throw new Error(
      `The command output does not contain "${expectedOutput}": ${responseExcerpt(result.stdout.trim())}`,
    )
  }
}

registerMonitorType({
  name: 'ssh',
  label: 'SSH',
  group: 'specific',
  async check(ctx) {
    const { monitor } = ctx
    const hostname = requireHostname(monitor).replace(/^\[|\]$/g, '')
    const port = monitor.port || DEFAULT_SSH_PORT
    const authenticate = Boolean(monitor.sshUsername?.trim())
    const command = monitor.sshCommand?.trim() || null
    if (command && !authenticate) throw new Error('Username is required to run a command')
    const auth = authenticate ? sshAuthOptions(monitor) : null
    const ssh2 = authenticate ? await loadOptionalDriver(() => import('ssh2'), 'ssh2', 'SSH') : null

    // Outbound address guard: connect to the vetted address (no TLS name to keep).
    const vetted = await resolveGuardedTarget(hostname)
    const start = performance.now()
    let socket: net.Socket
    let banner: string
    try {
      ;({ socket, banner } = await readSshBanner(vetted?.address ?? hostname, port, ctx.signal))
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') throw err
      throw new Error(formatSftpError(err, hostname, port))
    }
    const bannerMs = performance.now() - start

    if (!ssh2 || !auth) {
      socket.destroy()
      ctx.heartbeat.ping = Math.round(bannerMs)
      ctx.heartbeat.msg = responseExcerpt(banner)
      ctx.heartbeat.status = 'up'
      return
    }

    const client: Client = new ssh2.Client()
    // Late protocol errors (after the outcome is decided) must not crash the worker.
    client.on('error', () => undefined)
    const timeout = checkTimeoutMs(monitor)
    try {
      await withAbort(
        new Promise<void>((resolve, reject) => {
          client.once('ready', () => resolve())
          client.once('error', (err) => reject(err))
          client.once('close', () => reject(new Error('The server closed the connection')))
          client.connect({ sock: socket, ...auth, readyTimeout: timeout })
          socket.resume()
        }),
        ctx.signal,
        () => client.end(),
      )
      const parts = [banner, `authenticated as ${auth.username}`]
      if (command) {
        const result = await withAbort(execSshCommand(client, command), ctx.signal, () =>
          client.end(),
        )
        assertSshCommand(result, monitor.sshExpectedExitCode ?? 0, monitor.sshExpectedOutput)
        parts.push(`command exited with ${result.code}`)
      }
      ctx.heartbeat.ping = Math.round(performance.now() - start)
      ctx.heartbeat.msg = responseExcerpt(parts.join(', '))
      ctx.heartbeat.status = 'up'
    } catch (err) {
      const error = err as Error & { level?: string }
      if (error.name === 'TimeoutError') throw error
      if (error.level === 'client-authentication') {
        throw new Error(`Authentication failed for ${auth.username}: ${error.message}`)
      }
      if ((error as NodeJS.ErrnoException).code)
        throw new Error(formatSftpError(err, hostname, port))
      throw error
    } finally {
      client.end()
      socket.destroy()
    }
  },
})
