/**
 * TLS handshake monitor: opens a TLS connection to `hostname:port` (default 443), optionally with
 * a different SNI (`tlsServername`) and ALPN protocols (`tlsAlpn`), and records the certificate
 * (`ctx.tlsInfo`), which feeds the certificate panel and the expiry notifications. UP when the
 * handshake completes with a trusted certificate (or any certificate with `ignoreTls`) and, when
 * ALPN protocols are offered, the server selected one of them. For non-HTTP TLS services such as
 * LDAPS, IMAPS or a TLS-terminating proxy.
 */
import type { TLSSocket } from 'node:tls'

import { roundPhase } from '@/lib/request-timing'

import {
  checkTlsOptions,
  judgeCertificate,
  openConnection,
  resolveProtocolTarget,
} from './protocol-session'
import { registerMonitorType } from './registry'
import { requireHostname } from './util'

export const DEFAULT_TLS_PORT = 443

/** `h2, http/1.1` → `['h2', 'http/1.1']` (blanks dropped). */
export function parseAlpnProtocols(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean)
}

registerMonitorType({
  name: 'tls',
  label: 'TLS Handshake',
  group: 'specific',
  async check(ctx) {
    const hostname = requireHostname(ctx.monitor)
    const alpn = parseAlpnProtocols(ctx.monitor.tlsAlpn)
    const target = await resolveProtocolTarget(
      hostname,
      ctx.monitor.port || DEFAULT_TLS_PORT,
      ctx.monitor.tlsServername,
    )
    const { socket, timing } = await openConnection(
      target,
      ctx.signal,
      checkTlsOptions(target, alpn.length > 0 ? { ALPNProtocols: alpn } : {}),
    )
    const tlsSocket = socket as TLSSocket
    try {
      const info = judgeCertificate(ctx, tlsSocket, target)
      const negotiated = tlsSocket.alpnProtocol || null
      if (alpn.length > 0 && !negotiated) {
        throw new Error(
          `The server did not select any of the offered ALPN protocols (${alpn.join(', ')})`,
        )
      }
      const ms = Math.round((target.dnsMs ?? 0) + timing.connect + (timing.tls ?? 0))
      const parts = [tlsSocket.getProtocol() ?? 'TLS']
      if (negotiated) parts.push(`ALPN ${negotiated}`)
      const cert = info?.certInfo
      if (cert) {
        parts.push(`${cert.subjectCN ?? 'certificate'} valid for ${cert.daysRemaining} days`)
      }
      ctx.heartbeat.ping = ms
      ctx.heartbeat.msg = parts.join(', ')
      ctx.heartbeat.status = 'up'
      ctx.timing = {
        dns: target.dnsMs === null ? null : roundPhase(target.dnsMs),
        connect: roundPhase(timing.connect),
        tls: timing.tls === null ? null : roundPhase(timing.tls),
        ttfb: null,
        transfer: null,
      }
    } finally {
      tlsSocket.destroy()
    }
  },
})
