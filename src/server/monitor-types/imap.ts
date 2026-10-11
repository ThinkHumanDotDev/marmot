/**
 * IMAP monitor: connects to `hostname:port`, reads the greeting, upgrades with STARTTLS according
 * to `smtpSecurity` (shared with the SMTP and POP3 monitors: `opportunistic`, `starttls`, `secure`
 * = implicit TLS on 993, `nostarttls`) and, with `mailUsername`, logs in. The certificate of a TLS
 * connection is recorded for the certificate panel and the expiry notifications. Credentials are
 * only sent over TLS unless the security mode is `nostarttls`. Pure Node, no driver.
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

export const DEFAULT_IMAP_PORT = 143
export const DEFAULT_IMAPS_PORT = 993

/** Default port for the security mode. */
export const imapPort = (monitor: Pick<Monitor, 'port' | 'smtpSecurity'>): number =>
  monitor.port || (mailSecurityOf(monitor) === 'secure' ? DEFAULT_IMAPS_PORT : DEFAULT_IMAP_PORT)

/** IMAP quoted string (RFC 3501 §4.3): backslash and double quote escaped. */
export function imapQuote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('Credentials may not contain line breaks')
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`
}

/** Capabilities from a `* CAPABILITY …` line or a `[CAPABILITY …]` response code. */
export function parseImapCapabilities(line: string): string[] | null {
  const match = /^\* CAPABILITY (.*)$/i.exec(line) ?? /\[CAPABILITY ([^\]]*)\]/i.exec(line)
  return match ? match[1].trim().toUpperCase().split(/\s+/) : null
}

/** Read lines until the tagged response of `tag`; returns it and the untagged lines before it. */
async function readTagged(
  session: LineSession,
  tag: string,
): Promise<{ status: string; text: string; untagged: string[] }> {
  const untagged: string[] = []
  for (;;) {
    const line = await session.readLine()
    if (line.startsWith(`${tag} `)) {
      const [, status = '', text = ''] = /^\S+ (\S+) ?(.*)$/.exec(line) ?? []
      return { status: status.toUpperCase(), text, untagged }
    }
    untagged.push(line)
  }
}

registerMonitorType({
  name: 'imap',
  label: 'IMAP',
  group: 'specific',
  async check(ctx) {
    const { monitor } = ctx
    const security: MailSecurity = mailSecurityOf(monitor)
    const target = await resolveProtocolTarget(requireHostname(monitor), imapPort(monitor))
    const start = Date.now()
    const { socket } = await openConnection(
      target,
      ctx.signal,
      security === 'secure' ? checkTlsOptions(target) : undefined,
    )
    const session = new LineSession(socket, ctx.signal)
    let counter = 0
    const command = async (text: string, label = text) => {
      const tag = `M${++counter}`
      session.writeLine(`${tag} ${text}`)
      const result = await readTagged(session, tag)
      if (result.status !== 'OK') {
        throw new Error(`${label} failed: ${responseExcerpt(`${result.status} ${result.text}`)}`)
      }
      return result
    }
    try {
      if (security === 'secure') judgeCertificate(ctx, socket as TLSSocket, target)
      const greeting = await session.readLine()
      if (/^\* BYE/i.test(greeting))
        throw new Error(`The server refused: ${responseExcerpt(greeting)}`)
      if (!/^\* (OK|PREAUTH)/i.test(greeting)) {
        throw new Error(`Unexpected IMAP greeting: ${responseExcerpt(greeting)}`)
      }
      const notes: string[] = []
      let capabilities = parseImapCapabilities(greeting)
      const loadCapabilities = async () => {
        const { untagged } = await command('CAPABILITY')
        capabilities = untagged.map(parseImapCapabilities).find(Boolean) ?? []
      }

      if (security === 'starttls' || security === 'opportunistic') {
        if (!capabilities) await loadCapabilities()
        if (capabilities?.includes('STARTTLS')) {
          await command('STARTTLS')
          const secure = await session.startTls(checkTlsOptions(target))
          judgeCertificate(ctx, secure, target)
          notes.push('STARTTLS')
          capabilities = null
        } else if (security === 'starttls') {
          throw new Error('The server does not offer STARTTLS')
        }
      }

      const username = monitor.mailUsername?.trim()
      if (username) {
        if (!session.secure && security !== 'nostarttls') {
          throw new Error('Not sending credentials over an unencrypted connection (no STARTTLS)')
        }
        if (!capabilities) await loadCapabilities()
        if (capabilities?.includes('LOGINDISABLED')) {
          throw new Error('The server does not allow LOGIN on this connection (LOGINDISABLED)')
        }
        await command(
          `LOGIN ${imapQuote(username)} ${imapQuote(monitor.mailPassword ?? '')}`,
          'Login',
        )
        notes.push(`logged in as ${username}`)
      }
      session.writeLine(`M${++counter} LOGOUT`)

      ctx.heartbeat.ping = Date.now() - start
      ctx.heartbeat.msg = responseExcerpt(
        [greeting.replace(/^\* /, '').replace(/\[[^\]]*\]\s*/, ''), ...notes]
          .filter(Boolean)
          .join(', '),
      )
      ctx.heartbeat.status = 'up'
    } finally {
      session.close()
    }
  },
})
