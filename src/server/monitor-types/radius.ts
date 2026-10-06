/**
 * RADIUS monitor: sends an Access-Request for `radiusUsername`/`radiusPassword` to
 * `hostname:port` (default 1812) signed with `radiusSecret`; UP on Access-Accept (or any reply
 * other than Access-Reject). The `radius` codec is an optional dependency loaded inside `check()`;
 * the UDP client is a port of Uptime Kuma's lightweight implementation.
 *
 * Ported from Uptime Kuma 2.5.5 `server/radius-client.js` and `server/util-server.js` (`radius`) —
 * Copyright (c) 2021 Louis Lam, MIT License. See THIRD_PARTY_NOTICES.md.
 */
import dgram from 'node:dgram'
import dns from 'node:dns/promises'
import net from 'node:net'

import type { Monitor } from '@/payload-types'

import { registerMonitorType } from './registry'
import {
  checkTimeoutMs,
  errorMessage,
  loadOptionalDriver,
  requireField,
  requireHostname,
} from './util'

export const DEFAULT_RADIUS_PORT = 1812

export interface RadiusRequest {
  host: string
  port: number
  secret: string
  /** `[attribute, value]` pairs, e.g. `['User-Name', 'alice']`. */
  attributes: [string, string][]
  /** Per-attempt timeout in milliseconds. */
  timeoutMs: number
  /** Extra attempts after the first one. */
  retries?: number
}

export interface RadiusResponse {
  code: string
}

/** Resolve `host` to an address (IPv4 preferred) so the right UDP socket family can be used. */
async function resolveAddress(host: string): Promise<{ address: string; family: 4 | 6 }> {
  const literal = net.isIP(host)
  if (literal === 4 || literal === 6) return { address: host, family: literal }
  const results = await dns.lookup(host, { all: true })
  const pick = results.find((r) => r.family === 4) ?? results[0]
  if (!pick) throw new Error(`DNS lookup returned no addresses for ${host}`)
  return { address: pick.address, family: pick.family === 6 ? 6 : 4 }
}

/** Send one Access-Request (with retries) and resolve with the decoded reply. */
export async function radiusAccessRequest(request: RadiusRequest): Promise<RadiusResponse> {
  const radius = await loadOptionalDriver(() => import('radius'), 'radius', 'Radius')
  const codec = ('default' in radius ? radius.default : radius) as typeof import('radius')

  let encoded: Buffer
  try {
    encoded = codec.encode({
      code: 'Access-Request',
      secret: request.secret,
      attributes: request.attributes,
    })
  } catch (err) {
    throw new Error(`RADIUS packet encoding failed: ${errorMessage(err)}`)
  }

  const { address, family } = await resolveAddress(request.host)
  const retries = request.retries ?? 1

  return new Promise<RadiusResponse>((resolve, reject) => {
    const socket = dgram.createSocket(family === 6 ? 'udp6' : 'udp4')
    let attempts = 0
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // already closed
      }
      fn()
    }

    const sendRequest = () => {
      if (settled) return
      attempts++
      socket.send(encoded, 0, encoded.length, request.port, address, (err) => {
        if (err) {
          finish(() => reject(new Error(`Failed to send RADIUS request: ${err.message}`)))
          return
        }
        timer = setTimeout(() => {
          if (settled) return
          if (attempts < retries + 1) sendRequest()
          else {
            finish(() => reject(new Error(`RADIUS request timeout after ${attempts} attempts`)))
          }
        }, request.timeoutMs)
      })
    }

    socket.on('message', (msg) => {
      if (settled) return
      let response: { code: string }
      try {
        response = codec.decode({ packet: msg, secret: request.secret })
      } catch (err) {
        finish(() => reject(new Error(`RADIUS response decoding failed: ${errorMessage(err)}`)))
        return
      }
      if (!codec.verify_response({ response: msg, request: encoded, secret: request.secret })) {
        finish(() =>
          reject(new Error('RADIUS response authenticator mismatch (wrong shared secret?)')),
        )
        return
      }
      if (response.code === 'Access-Reject') {
        finish(() => reject(new Error('Access-Reject')))
        return
      }
      finish(() => resolve({ code: response.code }))
    })
    socket.on('error', (err) =>
      finish(() => reject(new Error(`RADIUS socket error: ${err.message}`))),
    )

    sendRequest()
  })
}

/** Attribute pairs from the monitor settings (empty station ids are left out). */
export function radiusAttributes(
  monitor: Pick<
    Monitor,
    'radiusUsername' | 'radiusPassword' | 'radiusCalledStationId' | 'radiusCallingStationId'
  >,
): [string, string][] {
  const attributes: [string, string][] = [
    ['User-Name', requireField(monitor.radiusUsername, 'Username')],
    ['User-Password', monitor.radiusPassword ?? ''],
  ]
  if (monitor.radiusCallingStationId) {
    attributes.push(['Calling-Station-Id', monitor.radiusCallingStationId])
  }
  if (monitor.radiusCalledStationId) {
    attributes.push(['Called-Station-Id', monitor.radiusCalledStationId])
  }
  return attributes
}

registerMonitorType({
  name: 'radius',
  label: 'Radius',
  group: 'specific',
  async check(ctx) {
    const host = requireHostname(ctx.monitor)
    const port = ctx.monitor.port || DEFAULT_RADIUS_PORT
    const secret = requireField(ctx.monitor.radiusSecret, 'Shared secret')
    const attributes = radiusAttributes(ctx.monitor)
    // Two attempts within the check timeout, like Uptime Kuma (timeout 40% of the interval, 1 retry).
    const timeoutMs = Math.max(250, Math.floor(checkTimeoutMs(ctx.monitor) / 2))

    const startTime = Date.now()
    let response: RadiusResponse
    try {
      response = await radiusAccessRequest({
        host,
        port,
        secret,
        attributes,
        timeoutMs,
        retries: 1,
      })
    } catch (err) {
      const message = errorMessage(err)
      throw new Error(
        message === 'Access-Reject'
          ? `RADIUS Access-Reject from ${host}:${port}`
          : `RADIUS authentication failed for ${host}:${port}: ${message}`,
      )
    }
    ctx.heartbeat.ping = Date.now() - startTime
    ctx.heartbeat.msg = response.code
    ctx.heartbeat.status = 'up'
  },
})
