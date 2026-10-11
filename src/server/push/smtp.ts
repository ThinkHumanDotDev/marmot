/**
 * Inbound SMTP listener for ping-by-email (#135), run by the worker when `INBOUND_SMTP_PORT` and
 * `INBOUND_EMAIL_DOMAIN` are set. A receive-only MX for the inbound domain built on `smtp-server`:
 *
 * - no AUTH, no relaying: `RCPT TO` must be `<token>@INBOUND_EMAIL_DOMAIN` of an active push
 *   monitor, anything else is refused with 550 before the message is sent;
 * - `SIZE` is announced and enforced (`INBOUND_EMAIL_MAX_BYTES`): a larger message is refused with
 *   552 and nothing is parsed;
 * - a message that cannot be parsed or applied is refused with 451, and the listener keeps
 *   serving; connection errors are logged, never thrown.
 *
 * Plain SMTP on the port you choose: put it behind your MX (port 25) or a TLS-terminating relay.
 */
import { SMTPServer, type SMTPServerOptions } from 'smtp-server'
import type { Payload } from 'payload'

import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import { findPushMonitorByAddress, ingestPushEmail, parseRawEmail } from './email'
import { inboundEmailDomain } from './inbound-config'

const log = childLogger('push-email:smtp')

const smtpError = (message: string, responseCode: number) =>
  Object.assign(new Error(message), { responseCode })

export interface InboundSmtpOptions {
  port?: number
  host?: string
  maxBytes?: number
}

export interface InboundSmtpListener {
  server: SMTPServer
  /** The bound port (useful with `port: 0`). */
  port: number
  close(): Promise<void>
}

/** Start the listener. Resolves once it accepts connections. */
export async function startInboundSmtp(
  payload: Payload,
  options: InboundSmtpOptions = {},
): Promise<InboundSmtpListener> {
  const maxBytes = options.maxBytes ?? env.INBOUND_EMAIL_MAX_BYTES
  const config: SMTPServerOptions = {
    name: inboundEmailDomain() ?? undefined,
    banner: 'Marmot ping-by-email',
    authOptional: true,
    disabledCommands: ['AUTH', 'STARTTLS'],
    size: maxBytes,
    logger: false,
    // Never wait on reverse DNS for a banner nobody reads.
    disableReverseLookup: true,
    socketTimeout: 60_000,
    // A receive-only endpoint for job reports: plenty, and bounded.
    maxClients: 100,
    onRcptTo(address, _session, callback) {
      findPushMonitorByAddress(payload, address.address)
        .then((monitor) =>
          monitor ? callback() : callback(smtpError('5.1.1 Unknown recipient', 550)),
        )
        .catch((err: unknown) => {
          log.error({ err }, 'recipient lookup failed')
          callback(smtpError('4.3.0 Temporary failure, try again later', 451))
        })
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => {
        // smtp-server stops counting toward `sizeExceeded` but keeps streaming: do not buffer it.
        if (!stream.sizeExceeded) chunks.push(chunk)
      })
      stream.on('error', (err) => {
        log.warn({ err }, 'inbound message stream failed')
        callback(smtpError('4.3.0 Temporary failure, try again later', 451))
      })
      stream.on('end', () => {
        if (stream.sizeExceeded) {
          log.info({ limit: maxBytes }, 'inbound message over the size limit refused')
          callback(smtpError(`5.3.4 Message exceeds the ${maxBytes} byte limit`, 552))
          return
        }
        const envelope = session.envelope.rcptTo.map((rcpt) => rcpt.address)
        parseRawEmail(Buffer.concat(chunks), envelope)
          .then((mail) => ingestPushEmail(payload, mail))
          .then((outcomes) => {
            log.debug({ outcomes }, 'inbound message applied')
            callback()
          })
          .catch((err: unknown) => {
            log.error({ err }, 'cannot apply inbound message')
            callback(smtpError('4.3.0 Temporary failure, try again later', 451))
          })
      })
    },
  }

  const server = new SMTPServer(config)
  server.on('error', (err) => log.warn({ err }, 'inbound SMTP connection error'))

  const host = options.host ?? env.INBOUND_SMTP_HOST
  const port = await new Promise<number>((resolve, reject) => {
    const onError = (err: Error) => reject(err)
    server.server.once('error', onError)
    server.listen(options.port ?? env.INBOUND_SMTP_PORT, host, () => {
      server.server.off('error', onError)
      const address = server.server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
  log.info({ host, port, domain: inboundEmailDomain(), maxBytes }, 'inbound SMTP listener ready')

  return {
    server,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
