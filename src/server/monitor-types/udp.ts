/**
 * UDP monitor: sends one datagram (`udpPayload`, text or hex) to `hostname:port` and judges what
 * comes back. With `udpResponseMatch` = `none` the check is UP when no ICMP port-unreachable error
 * arrives within `UDP_UNREACHABLE_WAIT_MS` (or as soon as any reply arrives); `any`, `keyword` and
 * `regex` wait for a reply (up to the monitor timeout) that is non-empty / contains
 * `udpResponsePattern` / matches it as a regular expression. Pure Node (`dgram`), no driver.
 */
import dgram from 'node:dgram'
import dns from 'node:dns'
import net from 'node:net'
import { performance } from 'node:perf_hooks'

import type { Monitor } from '@/payload-types'
import { resolveGuardedTarget } from '@/server/security/outbound-guard'

import { registerMonitorType } from './registry'
import { checkTimeoutMs, requireHostname, responseExcerpt } from './util'

/** How long a check without an expected reply listens for an ICMP port-unreachable error. */
export const UDP_UNREACHABLE_WAIT_MS = 2000
/** Longest reply text the keyword / regex is matched against. */
export const UDP_MATCH_LIMIT = 8192

export const UDP_PAYLOAD_ENCODINGS = ['text', 'hex'] as const
export const UDP_RESPONSE_MATCHES = ['none', 'any', 'keyword', 'regex'] as const
export type UdpPayloadEncoding = (typeof UDP_PAYLOAD_ENCODINGS)[number]
export type UdpResponseMatch = (typeof UDP_RESPONSE_MATCHES)[number]

const HEX_PATTERN = /^(?:[0-9a-f]{2})*$/i

/** Is `value` a valid hex payload (pairs of hex digits; spaces, colons and a `0x` prefix allowed)? */
export function isHexPayload(value: string | null | undefined): boolean {
  return HEX_PATTERN.test(normalizeHex(value ?? ''))
}

const normalizeHex = (value: string) => value.replace(/^0x/i, '').replace(/[\s:]/g, '')

/** The datagram to send. Text is sent as UTF-8; `\n`-style escapes are not interpreted. */
export function encodeUdpPayload(
  payload: string | null | undefined,
  encoding: UdpPayloadEncoding | null | undefined,
): Buffer {
  const value = payload ?? ''
  if (encoding === 'hex') {
    const hex = normalizeHex(value)
    if (!HEX_PATTERN.test(hex)) {
      throw new Error(
        'The payload is not valid hex (expected pairs of hex digits, e.g. "ff 00 1a")',
      )
    }
    return Buffer.from(hex, 'hex')
  }
  return Buffer.from(value, 'utf8')
}

/** Throw unless `reply` satisfies the monitor's response expectation. */
export function assertUdpResponse(
  reply: Buffer,
  match: UdpResponseMatch,
  pattern: string | null | undefined,
): void {
  const text = reply.subarray(0, UDP_MATCH_LIMIT).toString('utf8')
  if (match === 'keyword') {
    if (!pattern || !text.includes(pattern)) {
      throw new Error(`The response does not contain "${pattern ?? ''}": ${responseExcerpt(text)}`)
    }
  } else if (match === 'regex') {
    let re: RegExp
    try {
      re = new RegExp(pattern ?? '')
    } catch (err) {
      throw new Error(`Invalid regular expression: ${(err as Error).message}`)
    }
    if (!re.test(text)) {
      throw new Error(`The response does not match /${pattern ?? ''}/: ${responseExcerpt(text)}`)
    }
  }
}

export interface UdpExchangeResult {
  /** The first reply, or null when none arrived while listening. */
  reply: Buffer | null
  /** Milliseconds from sending to the reply (or to the end of the listening window). */
  ms: number
}

/**
 * Send `payload` from a connected UDP socket (so ICMP errors are reported as `ECONNREFUSED`) and
 * wait `waitMs` for a reply. Resolves with `reply: null` when nothing came back and no error did.
 */
export function udpExchange(
  address: string,
  port: number,
  payload: Buffer,
  waitMs: number,
  signal: AbortSignal,
): Promise<UdpExchangeResult> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket(net.isIPv6(address) ? 'udp6' : 'udp4')
    let settled = false
    let sentAt = performance.now()
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      try {
        socket.close()
      } catch {
        // Already closed.
      }
      fn()
    }
    const onAbort = () =>
      finish(() => {
        const err = new Error('timeout by AbortSignal')
        err.name = 'TimeoutError'
        reject(err)
      })
    let timer: NodeJS.Timeout | undefined
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    socket.on('error', (err: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          new Error(
            err.code === 'ECONNREFUSED'
              ? `Port unreachable: ${address}:${port} answered with ICMP port unreachable`
              : `UDP error: ${err.message}`,
          ),
        ),
      ),
    )
    socket.on('message', (msg) =>
      finish(() => resolve({ reply: msg, ms: performance.now() - sentAt })),
    )
    socket.connect(port, address, () => {
      sentAt = performance.now()
      socket.send(payload, (err) => {
        if (err) {
          socket.emit('error', err)
          return
        }
        timer = setTimeout(
          () => finish(() => resolve({ reply: null, ms: performance.now() - sentAt })),
          waitMs,
        )
      })
    })
  })
}

async function resolveAddress(hostname: string): Promise<string> {
  const host = hostname.replace(/^\[|\]$/g, '')
  // Outbound address guard: send to the vetted address (null when the guard is off).
  const vetted = await resolveGuardedTarget(host)
  if (vetted) return vetted.address
  if (net.isIP(host)) return host
  try {
    return (await dns.promises.lookup(host)).address
  } catch (err) {
    throw new Error(`DNS lookup failed for ${host}: ${(err as Error).message}`)
  }
}

registerMonitorType({
  name: 'udp',
  label: 'UDP',
  group: 'specific',
  async check(ctx) {
    const monitor: Monitor = ctx.monitor
    const hostname = requireHostname(monitor)
    if (!monitor.port) throw new Error('Port is required')
    const match: UdpResponseMatch = monitor.udpResponseMatch ?? 'none'
    const payload = encodeUdpPayload(monitor.udpPayload, monitor.udpPayloadEncoding)
    const address = await resolveAddress(hostname)
    const timeoutMs = checkTimeoutMs(monitor)
    const waitMs = match === 'none' ? Math.min(UDP_UNREACHABLE_WAIT_MS, timeoutMs) : timeoutMs
    const { reply, ms } = await udpExchange(address, monitor.port, payload, waitMs, ctx.signal)

    if (!reply) {
      if (match !== 'none') throw new Error(`No response within ${timeoutMs} ms`)
      ctx.heartbeat.msg = `No ICMP port unreachable within ${waitMs} ms (no response expected)`
      ctx.heartbeat.status = 'up'
      return
    }
    assertUdpResponse(reply, match, monitor.udpResponsePattern)
    ctx.heartbeat.ping = Math.round(ms)
    ctx.heartbeat.msg = `${reply.length} byte response: ${responseExcerpt(reply.subarray(0, UDP_MATCH_LIMIT).toString('utf8'))}`
    ctx.heartbeat.status = 'up'
  },
})
