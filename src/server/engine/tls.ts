/**
 * TLS certificate capture for HTTPS / TLS checks.
 *
 * Ported from Uptime Kuma 2.5.5 `server/util-server.js` (`checkCertificate`, `parseCertificateInfo`,
 * `checkCertificateHostname`) — Copyright (c) 2021 Louis Lam, MIT License. See THIRD_PARTY_NOTICES.md.
 *
 * The HTTP monitor types record the certificate of the socket their request went over
 * (`captureFromSocket`); when the handshake itself is rejected (expired, self-signed, wrong host)
 * `fetchCertificate` re-connects without verification so the certificate can still be shown. The
 * result (`TlsInfo`) is stored in `monitors.certInfo`, published as the realtime `certInfo` event
 * and fed to the expiry notifications in `src/server/jobs/cert-expiry.ts`.
 */
import { X509Certificate } from 'node:crypto'
import net from 'node:net'
import tls, { type DetailedPeerCertificate, type TLSSocket } from 'node:tls'

export type CertType = 'server' | 'intermediate CA' | 'root CA' | 'self-signed'

/** One certificate of the chain; `issuerCertificate` links to the next one up (null at the top). */
export interface CertificateInfo {
  subject: Record<string, string>
  issuer: Record<string, string>
  subjectCN: string | null
  issuerCN: string | null
  /** ISO timestamps. */
  validFrom: string
  validTo: string
  /** Whole days until `validTo` (negative once expired). */
  daysRemaining: number
  fingerprint: string
  fingerprint256: string
  serialNumber: string | null
  /** Subject alternative names without the `DNS:` / `IP Address:` prefixes. */
  validFor: string[]
  certType: CertType
  issuerCertificate: CertificateInfo | null
}

export interface TlsInfo {
  /** The chain verified against the trust store (`socket.authorized`). */
  valid: boolean
  certInfo: CertificateInfo | null
  /** Whether the leaf certificate covers the requested hostname (null when it could not be checked). */
  hostnameMatch: boolean | null
  /** Verification error code/message when `valid` is false (e.g. `CERT_HAS_EXPIRED`). */
  authorizationError: string | null
  /** ISO timestamp of the capture. */
  checkedAt: string
}

const DAY_MS = 86_400_000

/** Whole days between `now` and `validTo`, truncated towards zero like dayjs' `diff(…, 'day')`. */
export function daysUntil(validTo: string | Date, now: Date = new Date()): number {
  const end = validTo instanceof Date ? validTo : new Date(validTo)
  return Math.trunc((end.getTime() - now.getTime()) / DAY_MS)
}

const asName = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === undefined || raw === null) continue
    out[key] = Array.isArray(raw) ? raw.map(String).join(', ') : String(raw)
  }
  return out
}

/**
 * Flatten Node's `getPeerCertificate(true)` result into serialisable chain entries. Walks the
 * `issuerCertificate` links until the chain ends or loops (a root CA is "signed by itself").
 */
export function parseCertificateInfo(
  info: DetailedPeerCertificate | null | undefined,
  now: Date = new Date(),
): CertificateInfo | null {
  let link: DetailedPeerCertificate | null | undefined = info
  const seen = new Set<string>()
  const entries: Omit<CertificateInfo, 'issuerCertificate'>[] = []
  let i = 0

  while (link && link.valid_from && link.valid_to) {
    const subject = asName(link.subject)
    const issuer = asName(link.issuer)
    const validFrom = new Date(link.valid_from)
    const validTo = new Date(link.valid_to)
    seen.add(link.fingerprint)

    let certType: CertType
    let next: DetailedPeerCertificate | null = null
    if (!link.issuerCertificate || seen.has(link.issuerCertificate.fingerprint)) {
      certType = i === 0 ? 'self-signed' : 'root CA'
    } else {
      certType = i === 0 ? 'server' : 'intermediate CA'
      next = link.issuerCertificate
    }

    entries.push({
      subject,
      issuer,
      subjectCN: subject.CN ?? null,
      issuerCN: issuer.CN ?? null,
      validFrom: validFrom.toISOString(),
      validTo: validTo.toISOString(),
      daysRemaining: daysUntil(validTo, now),
      fingerprint: link.fingerprint,
      fingerprint256: link.fingerprint256,
      serialNumber: link.serialNumber ?? null,
      validFor: link.subjectaltname
        ? link.subjectaltname
            .split(', ')
            .map((s) => s.replace(/^(DNS|IP Address|URI|email):/, '').trim())
            .filter(Boolean)
        : [],
      certType,
    })

    link = next
    i += 1
    if (i > 500) throw new Error('Dead loop occurred in parseCertificateInfo')
  }

  // Link the entries from the top of the chain down to the leaf.
  let chain: CertificateInfo | null = null
  for (let j = entries.length - 1; j >= 0; j -= 1) {
    chain = { ...entries[j], issuerCertificate: chain }
  }
  return chain
}

