/**
 * SMTP monitor: opens a connection to `hostname:port` (default 25) with the configured
 * `smtpSecurity` and lets nodemailer verify the handshake (EHLO / STARTTLS); UP when it succeeds.
 * Uses `nodemailer`, which Marmot already ships for email.
 *
 * Ported from Uptime Kuma 2.5.5 `server/monitor-types/smtp.js` — Copyright (c) 2021 Louis Lam,
 * MIT License. See THIRD_PARTY_NOTICES.md.
 */
import nodemailer from 'nodemailer'

import type { Monitor } from '@/payload-types'

import { registerMonitorType } from './registry'
import { checkTimeoutMs, errorMessage, requireHostname, withAbort } from './util'

export const DEFAULT_SMTP_PORT = 25

/** nodemailer transport options for the monitor's security mode. */
export function smtpTransportOptions(
  monitor: Pick<Monitor, 'hostname' | 'port' | 'smtpSecurity' | 'ignoreTls'>,
  timeoutMs: number,
) {
  const security = monitor.smtpSecurity ?? 'opportunistic'
  return {
    host: requireHostname(monitor),
    port: monitor.port || DEFAULT_SMTP_PORT,
    // SMTPS (implicit TLS), not STARTTLS
    secure: security === 'secure',
    // Never upgrade with STARTTLS even when the server offers it
    ignoreTLS: security === 'nostarttls',
    // Upgrade with STARTTLS or fail
    requireTLS: security === 'starttls',
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    tls: { rejectUnauthorized: !monitor.ignoreTls },
  }
}

registerMonitorType({
  name: 'smtp',
  label: 'SMTP',
  group: 'specific',
  async check(ctx) {
    const transporter = nodemailer.createTransport(
      smtpTransportOptions(ctx.monitor, checkTimeoutMs(ctx.monitor)),
    )
    const startTime = Date.now()
    try {
      await withAbort(transporter.verify(), ctx.signal, () => transporter.close())
    } catch (err) {
      throw new Error(`SMTP connection doesn't verify: ${errorMessage(err)}`)
    } finally {
      transporter.close()
    }
    ctx.heartbeat.ping = Date.now() - startTime
    ctx.heartbeat.msg = 'SMTP connection verifies successfully'
    ctx.heartbeat.status = 'up'
  },
})
