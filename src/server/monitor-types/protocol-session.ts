/**
 * Helpers shared by the line-based protocol monitors (IMAP, POP3) and the TLS handshake monitor:
 * open a TCP or TLS connection through the outbound address guard, read CRLF-terminated lines,
 * upgrade a plain connection with STARTTLS, and judge the certificate the server presented.
 */
import net from 'node:net'
import { performance } from 'node:perf_hooks'
import tls, { type TLSSocket } from 'node:tls'

import { captureFromSocket, type TlsInfo } from '@/server/engine/tls'
import { resolveGuardedTarget } from '@/server/security/outbound-guard'

import type { MonitorCheckContext } from './types'

/**
 * How a mail monitor (SMTP, IMAP, POP3) secures its connection (`monitors.smtpSecurity`):
 * STARTTLS when offered, STARTTLS or fail, implicit TLS, or plain text only.
 */
export type MailSecurity = 'opportunistic' | 'starttls' | 'secure' | 'nostarttls'

export const mailSecurityOf = (monitor: { smtpSecurity?: MailSecurity | null }): MailSecurity =>
  monitor.smtpSecurity ?? 'opportunistic'

/** Longest line a server may send before the check gives up (protects the worker's memory). */
export const MAX_LINE_BYTES = 64 * 1024

/** Where to connect: the vetted address (when the guard is on) and the name to verify TLS against. */
export interface ProtocolTarget {
  /** Address or name the socket connects to. */
  address: string
  port: number
  /** Hostname as configured (brackets of an IPv6 literal removed). */
  host: string
  /** SNI to send: the configured server name, else the hostname unless it is an IP literal. */
  servername: string | undefined
  /** Time spent resolving and vetting the hostname (ms), null for an IP literal or with the guard off. */
  dnsMs: number | null
}

/** Resolve `hostname` through the outbound guard. */
export async function resolveProtocolTarget(
  hostname: string,
  port: number,
  servername?: string | null,
): Promise<ProtocolTarget> {
  const host = hostname.replace(/^\[|\]$/g, '')
  const start = performance.now()
  const vetted = await resolveGuardedTarget(host)
  const dnsMs = vetted && !net.isIP(host) ? performance.now() - start : null
  return {
    address: vetted?.address ?? host,
    port,
    host,
    servername: servername?.trim() || (net.isIP(host) ? undefined : host),
    dnsMs,
  }
}

/** Node TLS options for a check: never reject during the handshake, judge the result afterwards. */
export function checkTlsOptions(
  target: ProtocolTarget,
  extra: Partial<tls.ConnectionOptions> = {},
): tls.ConnectionOptions {
  return {
    // Verified against the configured name (or the IP literal) even when connecting to the vetted address.
    host: target.host,
    servername: target.servername,
    rejectUnauthorized: false,
    ...extra,
  }
}

/**
 * Record the certificate of `socket` on the check context (`ctx.tlsInfo`, stored in
 * `monitors.certInfo` and fed to the expiry notifications), then fail the check when the chain or
 * the hostname is not trusted, unless the monitor ignores TLS errors.
 */
export function judgeCertificate(
  ctx: MonitorCheckContext,
  socket: TLSSocket,
  target: ProtocolTarget,
): TlsInfo | null {
  let info: TlsInfo | null = null
  try {
    info = captureFromSocket(socket, target.servername ?? target.host)
    ctx.tlsInfo = info
  } catch {
    // Certificate capture must never fail the check itself.
  }
  if (!ctx.monitor.ignoreTls && !socket.authorized) {
    throw new Error(
      `TLS certificate is not trusted: ${describeTlsError(socket.authorizationError)}`,
    )
  }
  return info
}

/** Readable wording for the verification errors servers commonly cause. */
const TLS_ERROR_TEXT: Record<string, string> = {
  DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed certificate',
  SELF_SIGNED_CERT_IN_CHAIN: 'self-signed certificate in the chain',
  CERT_HAS_EXPIRED: 'the certificate has expired',
  CERT_NOT_YET_VALID: 'the certificate is not yet valid',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'unable to verify the first certificate (incomplete chain?)',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'unknown issuer',
  ERR_TLS_CERT_ALTNAME_INVALID: 'the certificate does not cover the hostname',
}

/** `socket.authorizationError` (an error code, or an Error) as `wording (CODE)`. */
export function describeTlsError(raw: unknown): string {
  if (!raw) return 'unknown reason'
  const code =
    raw instanceof Error ? ((raw as NodeJS.ErrnoException).code ?? raw.message) : String(raw)
  const text = TLS_ERROR_TEXT[code]
  return text ? `${text} (${code})` : code
}

/** Phases of opening a connection (ms). */
export interface ConnectTiming {
  connect: number
  tls: number | null
}

/**
 * Connect to `target`, over TLS when `tlsOptions` is given. Resolves once the connection (and the
 * TLS handshake) is established; the socket is destroyed when `signal` aborts.
 */
