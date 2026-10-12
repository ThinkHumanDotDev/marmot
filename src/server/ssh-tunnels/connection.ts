/**
 * SSH connections to tunnel bastions (#160): connect with host key verification, a pool of one
 * connection per tunnel (keepalive, reconnect on the next check after a drop, closed when idle) and
 * per-check sessions that forward TCP connections to targets behind the bastion (`forwardOut`).
 *
 * Credentials only live in memory while connecting; nothing here logs them, and error messages are
 * built from ssh2's messages, which never contain them.
 */
import { createHash } from 'node:crypto'
import net, { type AddressInfo } from 'node:net'

import ssh2, { type Client, type ClientChannel, type ConnectConfig } from 'ssh2'

import { childLogger } from '@/lib/logger'
import { normalizeHostFingerprint, type SshTunnelAuthMethod } from '@/lib/ssh-tunnels'
import type { CheckTunnel } from '@/server/monitor-types/types'
import { resolveGuardedTarget } from '@/server/security/outbound-guard'

const log = childLogger('ssh-tunnels')

// ssh2 is CommonJS; Node's ESM loader does not detect all of its named exports.
const { Client: SshClient, utils } = ssh2

/** Plaintext settings of a tunnel (credentials opened), as the worker connects with them. */
export interface SshTunnelConfig {
  id?: string | number | null
  name: string
  host: string
  port: number
  username: string
  authMethod: SshTunnelAuthMethod
  password?: string | null
  privateKey?: string | null
  passphrase?: string | null
  knownHostFingerprint: string
}

/** A tunnel could not be connected (bastion down, host key mismatch, authentication failed). */
export class SshTunnelError extends Error {
  /** Host key fingerprint the server presented, when the connection got that far. */
  readonly fingerprint: string | null
  constructor(message: string, fingerprint: string | null = null) {
    super(message)
    this.name = 'SshTunnelError'
    this.fingerprint = fingerprint
  }
}

/** Keepalive: a probe every 15 s, the connection is dropped after 3 unanswered ones. */
const KEEPALIVE_INTERVAL_MS = 15_000
const KEEPALIVE_COUNT_MAX = 3
/** Pooled connections nobody used for this long are closed. */
const IDLE_CLOSE_MS = 5 * 60_000

/** OpenSSH-style SHA-256 fingerprint of a raw host public key (`SHA256:<base64, no padding>`). */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

/** Why `key` (with `passphrase`) is not a usable private key, or `null` when it parses. */
export function privateKeyProblem(key: string, passphrase?: string | null): string | null {
  try {
    const parsed = utils.parseKey(key, passphrase || undefined)
    if (parsed instanceof Error) return parsed.message
    const first = Array.isArray(parsed) ? parsed[0] : parsed
    return first ? null : 'No key found'
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message || err.name : String(err)

/** Readable reason for an ssh2 connection error. */
function describeSshError(err: unknown): string {
  const level = (err as { level?: string } | null)?.level
  if (level === 'client-authentication') return 'authentication failed'
  if (level === 'client-timeout') return 'timed out waiting for the SSH handshake'
  return errorText(err)
}

function authOptions(config: SshTunnelConfig): Partial<ConnectConfig> {
  if (config.authMethod === 'privateKey') {
    if (!config.privateKey) throw new SshTunnelError('no private key is set')
    return {
      privateKey: config.privateKey,
      ...(config.passphrase ? { passphrase: config.passphrase } : {}),
    }
  }
  if (!config.password) throw new SshTunnelError('no password is set')
  return { password: config.password, tryKeyboard: true }
}

export interface ConnectOptions {
  timeoutMs: number
  signal?: AbortSignal
}

/**
 * Open an SSH connection to the bastion and verify its host key against the configured SHA-256
 * fingerprint before authenticating: a mismatch refuses the connection. The bastion address
 * passes the outbound address guard like every other target.
 */
export async function connectSsh(
  config: SshTunnelConfig,
  { timeoutMs, signal }: ConnectOptions,
): Promise<{ client: Client; fingerprint: string }> {
  const expected = normalizeHostFingerprint(config.knownHostFingerprint)
  if (!expected) throw new SshTunnelError('the known host fingerprint is not a SHA256 fingerprint')
  const auth = authOptions(config)
  const vetted = await resolveGuardedTarget(config.host)
  if (signal?.aborted) throw new SshTunnelError('timed out')

  const client = new SshClient()
  let presented: string | null = null
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (err: SshTunnelError | null) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (!err) {
        resolve({ client, fingerprint: presented ?? expected })
        return
      }
      client.end()
      reject(err)
    }
    const onAbort = () => finish(new SshTunnelError('timed out', presented))
    signal?.addEventListener('abort', onAbort, { once: true })

    client.on('error', (err) => {
      if (presented !== null && presented !== expected) {
        finish(
          new SshTunnelError(
            `host key mismatch: the server presented ${presented}, expected ${expected}`,
            presented,
          ),
        )
      } else {
        finish(new SshTunnelError(describeSshError(err), presented))
      }
    })
    client.once('close', () => finish(new SshTunnelError('connection closed', presented)))
    client.once('ready', () => finish(null))
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, answer) => {
      answer(prompts.map(() => config.password ?? ''))
    })
    try {
      client.connect({
        host: vetted?.address ?? config.host,
        port: config.port,
        username: config.username,
        readyTimeout: Math.max(1000, timeoutMs),
        keepaliveInterval: KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: KEEPALIVE_COUNT_MAX,
        hostVerifier: (key: Buffer) => {
          presented = hostKeyFingerprint(key)
          return presented === expected
        },
        ...auth,
      })
    } catch (err) {
      finish(new SshTunnelError(describeSshError(err), presented))
    }
  })
}

