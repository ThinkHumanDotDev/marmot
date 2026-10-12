import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Monitor } from '@/payload-types'

import { pop3Port } from './pop3'
import { getMonitorType } from './registry'
import { closedTcpPort, makeContext, makeMonitor, startLineServer } from './test-helpers'
import './index'

/** Commands the servers received, with whether the connection was encrypted. */
const received: { line: string; secure: boolean }[] = []

/** Minimal POP3 (RFC 1939 / 2449 / 2595): CAPA, STLS when offered, USER bob / PASS secret, QUIT. */
function pop3Server(options: { stls: boolean; implicitTls?: boolean; greeting?: string }) {
  return startLineServer({
    implicitTls: options.implicitTls,
    onConnect: (conn) => conn.send(options.greeting ?? '+OK Marmot POP3 ready'),
    onLine: (conn, line) => {
      received.push({ line, secure: conn.secure })
      const [command, arg] = line.split(' ')
      switch (command.toUpperCase()) {
        case 'CAPA':
          conn.send('+OK Capability list follows')
          conn.send('USER')
          if (options.stls && !conn.secure) conn.send('STLS')
          conn.send('.')
          break
        case 'STLS':
          conn.send('+OK Begin TLS negotiation')
          conn.startTls()
          break
        case 'USER':
          conn.send('+OK')
          break
        case 'PASS':
          conn.send(arg === 'secret' ? '+OK Logged in' : '-ERR [AUTH] Authentication failed')
          break
        case 'QUIT':
          conn.send('+OK Bye')
          conn.close()
          break
        default:
          conn.send('-ERR Unknown command')
      }
    },
  })
}

let stlsServer: Awaited<ReturnType<typeof pop3Server>>
let plainServer: Awaited<ReturnType<typeof pop3Server>>
let implicitServer: Awaited<ReturnType<typeof pop3Server>>
let busyServer: Awaited<ReturnType<typeof pop3Server>>

beforeAll(async () => {
  stlsServer = await pop3Server({ stls: true })
  plainServer = await pop3Server({ stls: false })
  implicitServer = await pop3Server({ stls: false, implicitTls: true })
  busyServer = await pop3Server({ stls: false, greeting: '-ERR Too many connections' })
})

afterAll(async () => {
  await Promise.all(
    [stlsServer, plainServer, implicitServer, busyServer].map((server) => server.close()),
  )
})

const pop3Monitor = (over: Partial<Monitor>) =>
  makeMonitor({ type: 'pop3', hostname: '127.0.0.1', timeout: 5, ignoreTls: true, ...over })

async function check(monitor: Monitor) {
  const ctx = makeContext(monitor)
  const error = await getMonitorType('pop3')!
    .check(ctx)
    .then(() => null)
    .catch((err: Error) => err)
  return { ctx, error }
}

describe('pop3 monitor', () => {
  it('picks the well-known port for the security mode', () => {
    expect(pop3Port({ port: null, smtpSecurity: 'secure' })).toBe(995)
    expect(pop3Port({ port: null, smtpSecurity: null })).toBe(110)
  })

  it('upgrades with STLS, records the certificate and logs in over TLS', async () => {
    received.length = 0
    const { ctx, error } = await check(
      pop3Monitor({
        port: stlsServer.port,
        smtpSecurity: 'starttls',
        mailUsername: 'bob',
        mailPassword: 'secret',
      }),
    )
    expect(error).toBeNull()
    expect(ctx.heartbeat.status).toBe('up')
    expect(ctx.heartbeat.msg).toBe('+OK Marmot POP3 ready, STLS, logged in as bob')
    expect(ctx.tlsInfo?.certInfo?.subjectCN).toBe('localhost')
    expect(received.filter((r) => /^(USER|PASS)/.test(r.line))).toEqual([
      { line: 'USER bob', secure: true },
      { line: 'PASS secret', secure: true },
    ])
  })

  it('is DOWN on an untrusted certificate unless TLS errors are ignored', async () => {
    const { ctx, error } = await check(
      pop3Monitor({ port: implicitServer.port, smtpSecurity: 'secure', ignoreTls: false }),
    )
    expect(error?.message).toMatch(/^TLS certificate is not trusted: self-signed certificate/)
    expect(ctx.tlsInfo?.certInfo?.subjectCN).toBe('localhost')
  })

  it('connects with implicit TLS', async () => {
    const { ctx, error } = await check(
      pop3Monitor({ port: implicitServer.port, smtpSecurity: 'secure' }),
    )
    expect(error).toBeNull()
    expect(ctx.heartbeat.msg).toBe('+OK Marmot POP3 ready')
    expect(ctx.tlsInfo?.valid).toBe(false)
  })

  it('reports a failed login', async () => {
    const { error } = await check(
      pop3Monitor({
        port: stlsServer.port,
        mailUsername: 'bob',
        mailPassword: 'wrong',
      }),
    )
    expect(error?.message).toBe('Login failed: -ERR [AUTH] Authentication failed')
  })

  it('requires STLS when asked to, and never sends credentials in clear text', async () => {
    const required = await check(pop3Monitor({ port: plainServer.port, smtpSecurity: 'starttls' }))
    expect(required.error?.message).toBe('The server does not offer STLS (STARTTLS)')

    received.length = 0
    const opportunistic = await check(
      pop3Monitor({ port: plainServer.port, mailUsername: 'bob', mailPassword: 'secret' }),
    )
    expect(opportunistic.error?.message).toMatch(/^Not sending credentials/)
    expect(received.map((r) => r.line)).toEqual(['CAPA'])
  })

  it('is DOWN when the server refuses the session', async () => {
    const { error } = await check(pop3Monitor({ port: busyServer.port }))
    expect(error?.message).toBe('The server refused: -ERR Too many connections')
  })

  it('fails with a readable message when nothing listens', async () => {
    const port = await closedTcpPort()
    const { error } = await check(pop3Monitor({ port }))
    expect(error?.message).toMatch(/^Connection failed: .*ECONNREFUSED/)
  })
})