export function openConnection(
  target: ProtocolTarget,
  signal: AbortSignal,
  tlsOptions?: tls.ConnectionOptions,
): Promise<{ socket: net.Socket; timing: ConnectTiming }> {
  return new Promise((resolve, reject) => {
    const start = performance.now()
    let connectedAt: number | null = null
    const socket: net.Socket = tlsOptions
      ? tls.connect({ ...tlsOptions, port: target.port, host: target.address })
      : net.connect({ port: target.port, host: target.address })
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
      socket.removeListener('error', onError)
    }
    const onAbort = () => {
      cleanup()
      socket.destroy()
      reject(abortError())
    }
    const onError = (err: Error) => {
      cleanup()
      socket.destroy()
      reject(new Error(`Connection failed: ${err.message}`))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    socket.once('error', onError)
    socket.once('connect', () => (connectedAt = performance.now()))
    socket.once(tlsOptions ? 'secureConnect' : 'connect', () => {
      cleanup()
      const end = performance.now()
      resolve({
        socket,
        timing: {
          connect: (connectedAt ?? end) - start,
          tls: tlsOptions ? end - (connectedAt ?? start) : null,
        },
      })
    })
  })
}

function abortError(): Error {
  const err = new Error('timeout by AbortSignal')
  err.name = 'TimeoutError'
  return err
}

/**
 * CRLF line reader/writer over a socket that can be upgraded to TLS mid-session (STARTTLS).
 * Every read rejects when the connection closes, errors or `signal` aborts.
 */
export class LineSession {
  private socket: net.Socket
  private buffer = ''
  private failure: Error | null = null
  private waiter: { resolve: (line: string) => void; reject: (err: Error) => void } | null = null
  private readonly onData = (chunk: Buffer) => {
    this.buffer += chunk.toString('utf8')
    if (this.buffer.length > MAX_LINE_BYTES && !this.buffer.includes('\n')) {
      this.fail(new Error('The server sent an overlong line'))
      return
    }
    this.flush()
  }
  private readonly onError = (err: Error) =>
    this.fail(new Error(`Connection error: ${err.message}`))
  private readonly onClose = () => this.fail(new Error('The server closed the connection'))
  private readonly onAbort = () => {
    this.fail(abortError())
    this.socket.destroy()
  }

  constructor(
    socket: net.Socket,
    private readonly signal: AbortSignal,
  ) {
    this.socket = socket
    this.attach()
    signal.addEventListener('abort', this.onAbort, { once: true })
  }

  /** Whether the session currently runs over TLS. */
  get secure(): boolean {
    return this.socket instanceof tls.TLSSocket
  }

  private attach() {
    this.socket.on('data', this.onData)
    this.socket.on('error', this.onError)
    this.socket.on('close', this.onClose)
  }

  private detach() {
    this.socket.removeListener('data', this.onData)
    this.socket.removeListener('error', this.onError)
    this.socket.removeListener('close', this.onClose)
  }

  private fail(err: Error) {
    this.failure ??= err
    const waiter = this.waiter
    this.waiter = null
    waiter?.reject(this.failure)
  }

  private flush() {
    if (!this.waiter) return
    const index = this.buffer.indexOf('\n')
    if (index === -1) return
    const line = this.buffer.slice(0, index).replace(/\r$/, '')
    this.buffer = this.buffer.slice(index + 1)
    const waiter = this.waiter
    this.waiter = null
    waiter.resolve(line)
  }

  /** Next line without its line ending. */
  readLine(): Promise<string> {
    if (this.waiter) return Promise.reject(new Error('Concurrent reads are not supported'))
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject }
      this.flush()
      if (this.waiter && this.failure) this.fail(this.failure)
    })
  }

  /** Send `line` followed by CRLF. */
  writeLine(line: string): void {
    this.socket.write(`${line}\r\n`)
  }

  /** Upgrade the connection to TLS (after the server accepted STARTTLS / STLS). */
  async startTls(options: tls.ConnectionOptions): Promise<TLSSocket> {
    if (this.buffer.length > 0) {
      throw new Error('The server sent data before the TLS handshake (possible injection)')
    }
    this.detach()
    const plain = this.socket
    const secure = await new Promise<TLSSocket>((resolve, reject) => {
      const socket = tls.connect({ ...options, socket: plain })
      const onError = (err: Error) => {
        this.signal.removeEventListener('abort', onAbort)
        reject(new Error(`TLS handshake failed: ${err.message}`))
      }
      const onAbort = () => {
        socket.destroy()
        reject(abortError())
      }
      this.signal.addEventListener('abort', onAbort, { once: true })
      socket.once('error', onError)
      socket.once('secureConnect', () => {
        this.signal.removeEventListener('abort', onAbort)
        socket.removeListener('error', onError)
        resolve(socket)
      })
    })
    this.socket = secure
    this.attach()
    return secure
  }

  /** Close the connection (best effort, never throws). */
  close(): void {
    this.signal.removeEventListener('abort', this.onAbort)
    this.detach()
    this.socket.on('error', () => undefined)
    this.socket.destroy()
  }
}