/**
 * The SHA-256 fingerprint of the host key `host:port` presents. Nothing is authenticated: the key
 * is refused as soon as it is seen. Lets an admin compare it with the bastion's own
 * (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`) before trusting it.
 */
export async function fetchHostFingerprint(
  host: string,
  port: number,
  timeoutMs = 10_000,
): Promise<string> {
  const vetted = await resolveGuardedTarget(host)
  const client = new SshClient()
  return await new Promise<string>((resolve, reject) => {
    let presented: string | null = null
    let lastError: string | null = null
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      client.end()
      if (presented) resolve(presented)
      else reject(new SshTunnelError(lastError ?? 'the server presented no host key'))
    }
    client.on('error', (err) => {
      lastError = describeSshError(err)
      finish()
    })
    client.once('close', finish)
    try {
      client.connect({
        host: vetted?.address ?? host,
        port,
        username: 'marmot',
        readyTimeout: Math.max(1000, timeoutMs),
        hostVerifier: (key: Buffer) => {
          presented = hostKeyFingerprint(key)
          return false
        },
      })
    } catch (err) {
      lastError = describeSshError(err)
      finish()
    }
  })
}

// ---- Pool ---------------------------------------------------------------------------------------

interface PoolEntry {
  signature: string
  connecting: Promise<Client>
  client: Client | null
  active: number
  lastUsed: number
}

const pool = new Map<string, PoolEntry>()
let sweeper: NodeJS.Timeout | undefined

/** Digest of everything the connection depends on: an edited tunnel gets a new connection. */
function signatureOf(config: SshTunnelConfig): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        config.host,
        config.port,
        config.username,
        config.authMethod,
        config.password ?? '',
        config.privateKey ?? '',
        config.passphrase ?? '',
        normalizeHostFingerprint(config.knownHostFingerprint),
      ]),
    )
    .digest('hex')
}

function dropEntry(key: string, entry: PoolEntry): void {
  if (pool.get(key) === entry) pool.delete(key)
  entry.client?.end()
}

function startSweeper(): void {
  if (sweeper) return
  sweeper = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of pool) {
      if (entry.client && entry.active === 0 && now - entry.lastUsed > IDLE_CLOSE_MS) {
        log.debug({ tunnel: key }, 'closing idle SSH tunnel connection')
        dropEntry(key, entry)
      }
    }
    if (pool.size === 0 && sweeper) {
      clearInterval(sweeper)
      sweeper = undefined
    }
  }, 60_000)
  sweeper.unref()
}

/** Abort-aware wait for a shared connection attempt another check started. */
function waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new SshTunnelError('timed out'))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

/**
 * The pooled connection of a tunnel (connected on first use, shared by every check through it).
 * `release()` must be called once the caller is done with it.
 */