/** Leaf → root as a flat list (for the UI and the threshold checks). */
export function certificateChain(info: CertificateInfo | null | undefined): CertificateInfo[] {
  const out: CertificateInfo[] = []
  let link: CertificateInfo | null | undefined = info
  while (link && out.length <= 500) {
    out.push(link)
    link = link.issuerCertificate
  }
  return out
}

/** Does the leaf certificate (DER `raw` buffer) cover `hostname`? `null` when it cannot be told. */
export function certificateMatchesHost(
  raw: Buffer | null | undefined,
  hostname: string | null | undefined,
): boolean | null {
  if (!raw || !hostname) return null
  try {
    const cert = new X509Certificate(raw)
    const host = hostname.replace(/^\[|\]$/g, '')
    const match = net.isIP(host) ? cert.checkIP(host) : cert.checkHost(host)
    return match !== undefined
  } catch {
    return null
  }
}

const errorText = (err: unknown): string | null => {
  if (!err) return null
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    return code ? `${code}: ${err.message}` : err.message
  }
  return String(err)
}

/**
 * Read the peer certificate of a connected TLS socket (`secureConnect` has fired).
 * `hostname` is what the client asked for (SNI / URL host) and drives `hostnameMatch`.
 */
export function captureFromSocket(
  socket: TLSSocket,
  hostname?: string | null,
  now: Date = new Date(),
): TlsInfo {
  const peer = socket.getPeerCertificate(true)
  const info = peer && Object.keys(peer).length > 0 ? peer : null
  return {
    valid: socket.authorized === true,
    certInfo: parseCertificateInfo(info, now),
    hostnameMatch: certificateMatchesHost(info?.raw, hostname),
    authorizationError: socket.authorized ? null : errorText(socket.authorizationError),
    checkedAt: now.toISOString(),
  }
}

export interface FetchCertificateOptions {
  /** SNI / hostname to verify (defaults to `host` unless it is an IP address). */
  servername?: string | null
  /** Fail the handshake on an untrusted chain (default `false`: capture whatever the server presents). */
  rejectUnauthorized?: boolean
  ca?: string | null
  cert?: string | null
  key?: string | null
  signal?: AbortSignal
  timeoutMs?: number
  now?: Date
}

/**
 * Open a TLS connection to `host:port` just to read the certificate. Used as the fallback when the
 * monitored request failed during the handshake, and reusable for TCP-TLS style checks.
 */
export function fetchCertificate(
  host: string,
  port: number,
  options: FetchCertificateOptions = {},
): Promise<TlsInfo> {
  const servername = options.servername ?? (net.isIP(host) ? undefined : host)
  const timeoutMs = options.timeoutMs ?? 10_000
  return new Promise((resolve, reject) => {
    let settled = false
    const socket = tls.connect({
      host,
      port,
      servername: servername || undefined,
      rejectUnauthorized: options.rejectUnauthorized ?? false,
      ca: options.ca || undefined,
      cert: options.cert || undefined,
      key: options.key || undefined,
    })
    const onAbort = () => finish(() => reject(new Error('TLS handshake aborted')))
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      fn()
      socket.destroy()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error(`TLS handshake timed out after ${timeoutMs} ms`))),
      timeoutMs,
    )
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
    socket.once('secureConnect', () => {
      finish(() => {
        try {
          resolve(captureFromSocket(socket, servername ?? host, options.now))
        } catch (err) {
          reject(err)
        }
      })
    })
    socket.once('error', (err) => finish(() => reject(err)))
  })
}

/** Loose runtime guard for the JSON stored in `monitors.certInfo`. */
export function isTlsInfo(value: unknown): value is TlsInfo {
  return (
    !!value &&
    typeof value === 'object' &&
    'valid' in value &&
    'certInfo' in value &&
    typeof (value as { checkedAt?: unknown }).checkedAt === 'string'
  )
}

/**
 * Did the server present a different leaf certificate than the one stored? Drives the reset of the
 * "already notified" history (Uptime Kuma: `updateTlsInfo`). A first capture counts as changed.
 */
export function certificateChanged(previous: unknown, next: TlsInfo | null | undefined): boolean {
  if (!next?.certInfo) return false
  if (!isTlsInfo(previous) || !previous.certInfo) return true
  return (
    previous.certInfo.fingerprint256 !== next.certInfo.fingerprint256 ||
    previous.certInfo.validTo !== next.certInfo.validTo
  )
}
