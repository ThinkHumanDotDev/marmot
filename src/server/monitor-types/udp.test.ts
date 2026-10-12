import dgram from 'node:dgram'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Monitor } from '@/payload-types'

import { makeMonitor, runCheck } from './test-helpers'
import { assertUdpResponse, encodeUdpPayload, isHexPayload } from './udp'
import './index'

/** Answers `PONG <payload as hex>` to every datagram except `quiet`, which it ignores. */
let echo: dgram.Socket
let echoPort: number
let received: Buffer[] = []

const bind = (socket: dgram.Socket) =>
  new Promise<number>((resolve) =>
    socket.bind(0, '127.0.0.1', () => resolve((socket.address() as AddressInfo).port)),
  )

/** A UDP port on 127.0.0.1 that nothing listens on (bound, read, closed). */
async function closedUdpPort(): Promise<number> {
  const socket = dgram.createSocket('udp4')
  const port = await bind(socket)
  await new Promise<void>((resolve) => socket.close(() => resolve()))
  return port
}

beforeAll(async () => {
  echo = dgram.createSocket('udp4')
  echo.on('message', (msg, rinfo) => {
    received.push(msg)
    if (msg.toString() === 'quiet') return
    echo.send(`PONG ${msg.toString('hex')}`, rinfo.port, rinfo.address)
  })
  echoPort = await bind(echo)
})

afterAll(async () => {
  await new Promise<void>((resolve) => echo.close(() => resolve()))
})

const udpMonitor = (over: Partial<Monitor> = {}) =>
  makeMonitor({ type: 'udp', hostname: '127.0.0.1', port: echoPort, timeout: 3, ...over })

describe('udp payload helpers', () => {
  it('encodes text and hex payloads', () => {
    expect(encodeUdpPayload('ping', 'text')).toEqual(Buffer.from('ping'))
    expect(encodeUdpPayload('ff 00:1A', 'hex')).toEqual(Buffer.from([0xff, 0x00, 0x1a]))
    expect(encodeUdpPayload('0xff00', 'hex')).toEqual(Buffer.from([0xff, 0x00]))
    expect(encodeUdpPayload(null, 'text')).toHaveLength(0)
    expect(() => encodeUdpPayload('abc', 'hex')).toThrow(/not valid hex/)
    expect(isHexPayload('de ad be ef')).toBe(true)
    expect(isHexPayload('xyz')).toBe(false)
  })

  it('matches replies by keyword and regex', () => {
    const reply = Buffer.from('status=ok load=0.3')
    expect(() => assertUdpResponse(reply, 'any', null)).not.toThrow()
    expect(() => assertUdpResponse(reply, 'keyword', 'status=ok')).not.toThrow()
    expect(() => assertUdpResponse(reply, 'keyword', 'status=down')).toThrow(
      /does not contain "status=down"/,
    )
    expect(() => assertUdpResponse(reply, 'regex', 'load=\\d+\\.\\d')).not.toThrow()
    expect(() => assertUdpResponse(reply, 'regex', '^down')).toThrow(/does not match/)
    expect(() => assertUdpResponse(reply, 'regex', '(')).toThrow(/Invalid regular expression/)
  })
})

describe('udp monitor', () => {
  it('is UP when the reply contains the keyword, and sends the hex payload as bytes', async () => {
    received = []
    const beat = await runCheck(
      udpMonitor({
        udpPayload: 'ca fe',
        udpPayloadEncoding: 'hex',
        udpResponseMatch: 'keyword',
        udpResponsePattern: 'PONG cafe',
      }),
    )
    expect(received.at(-1)).toEqual(Buffer.from([0xca, 0xfe]))
    expect(beat.status).toBe('up')
    expect(beat.msg).toBe('9 byte response: PONG cafe')
    expect(typeof beat.ping).toBe('number')
  })

  it('fails when the reply does not match the regular expression', async () => {
    await expect(
      runCheck(
        udpMonitor({ udpPayload: 'hi', udpResponseMatch: 'regex', udpResponsePattern: '^ERR' }),
      ),
    ).rejects.toThrow(/does not match \/\^ERR\//)
  })

  it('fails when a response is expected but none arrives', async () => {
    await expect(
      runCheck(udpMonitor({ udpPayload: 'quiet', udpResponseMatch: 'any', timeout: 1 })),
    ).rejects.toThrow('No response within 1000 ms')
  })

  it('is UP without an expected response when the port stays silent', async () => {
    const beat = await runCheck(udpMonitor({ udpPayload: 'quiet', udpResponseMatch: 'none' }))
    expect(beat.status).toBe('up')
    expect(beat.msg).toMatch(/^No ICMP port unreachable within \d+ ms/)
  })

  it('is DOWN on ICMP port unreachable', async () => {
    const port = await closedUdpPort()
    await expect(
      runCheck(udpMonitor({ port, udpPayload: 'hello', udpResponseMatch: 'none' })),
    ).rejects.toThrow(`Port unreachable: 127.0.0.1:${port} answered with ICMP port unreachable`)
  })
})