export async function acquireSshConnection(
  config: SshTunnelConfig,
  options: ConnectOptions,
): Promise<{ client: Client; release: () => void }> {
  const key = String(config.id ?? config.name)
  const signature = signatureOf(config)
  let entry = pool.get(key)
  if (entry && entry.signature !== signature) {
    // The tunnel was edited: the old connection goes once its checks finish (ssh2 lets open
    // channels drain on `end()`).
    dropEntry(key, entry)
    entry = undefined
  }
  if (!entry) {
    const created: PoolEntry = {
      signature,
      connecting: Promise.resolve(null as unknown as Client),
      client: null,
      active: 0,
      lastUsed: Date.now(),
    }
    // Shared by every check through the tunnel: bounded by the handshake timeout, not by the
    // signal of the check that happened to start it.
    created.connecting = connectSsh(config, { timeoutMs: options.timeoutMs }).then(
      ({ client }) => {
        created.client = client
        // A dropped connection (keepalive timeout, bastion restart) leaves the pool, so the next
        // check reconnects.
        const onGone = () => {
          if (pool.get(key) === created) pool.delete(key)
        }
        client.on('close', onGone)
        client.on('error', (err) => {
          log.warn({ tunnel: key, err: describeSshError(err) }, 'SSH tunnel connection error')
          onGone()
        })
        if (pool.get(key) !== created) client.end()
        return client
      },
      (err: unknown) => {
        if (pool.get(key) === created) pool.delete(key)
        throw err
      },
    )
    pool.set(key, created)
    startSweeper()
    entry = created
  }
  const current = entry
  current.active += 1
  try {
    const client = await waitFor(current.connecting, options.signal)
    let released = false
    return {
      client,
      release: () => {
        if (released) return
        released = true
        current.active -= 1
        current.lastUsed = Date.now()
      },
    }
  } catch (err) {
    current.active -= 1
    throw err
  }
}

/** Close every pooled connection (worker shutdown, tests). */
export function closeSshConnections(): void {
  for (const [key, entry] of pool) dropEntry(key, entry)
  if (sweeper) {
    clearInterval(sweeper)
    sweeper = undefined
  }
}

// ---- Per-check session --------------------------------------------------------------------------

function forwardOut(client: Client, host: string, port: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    try {
      client.forwardOut('127.0.0.1', 0, host, port, (err, channel) =>
        err ? reject(err) : resolve(channel),
      )
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * What one check sees of a tunnel: loopback listeners that forward every accepted connection to a
 * target through the bastion, so any driver can connect to them like to a local port. The
 * listeners only exist for the duration of the check and accept loopback connections only.
 */
export class TunnelSession implements CheckTunnel {
  /** Why the bastion could not open the last forwarded connection (`host:port: reason`). */
  forwardError: string | null = null
  private readonly servers = new Map<string, Promise<net.Server>>()
  private readonly sockets = new Set<net.Socket>()
  private closed = false

  constructor(
    readonly name: string,
    private readonly client: Client,
    private readonly release: () => void,
  ) {}

  async probe(host: string, port: number): Promise<void> {
    try {
      const channel = await forwardOut(this.client, host, port)
      channel.on('error', () => undefined)
      channel.close()
    } catch (err) {
      throw new Error(`SSH tunnel ${this.name} could not reach ${host}:${port}: ${errorText(err)}`)
    }
  }

  async endpoint(host: string, port: number): Promise<{ host: string; port: number }> {
    if (this.closed) throw new Error(`SSH tunnel ${this.name} is closed`)
    const key = `${host}\n${port}`
    let server = this.servers.get(key)
    if (!server) {
      server = this.listen(host, port)
      this.servers.set(key, server)
    }
    const address = (await server).address() as AddressInfo
    return { host: '127.0.0.1', port: address.port }
  }

  private listen(host: string, port: number): Promise<net.Server> {
    const server = net.createServer((socket) => {
      this.sockets.add(socket)
      socket.on('error', () => undefined)
      socket.once('close', () => this.sockets.delete(socket))
      forwardOut(this.client, host, port).then(
        (channel) => {
          if (socket.destroyed) {
            channel.close()
            return
          }
          channel.on('error', () => socket.destroy())
          channel.once('close', () => socket.destroy())
          socket.once('close', () => channel.close())
          socket.pipe(channel).pipe(socket)
        },
        (err: unknown) => {
          this.forwardError = `${host}:${port}: ${errorText(err)}`
          socket.destroy()
        },
      )
    })
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve(server))
    })
  }

  /** Close the listeners and forwarded connections; the pooled SSH connection stays open. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const socket of this.sockets) socket.destroy()
    await Promise.all(
      [...this.servers.values()].map((pending) =>
        pending.then(
          (server) => new Promise<void>((resolve) => server.close(() => resolve())),
          () => undefined,
        ),
      ),
    )
    this.release()
  }
}
