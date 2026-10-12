import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Monitor } from '@/payload-types'

import { closedTcpPort, makeContext, makeMonitor } from './test-helpers'
import { getMonitorType } from './registry'
import { parseAlpnProtocols } from './tls'
import './index'

const FIXTURES = path.join(process.cwd(), 'tests/fixtures/tls')
const cert = readFileSync(path.join(FIXTURES, 'localhost.crt'), 'utf8')
const key = readFileSync(path.join(FIXTURES, 'localhost.key'), 'utf8')
const fixture = new X509Certificate(cert)

/** TLS server offering h2 and http/1.1 over ALPN; remembers the SNI of each handshake. */
let server: tls.Server
let port: number
const servernames: string[] = []

beforeAll(async () => {
  server = tls.createServer(
    {
      cert,
      key,
      ALPNProtocols: ['h2', 'http/1.1'],
      // Called with the client's SNI during the handshake; undefined keeps the default context.
      SNICallback: (servername, done) => {
        servernames.push(servername)
        done(null, undefined)
      },
    },
    (socket) => socket.end(),
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const tlsMonitor = (over: Partial<Monitor> = {}) =>
  makeMonitor({ type: 'tls', hostname: '127.0.0.1', port, timeout: 5, ...over })

async function check(monitor: Monitor) {
  const ctx = makeContext(monitor)
  const error = await getMonitorType('tls')!
    .check(ctx)
    .then(() => null)
    .catch((err: Error) => err)
  return { ctx, error }
}

describe('tls monitor', () => {
  it('parses the ALPN list', () => {
    expect(parseAlpnProtocols(' h2, http/1.1 ,,')).toEqual(['h2', 'http/1.1'])
    expect(parseAlpnProtocols(null)).toEqual([])
  })

  it('is DOWN on an untrusted certificate but still records it', async () => {
    const { ctx, error } = await check(tlsMonitor())
    expect(error?.message).toMatch(
      /^TLS certificate is not trusted: self-signed certificate \(DEPTH_ZERO_SELF_SIGNED_CERT\)$/,
    )
    expect(ctx.tlsInfo?.valid).toBe(false)
    expect(ctx.tlsInfo?.hostnameMatch).toBe(true)
    expect(ctx.tlsInfo?.certInfo?.fingerprint256).toBe(fixture.fingerprint256)
  })

  it('is UP with ignoreTls, reports the negotiated ALPN and records timing', async () => {
    const { ctx, error } = await check(tlsMonitor({ ignoreTls: true, tlsAlpn: 'h2, http/1.1' }))
    expect(error).toBeNull()
    expect(ctx.heartbeat.status).toBe('up')
    expect(ctx.heartbeat.msg).toMatch(/^TLSv1\.[23], ALPN h2, localhost valid for \d+ days$/)
    expect(ctx.tlsInfo?.certInfo?.subjectCN).toBe('localhost')
    expect(ctx.timing).toMatchObject({ dns: null, ttfb: null, transfer: null })
    expect(typeof ctx.timing?.connect).toBe('number')
    expect(typeof ctx.timing?.tls).toBe('number')
  })

  it('sends the configured server name as SNI', async () => {
    servernames.length = 0
    const { error } = await check(
      tlsMonitor({ ignoreTls: true, tlsServername: 'ldap.example.test' }),
    )
    expect(error).toBeNull()
    expect(servernames).toEqual(['ldap.example.test'])
  })

  it('fails when the server selects none of the offered ALPN protocols', async () => {
    const { error } = await check(tlsMonitor({ ignoreTls: true, tlsAlpn: 'imap' }))
    expect(error?.message).toMatch(/ALPN|no application protocol/i)
  })

  it('fails with a readable message when nothing listens', async () => {
    const closed = await closedTcpPort()
    const { error, ctx } = await check(tlsMonitor({ port: closed, ignoreTls: true }))
    expect(error?.message).toMatch(/^Connection failed: .*ECONNREFUSED/)
    expect(ctx.tlsInfo ?? null).toBeNull()
  })
})
