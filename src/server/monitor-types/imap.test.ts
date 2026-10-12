import { X509Certificate } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Monitor } from '@/payload-types'

import { imapPort, imapQuote, parseImapCapabilities } from './imap'
import { getMonitorType } from './registry'
import {
  closedTcpPort,
  makeContext,
  makeMonitor,
  startLineServer,
  tlsFixture,
  type LineConnection,
} from './test-helpers'
import './index'

const fixture = new X509Certificate(tlsFixture().cert)

/** LOGIN lines the servers received, with whether the connection was encrypted. */
const logins: { line: string; secure: boolean }[] = []

/** Minimal IMAP4rev1: CAPABILITY, STARTTLS (when offered), LOGIN bob/"se\"cret", LOGOUT. */
function imapServer(options: { starttls: boolean; implicitTls?: boolean }) {
  const capabilities = (conn: LineConnection) =>
    ['IMAP4rev1', ...(options.starttls && !conn.secure ? ['STARTTLS', 'LOGINDISABLED'] : [])].join(
      ' ',
    )
  return startLineServer({
    implicitTls: options.implicitTls,
    // The STARTTLS server announces its capabilities in the greeting, the others on request.
    onConnect: (conn) =>
      conn.send(
        options.starttls
          ? `* OK [CAPABILITY ${capabilities(conn)}] Marmot IMAP ready`
          : '* OK Marmot IMAP ready',
      ),
    onLine: (conn, line) => {
      const [tag, command = ''] = line.split(' ')
      switch (command.toUpperCase()) {
        case 'CAPABILITY':
          conn.send(`* CAPABILITY ${capabilities(conn)}`)
          conn.send(`${tag} OK CAPABILITY completed`)
          break
        case 'STARTTLS':
          conn.send(`${tag} OK Begin TLS negotiation now`)
          conn.startTls()
          break
        case 'LOGIN':
          logins.push({ line, secure: conn.secure })
          if (line === `${tag} LOGIN "bob" "se\\"cret"`) conn.send(`${tag} OK LOGIN completed`)
          else conn.send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`)
          break
        case 'LOGOUT':
          conn.send('* BYE Logging out')
          conn.send(`${tag} OK LOGOUT completed`)
          conn.close()
          break
        default:
          conn.send(`${tag} BAD Unknown command`)
      }
    },
  })
}

let starttlsServer: Awaited<ReturnType<typeof imapServer>>
let plainServer: Awaited<ReturnType<typeof imapServer>>
let implicitServer: Awaited<ReturnType<typeof imapServer>>

beforeAll(async () => {
  starttlsServer = await imapServer({ starttls: true })
  plainServer = await imapServer({ starttls: false })
  implicitServer = await imapServer({ starttls: false, implicitTls: true })
})

afterAll(async () => {
  await Promise.all([starttlsServer.close(), plainServer.close(), implicitServer.close()])
})

const imapMonitor = (over: Partial<Monitor>) =>
  makeMonitor({ type: 'imap', hostname: '127.0.0.1', timeout: 5, ignoreTls: true, ...over })

async function check(monitor: Monitor) {
  const ctx = makeContext(monitor)
  const error = await getMonitorType('imap')!
    .check(ctx)
    .then(() => null)
    .catch((err: Error) => err)
  return { ctx, error }
}

describe('imap helpers', () => {
  it('quotes credentials and parses capabilities', () => {
    expect(imapQuote('a"b\\c')).toBe('"a\\"b\\\\c"')
    expect(() => imapQuote('a\r\nb')).toThrow(/line breaks/)
    expect(parseImapCapabilities('* OK [CAPABILITY IMAP4rev1 starttls] hi')).toEqual([
      'IMAP4REV1',
      'STARTTLS',
    ])
    expect(parseImapCapabilities('* CAPABILITY IMAP4rev1 AUTH=PLAIN')).toEqual([
      'IMAP4REV1',
      'AUTH=PLAIN',
    ])
    expect(parseImapCapabilities('* OK ready')).toBeNull()
  })

  it('picks the well-known port for the security mode', () => {
    expect(imapPort({ port: null, smtpSecurity: 'secure' })).toBe(993)
    expect(imapPort({ port: null, smtpSecurity: 'starttls' })).toBe(143)
    expect(imapPort({ port: 1143, smtpSecurity: 'secure' })).toBe(1143)
  })
})

describe('imap monitor', () => {
  it('upgrades with STARTTLS, records the certificate and logs in over TLS', async () => {
    logins.length = 0
    const { ctx, error } = await check(
      imapMonitor({
        port: starttlsServer.port,
        smtpSecurity: 'starttls',
        mailUsername: 'bob',
        mailPassword: 'se"cret',
      }),
    )
    expect(error).toBeNull()
    expect(ctx.heartbeat.status).toBe('up')
    expect(ctx.heartbeat.msg).toBe('OK Marmot IMAP ready, STARTTLS, logged in as bob')
    expect(ctx.tlsInfo?.certInfo?.fingerprint256).toBe(fixture.fingerprint256)
    expect(logins).toEqual([{ line: 'M3 LOGIN "bob" "se\\"cret"', secure: true }])
  })

  it('is DOWN on an untrusted certificate unless TLS errors are ignored', async () => {
    const { ctx, error } = await check(
      imapMonitor({ port: starttlsServer.port, smtpSecurity: 'starttls', ignoreTls: false }),
    )
    expect(error?.message).toMatch(/^TLS certificate is not trusted: self-signed certificate/)
    expect(ctx.tlsInfo?.valid).toBe(false)
  })

  it('connects with implicit TLS', async () => {
    const { ctx, error } = await check(
      imapMonitor({ port: implicitServer.port, smtpSecurity: 'secure' }),
    )
    expect(error).toBeNull()
    expect(ctx.heartbeat.msg).toBe('OK Marmot IMAP ready')
    expect(ctx.tlsInfo?.certInfo?.subjectCN).toBe('localhost')
  })

  it('reports a failed login', async () => {
    const { error } = await check(
      imapMonitor({
        port: starttlsServer.port,
        smtpSecurity: 'opportunistic',
        mailUsername: 'bob',
        mailPassword: 'wrong',
      }),
    )
    expect(error?.message).toBe('Login failed: NO [AUTHENTICATIONFAILED] Invalid credentials')
  })

  it('requires STARTTLS when asked to, and never sends credentials in clear text', async () => {
    const required = await check(imapMonitor({ port: plainServer.port, smtpSecurity: 'starttls' }))
    expect(required.error?.message).toBe('The server does not offer STARTTLS')

    logins.length = 0
    const opportunistic = await check(
      imapMonitor({
        port: plainServer.port,
        smtpSecurity: 'opportunistic',
        mailUsername: 'bob',
        mailPassword: 'se"cret',
      }),
    )
    expect(opportunistic.error?.message).toMatch(/^Not sending credentials/)
    expect(logins).toEqual([])

    // Explicitly plain text: the greeting alone is enough without credentials.
    const plain = await check(imapMonitor({ port: plainServer.port, smtpSecurity: 'nostarttls' }))
    expect(plain.error).toBeNull()
    expect(plain.ctx.tlsInfo ?? null).toBeNull()
  })

  it('fails with a readable message when nothing listens', async () => {
    const port = await closedTcpPort()
    const { error } = await check(imapMonitor({ port, smtpSecurity: 'nostarttls' }))
    expect(error?.message).toMatch(/^Connection failed: .*ECONNREFUSED/)
  })
})
