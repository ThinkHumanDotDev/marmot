import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import type { DetailedPeerCertificate } from 'node:tls'
import { request } from 'undici'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Monitor } from '@/payload-types'
import {
  capturingAgent,
  isTlsHandshakeError,
  performHttpCheck,
  type TlsCapture,
} from '@/server/monitor-types/http-request'
import type { MonitorCheckContext } from '@/server/monitor-types/types'
import {
  certificateChain,
  certificateChanged,
  certificateMatchesHost,
  daysUntil,
  fetchCertificate,
  isTlsInfo,
  parseCertificateInfo,
  type TlsInfo,
} from './tls'

const FIXTURES = path.join(process.cwd(), 'tests/fixtures/tls')
const cert = readFileSync(path.join(FIXTURES, 'localhost.crt'), 'utf8')
const key = readFileSync(path.join(FIXTURES, 'localhost.key'), 'utf8')
const fixture = new X509Certificate(cert)

let server: https.Server
let port: number

beforeAll(async () => {
  server = https.createServer({ cert, key }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

describe('daysUntil', () => {
  const now = new Date('2026-10-05T12:00:00Z')
  it('truncates towards zero like dayjs diff', () => {
    expect(daysUntil('2026-10-15T11:00:00Z', now)).toBe(9)
    expect(daysUntil('2026-10-15T13:00:00Z', now)).toBe(10)
    expect(daysUntil('2026-10-05T18:00:00Z', now)).toBe(0)
    expect(daysUntil('2026-10-01T12:00:00Z', now)).toBe(-4)
  })
})

describe('parseCertificateInfo', () => {
  const now = new Date('2026-10-05T00:00:00Z')
  const fake = (
    cn: string,
    issuerCn: string,
    validTo: string,
    fingerprint: string,
    extra: Partial<DetailedPeerCertificate> = {},
  ) =>
    ({
      subject: { CN: cn, O: 'Org' },
      issuer: { CN: issuerCn },
      valid_from: '2026-01-01T00:00:00Z',
      valid_to: validTo,
      fingerprint,
      fingerprint256: `${fingerprint}-256`,
      serialNumber: `SN-${cn}`,
      ...extra,
    }) as unknown as DetailedPeerCertificate

  it('walks a chain, labels each link and stops at the self-referencing root', () => {
    const root = fake('Root CA', 'Root CA', '2040-01-01T00:00:00Z', 'R')
    ;(root as { issuerCertificate: unknown }).issuerCertificate = root
    const inter = fake('Inter CA', 'Root CA', '2030-01-01T00:00:00Z', 'I', {
      issuerCertificate: root,
    })
    const leaf = fake('leaf.test', 'Inter CA', '2026-10-15T00:00:00Z', 'L', {
      issuerCertificate: inter,
      subjectaltname: 'DNS:leaf.test, DNS:www.leaf.test, IP Address:10.0.0.1',
    })

    const info = parseCertificateInfo(leaf, now)
    expect(info).toMatchObject({
      subjectCN: 'leaf.test',
      issuerCN: 'Inter CA',
      certType: 'server',
      daysRemaining: 10,
      fingerprint256: 'L-256',
      serialNumber: 'SN-leaf.test',
      validFor: ['leaf.test', 'www.leaf.test', '10.0.0.1'],
    })
    expect(info?.validTo).toBe('2026-10-15T00:00:00.000Z')
    expect(info?.issuerCertificate).toMatchObject({
      subjectCN: 'Inter CA',
      certType: 'intermediate CA',
    })
    expect(info?.issuerCertificate?.issuerCertificate).toMatchObject({
      subjectCN: 'Root CA',
      certType: 'root CA',
      issuerCertificate: null,
    })
    expect(certificateChain(info).map((c) => c.subjectCN)).toEqual([
      'leaf.test',
      'Inter CA',
      'Root CA',
    ])
  })

  it('marks a lone certificate as self-signed and tolerates missing data', () => {
    const lone = fake('solo', 'solo', '2027-01-01T00:00:00Z', 'S')
    expect(parseCertificateInfo(lone, now)).toMatchObject({
      certType: 'self-signed',
      issuerCertificate: null,
      validFor: [],
    })
    expect(parseCertificateInfo(null, now)).toBeNull()
    expect(parseCertificateInfo({} as DetailedPeerCertificate, now)).toBeNull()
  })
})

describe('certificateMatchesHost', () => {
  it('checks DNS names and IPs against the fixture SANs', () => {
    expect(certificateMatchesHost(fixture.raw, 'localhost')).toBe(true)
    expect(certificateMatchesHost(fixture.raw, '127.0.0.1')).toBe(true)
    expect(certificateMatchesHost(fixture.raw, 'other.test')).toBe(false)
    expect(certificateMatchesHost(null, 'localhost')).toBeNull()
    expect(certificateMatchesHost(fixture.raw, null)).toBeNull()
  })
})

describe('fetchCertificate (local TLS server, self-signed)', () => {
  it('captures the certificate even though the chain is untrusted', async () => {
    const now = new Date()
    const info = await fetchCertificate('127.0.0.1', port, { servername: 'localhost', now })
    expect(info.valid).toBe(false)
    expect(info.authorizationError).toMatch(/SELF_SIGNED/)
    expect(info.hostnameMatch).toBe(true)
    expect(info.checkedAt).toBe(now.toISOString())
    expect(info.certInfo).toMatchObject({
      subjectCN: 'localhost',
      issuerCN: 'localhost',
      certType: 'self-signed',
      fingerprint256: fixture.fingerprint256,
      issuerCertificate: null,
    })
    expect(info.certInfo?.issuer.O).toBe('Marmot Test')
    expect(info.certInfo?.validFor).toEqual(['localhost', '127.0.0.1'])
    expect(info.certInfo?.validTo).toBe(new Date(fixture.validTo).toISOString())
    expect(info.certInfo?.daysRemaining).toBe(daysUntil(fixture.validTo, now))
    expect(info.certInfo!.daysRemaining).toBeGreaterThan(30_000)
    expect(isTlsInfo(info)).toBe(true)
  })

  it('reports a hostname mismatch and trusts the chain when the CA is supplied', async () => {
    const mismatch = await fetchCertificate('127.0.0.1', port, { servername: 'other.test' })
    expect(mismatch.hostnameMatch).toBe(false)

    const trusted = await fetchCertificate('127.0.0.1', port, { servername: 'localhost', ca: cert })
    expect(trusted.valid).toBe(true)
    expect(trusted.authorizationError).toBeNull()
  })

  it('rejects when verification is required, like the monitor request would', async () => {
    await expect(
      fetchCertificate('127.0.0.1', port, { servername: 'localhost', rejectUnauthorized: true }),
    ).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
  })

  it('fails fast on a closed port and on an aborted signal', async () => {
    const closed = https.createServer({ cert, key })
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const closedPort = (closed.address() as AddressInfo).port
    await new Promise((resolve) => closed.close(resolve))
    await expect(fetchCertificate('127.0.0.1', closedPort)).rejects.toThrow()

    const controller = new AbortController()
    controller.abort()
    await expect(
      fetchCertificate('127.0.0.1', port, { signal: controller.signal }),
    ).rejects.toThrow(/aborted/)
  })
})

describe('capturingAgent / performHttpCheck', () => {
  const monitor = (overrides: Partial<Monitor>): Monitor =>
    ({
      id: 1,
      name: 'tls',
      type: 'http',
      url: `https://127.0.0.1:${port}/`,
      interval: 60,
      retryInterval: 60,
      maxRetries: 0,
      resendInterval: 0,
      timeout: 10,
      acceptedStatusCodes: ['200-299'],
      maxRedirects: 0,
      ...overrides,
    }) as unknown as Monitor

  const context = (m: Monitor): MonitorCheckContext => ({
    monitor: m,
    heartbeat: { status: 'down', msg: '' },
    signal: AbortSignal.timeout(10_000),
    payload: null as never,
  })

  it('records the certificate of the socket the request went over', async () => {
    const capture: TlsCapture = { tlsInfo: null }
    const agent = capturingAgent({ rejectUnauthorized: false }, capture)
    try {
      const res = await request(`https://127.0.0.1:${port}/`, { dispatcher: agent })
      expect(res.statusCode).toBe(200)
      await res.body.text()
    } finally {
      await agent.close()
    }
    expect(capture.tlsInfo?.certInfo?.fingerprint256).toBe(fixture.fingerprint256)
    expect(capture.tlsInfo?.valid).toBe(false)
    expect(capture.tlsInfo?.hostnameMatch).toBe(true)
  })

  it('performHttpCheck stores the certificate on the context when ignoreTls is on', async () => {
    const ctx = context(monitor({ ignoreTls: true }))
    const res = await performHttpCheck(ctx)
    expect(res.statusCode).toBe(200)
    expect(ctx.heartbeat.msg).toBe('200 - OK')
    expect(ctx.tlsInfo?.certInfo?.subjectCN).toBe('localhost')
    expect(ctx.tlsInfo?.valid).toBe(false)
  })

  it('performHttpCheck falls back to a plain handshake when the request rejects the certificate', async () => {
    const ctx = context(monitor({ ignoreTls: false }))
    await expect(performHttpCheck(ctx)).rejects.toThrow(/self[- ]signed/i)
    expect(ctx.tlsInfo?.valid).toBe(false)
    expect(ctx.tlsInfo?.authorizationError).toMatch(/DEPTH_ZERO_SELF_SIGNED_CERT/)
    expect(ctx.tlsInfo?.certInfo?.fingerprint256).toBe(fixture.fingerprint256)
  })

  it('isTlsHandshakeError only matches certificate problems', () => {
    expect(isTlsHandshakeError(Object.assign(new Error('x'), { code: 'CERT_HAS_EXPIRED' }))).toBe(
      true,
    )
    expect(
      isTlsHandshakeError(new Error("Hostname/IP does not match certificate's altnames")),
    ).toBe(true)
    expect(isTlsHandshakeError(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }))).toBe(
      false,
    )
    expect(isTlsHandshakeError('nope')).toBe(false)
  })
})

describe('certificateChanged', () => {
  const info = (fingerprint256: string, validTo = '2027-01-01T00:00:00.000Z'): TlsInfo => ({
    valid: true,
    hostnameMatch: true,
    authorizationError: null,
    checkedAt: '2026-10-05T00:00:00.000Z',
    certInfo: {
      subject: {},
      issuer: {},
      subjectCN: 'a',
      issuerCN: 'b',
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo,
      daysRemaining: 100,
      fingerprint: 'f',
      fingerprint256,
      serialNumber: null,
      validFor: [],
      certType: 'server',
      issuerCertificate: null,
    },
  })

  it('is true for the first capture and for a different leaf, false otherwise', () => {
    expect(certificateChanged(null, info('A'))).toBe(true)
    expect(certificateChanged({ junk: true }, info('A'))).toBe(true)
    expect(certificateChanged(info('A'), info('A'))).toBe(false)
    expect(certificateChanged(info('A'), info('B'))).toBe(true)
    expect(certificateChanged(info('A'), info('A', '2028-01-01T00:00:00.000Z'))).toBe(true)
    expect(certificateChanged(info('A'), null)).toBe(false)
    expect(certificateChanged(info('A'), { ...info('A'), certInfo: null })).toBe(false)
  })
})
