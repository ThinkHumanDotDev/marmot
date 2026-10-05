import dgram from 'node:dgram'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  CLOSED_HOST,
  CLOSED_PORT,
  makeMonitor,
  runCheck,
} from '../../../tests/helpers/monitor-check'
import {
  assertNtpQuality,
  createNtpPacket,
  NTP_EPOCH_OFFSET_MS,
  parseNtpResponse,
  readNtpTimestamp,
  writeNtpTimestamp,
  type NtpResult,
} from './ntp'
import './index'

/** Build a server reply: stratum, refid, dispersion and both server timestamps set to `now`. */
function ntpReply(stratum: number, options: { dispersionMs?: number; offsetMs?: number } = {}) {
  const packet = Buffer.alloc(48)
  packet[0] = 0x1c // LI=0, VN=3, Mode=4 (server)
  packet[1] = stratum
  packet.writeUInt32BE(Math.round(((options.dispersionMs ?? 10) / 1000) * 65536), 8)
  if (stratum <= 1) packet.write('GPS', 12, 'ascii')
  else Buffer.from([10, 0, 0, 1]).copy(packet, 12)
  const now = Date.now() + NTP_EPOCH_OFFSET_MS + (options.offsetMs ?? 0)
  writeNtpTimestamp(packet, 32, now)
  writeNtpTimestamp(packet, 40, now)
  return packet
}

let server: dgram.Socket
let port: number
let stratum = 2

beforeAll(async () => {
  server = dgram.createSocket('udp4')
  server.on('message', (_msg, rinfo) => {
    server.send(ntpReply(stratum), rinfo.port, rinfo.address)
  })
  await new Promise<void>((resolve) => server.bind(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('ntp packets', () => {
  it('creates a 48-byte NTPv3 client request', () => {
    const packet = createNtpPacket()
    expect(packet.length).toBe(48)
    expect(packet[0]).toBe(0x1b)
  })

  it('round-trips timestamps', () => {
    const buf = Buffer.alloc(8)
    const ms = Date.now() + NTP_EPOCH_OFFSET_MS + 0.5
    writeNtpTimestamp(buf, 0, ms)
    expect(Math.abs(readNtpTimestamp(buf, 0) - ms)).toBeLessThan(0.001)
  })

  it('parses stratum, refid and offset', () => {
    const t1 = Date.now() + NTP_EPOCH_OFFSET_MS
    const result = parseNtpResponse(ntpReply(1, { offsetMs: 250 }), t1, t1 + 20)
    expect(result.stratum).toBe(1)
    expect(result.refid).toBe('GPS')
    expect(result.offset).toBeCloseTo(240, -1)
    expect(parseNtpResponse(ntpReply(3), t1, t1).refid).toBe('10.0.0.1')
    expect(() => parseNtpResponse(Buffer.alloc(10), t1, t1)).toThrow(/expected 48\+ bytes/)
  })

  it('applies the quality thresholds', () => {
    const good: NtpResult = {
      leapIndicator: 0,
      stratum: 2,
      rootDispersion: 10,
      refid: '10.0.0.1',
      offset: 3,
      roundTripDelay: 5,
    }
    expect(assertNtpQuality(good)).toMatch(/^Stratum: 2, RefID: 10.0.0.1, Offset: 3.000ms/)
    expect(() => assertNtpQuality({ ...good, stratum: 16 })).toThrow('unsynchronized')
    expect(() => assertNtpQuality({ ...good, stratum: 5 })).toThrow('Stratum 5 meets or exceeds')
    expect(() => assertNtpQuality({ ...good, offset: -1500 })).toThrow(/Time offset -1500.000ms/)
    expect(() => assertNtpQuality({ ...good, rootDispersion: 900 })).toThrow(/Root dispersion/)
  })
})

describe('ntp monitor', () => {
  it('is UP against a healthy local server', async () => {
    stratum = 2
    const beat = await runCheck(
      makeMonitor({ type: 'ntp', hostname: '127.0.0.1', port, timeout: 2 }),
    )
    expect(beat.status).toBe('up')
    expect(beat.msg).toMatch(/^Stratum: 2/)
  })

  it('fails when the server is unsynchronised', async () => {
    stratum = 16
    await expect(
      runCheck(makeMonitor({ type: 'ntp', hostname: '127.0.0.1', port, timeout: 2 })),
    ).rejects.toThrow('NTP server is unsynchronized (stratum 16)')
  })

  it('rejects with a readable message when nothing answers', async () => {
    const monitor = makeMonitor({
      type: 'ntp',
      hostname: CLOSED_HOST,
      port: CLOSED_PORT,
      timeout: 1,
    })
    await expect(runCheck(monitor)).rejects.toThrow(/NTP request timed out|UDP socket error/)
  })
})
