/**
 * NTP monitor: sends an NTPv3 client request to `hostname:port` (default 123) over UDP and checks
 * the reply for synchronisation (stratum), time offset and root dispersion. Pure Node, no driver.
 *
 * Ported from Uptime Kuma 2.5.5 `server/monitor-types/ntp.js` — Copyright (c) 2021 Louis Lam,
 * MIT License. See THIRD_PARTY_NOTICES.md.
 */
import dgram from 'node:dgram'
import dns from 'node:dns'

import { resolveGuardedTarget } from '@/server/security/outbound-guard'

import { registerMonitorType } from './registry'
import { checkTimeoutMs, requireHostname } from './util'

export const DEFAULT_NTP_PORT = 123
/** Uptime Kuma defaults: stratum must be below 5, |offset| below 1 s, dispersion below 500 ms. */
export const NTP_STRATUM_THRESHOLD = 5
export const NTP_OFFSET_THRESHOLD_MS = 1000
export const NTP_DISPERSION_THRESHOLD_MS = 500

/** Milliseconds between the NTP epoch (1900) and the Unix epoch (1970). */
export const NTP_EPOCH_OFFSET_MS = 2208988800000

export interface NtpResult {
  leapIndicator: number
  stratum: number
  /** Root dispersion in milliseconds. */
  rootDispersion: number
  refid: string
  /** Clock offset in milliseconds (positive when the server is ahead). */
  offset: number
  roundTripDelay: number
}

/** NTPv3 client request (48 bytes): LI=0, VN=3, Mode=3 → 0x1B. */
export function createNtpPacket(): Buffer {
  const packet = Buffer.alloc(48)
  packet[0] = 0x1b
  return packet
}

/** 64-bit NTP timestamp at `offset` → milliseconds since the NTP epoch. */
export function readNtpTimestamp(buf: Buffer, offset: number): number {
  const seconds = buf.readUInt32BE(offset)
  const fraction = buf.readUInt32BE(offset + 4)
  return seconds * 1000 + (fraction * 1000) / 0x100000000
}

/** Write milliseconds since the NTP epoch as a 64-bit NTP timestamp at `offset`. */
export function writeNtpTimestamp(buf: Buffer, offset: number, ms: number): void {
  const seconds = Math.floor(ms / 1000)
  const fraction = Math.floor(((ms - seconds * 1000) / 1000) * 0x100000000)
  buf.writeUInt32BE(seconds >>> 0, offset)
  buf.writeUInt32BE(fraction >>> 0, offset + 4)
}

/**
 * Parse a server reply. `t1`/`t4` are the client's originate/receive times in ms since the NTP
 * epoch; offset and delay follow RFC 5905.
 */
export function parseNtpResponse(msg: Buffer, t1: number, t4: number): NtpResult {
  if (msg.length < 48) {
    throw new Error(`Invalid NTP response: expected 48+ bytes, got ${msg.length}`)
  }
  const leapIndicator = (msg[0] >> 6) & 0x03
  const stratum = msg[1]
  // Root dispersion: 32-bit unsigned fixed-point at offset 8, in seconds
  const rootDispersion = (msg.readUInt32BE(8) / 65536) * 1000
  // Reference ID: ASCII for stratum 0-1, IPv4 address for stratum 2+
  const refid =
    stratum <= 1
      ? msg.toString('ascii', 12, 16).replace(/\0/g, '').trim()
      : `${msg[12]}.${msg[13]}.${msg[14]}.${msg[15]}`
  const t2 = readNtpTimestamp(msg, 32) // server receive
  const t3 = readNtpTimestamp(msg, 40) // server transmit
  const offset = (t2 - t1 + (t3 - t4)) / 2
  const roundTripDelay = t4 - t1 - (t3 - t2)
  return { leapIndicator, stratum, rootDispersion, refid, offset, roundTripDelay }
}

/** Query an NTP server once over UDP. */
export function queryNtp(hostname: string, port: number, timeoutMs: number): Promise<NtpResult> {
  return new Promise((resolve, reject) => {
    let client: dgram.Socket | null = null
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client?.close()
      fn()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error('NTP request timed out'))),
      timeoutMs,
    )

    dns.lookup(hostname, (dnsErr, address, family) => {
      if (settled) return
      if (dnsErr) {
        finish(() => reject(new Error(`DNS lookup failed for ${hostname}: ${dnsErr.message}`)))
        return
      }
      const socket = dgram.createSocket(family === 6 ? 'udp6' : 'udp4')
      client = socket
      const packet = createNtpPacket()
      const t1 = Date.now() + NTP_EPOCH_OFFSET_MS

      socket.on('error', (err) =>
        finish(() => reject(new Error(`UDP socket error: ${err.message}`))),
      )
      socket.on('message', (msg) => {
        const t4 = Date.now() + NTP_EPOCH_OFFSET_MS
        try {
          const result = parseNtpResponse(msg, t1, t4)
          finish(() => resolve(result))
        } catch (err) {
          finish(() => reject(err))
        }
      })
      socket.send(packet, 0, packet.length, port, address, (err) => {
        if (err) finish(() => reject(new Error(`Failed to send NTP request: ${err.message}`)))
      })
    })
  })
}

/** Apply the quality thresholds; returns the heartbeat message or throws. */
export function assertNtpQuality(result: NtpResult): string {
  const { stratum, offset, rootDispersion, refid, roundTripDelay } = result
  const msg = `Stratum: ${stratum}, RefID: ${refid}, Offset: ${offset.toFixed(3)}ms, Delay: ${roundTripDelay.toFixed(3)}ms, Dispersion: ${rootDispersion.toFixed(3)}ms`
  if (stratum === 16) {
    throw new Error('NTP server is unsynchronized (stratum 16)')
  }
  if (stratum >= NTP_STRATUM_THRESHOLD) {
    throw new Error(`Stratum ${stratum} meets or exceeds threshold ${NTP_STRATUM_THRESHOLD}`)
  }
  if (Math.abs(offset) >= NTP_OFFSET_THRESHOLD_MS) {
    throw new Error(
      `Time offset ${offset.toFixed(3)}ms exceeds threshold ${NTP_OFFSET_THRESHOLD_MS}ms`,
    )
  }
  if (rootDispersion >= NTP_DISPERSION_THRESHOLD_MS) {
    throw new Error(
      `Root dispersion ${rootDispersion.toFixed(3)}ms exceeds threshold ${NTP_DISPERSION_THRESHOLD_MS}ms`,
    )
  }
  return msg
}

registerMonitorType({
  name: 'ntp',
  label: 'NTP',
  group: 'specific',
  async check(ctx) {
    const hostname = requireHostname(ctx.monitor)
    // Outbound address guard: query the vetted address (null when the guard is off).
    const vetted = await resolveGuardedTarget(hostname)
    const startTime = Date.now()
    const result = await queryNtp(
      vetted?.address ?? hostname,
      ctx.monitor.port || DEFAULT_NTP_PORT,
      checkTimeoutMs(ctx.monitor),
    )
    ctx.heartbeat.ping = Date.now() - startTime
    ctx.heartbeat.msg = assertNtpQuality(result)
    ctx.heartbeat.status = 'up'
  },
})
