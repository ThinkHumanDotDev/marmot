/**
 * POP3 monitor: connects to `hostname:port`, reads the `+OK` greeting, upgrades with STLS
 * (RFC 2595) according to `smtpSecurity` (shared with the SMTP and IMAP monitors: `opportunistic`,
 * `starttls`, `secure` = implicit TLS on 995, `nostarttls`) and, with `mailUsername`, logs in with
 * USER/PASS. The certificate of a TLS connection is recorded for the certificate panel and the
 * expiry notifications. Credentials are only sent over TLS unless the security mode is
 * `nostarttls`. Pure Node, no driver.
 */
import type { TLSSocket } from 'node:tls'

import type { Monitor } from '@/payload-types'

import {
  checkTlsOptions,
  judgeCertificate,
  LineSession,
  mailSecurityOf,
  openConnection,
  resolveProtocolTarget,
  type MailSecurity,
} from './protocol-session'
import { registerMonitorType } from './registry'
import { requireHostname, responseExcerpt } from './util'

export const DEFAULT_POP3_PORT = 110
export const DEFAULT_POP3S_PORT = 995
/** Longest CAPA listing read before giving up. */
const MAX_CAPA_LINES = 200

/** Default port for the security mode. */
export const pop3Port = (monitor: Pick<Monitor, 'port' | 'smtpSecurity'>): number =>
  monitor.port || (mailSecurityOf(monitor) === 'secure' ? DEFAULT_POP3S_PORT : DEFAULT_POP3_PORT)

registerMonitorType({
  name: 'pop3',
  label: 'POP3',
  group: 'specific',
  async check(ctx) {
    const { monitor } = ctx
    const security: MailSecurity = mailSecurityOf(monitor)
    const target = await resolveProtocolTarget(requireHostname(monitor), pop3Port(monitor))
    const start = Date.now()
    const { socket } = await openConnection(
      target,
      ctx.signal,
      security === 'secure' ? checkTlsOptions(target) : undefined,
    )
    const session = new LineSession(socket, ctx.signal)
    /** Send `line` and require a `+OK` answer. */
    const command = async (line: string, label = line) => {
      session.writeLine(line)
      const reply = await session.readLine()
      if (!reply.startsWith('+OK')) throw new Error(`${label} failed: ${responseExcerpt(reply)}`)
      return reply
    }
    try {
      if (security === 'secure') judgeCertificate(ctx, socket as TLSSocket, target)
      const greeting = await session.readLine()
      if (!greeting.startsWith('+OK')) {
        throw new Error(`The server refused: ${responseExcerpt(greeting)}`)
      }
      const notes: string[] = []

      if (security === 'starttls' || security === 'opportunistic') {
        session.writeLine('CAPA')
        const capabilities: string[] = []
        if ((await session.readLine()).startsWith('+OK')) {
          for (let i = 0; i < MAX_CAPA_LINES; i += 1) {
            const line = await session.readLine()
            if (line === '.') break
            capabilities.push(line.trim().split(/\s+/)[0].toUpperCase())
          }
        }
        if (capabilities.includes('STLS')) {
          await command('STLS')
          const secure = await session.startTls(checkTlsOptions(target))
          judgeCertificate(ctx, secure, target)
          notes.push('STLS')
        } else if (security === 'starttls') {
          throw new Error('The server does not offer STLS (STARTTLS)')
        }
      }

      const username = monitor.mailUsername?.trim()
      if (username) {
        if (!session.secure && security !== 'nostarttls') {
          throw new Error('Not sending credentials over an unencrypted connection (no STLS)')
        }
        const password = monitor.mailPassword ?? ''
        if (/[\r\n]/.test(username + password)) {
          throw new Error('Credentials may not contain line breaks')
        }
        await command(`USER ${username}`, 'Login')
        await command(`PASS ${password}`, 'Login')
        notes.push(`logged in as ${username}`)
      }
      session.writeLine('QUIT')

      ctx.heartbeat.ping = Date.now() - start
      ctx.heartbeat.msg = responseExcerpt([greeting, ...notes].join(', '))
      ctx.heartbeat.status = 'up'
    } finally {
      session.close()
    }
  },
})
