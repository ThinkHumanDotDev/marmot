/**
 * WebSocket upgrade monitor: opens a WebSocket to `url`, closes it right away and judges the close
 * code against `acceptedStatusCodes` (default `1000`). Supports custom headers, basic/bearer auth,
 * mTLS, subprotocols and lenient `Sec-WebSocket-Accept` handling. `ws` is an optional dependency
 * loaded inside `check()`.
 *
 * Ported from Uptime Kuma 2.5.5 `server/monitor-types/websocket-upgrade.js` — Copyright (c) 2021
 * Louis Lam, MIT License. See THIRD_PARTY_NOTICES.md. (OAuth2 is not wired for WebSockets yet.)
 */
import type { ClientOptions } from 'ws'

import type { Monitor } from '@/payload-types'
import {
  guardedLookup,
  literalTargetDenial,
  outboundGuardActive,
} from '@/server/security/outbound-guard'

import { checkStatusCode } from './http-request'
import { registerMonitorType } from './registry'
import { checkTimeoutMs, loadOptionalDriver, requireField } from './util'

/** Friendly names of WebSocket close codes (IANA registry). */
export const WS_ERR_CODE: Record<number, string> = {
  1002: 'Protocol error',
  1003: 'Unsupported Data',
  1005: 'No Status Received',
  1006: 'Abnormal Closure',
  1007: 'Invalid frame payload data',
  1008: 'Policy Violation',
  1009: 'Message Too Big',
  1010: 'Mandatory Extension Missing',
  1011: 'Internal Error',
  1012: 'Service Restart',
  1013: 'Try Again Later',
  1014: 'Bad Gateway',
  1015: 'TLS Handshake Failed',
  3000: 'Unauthorized',
  3003: 'Forbidden',
  3008: 'Timeout',
}

export const DEFAULT_WS_ACCEPTED_CODES = ['1000']

/** `ws` client options (headers, auth, TLS) from the monitor settings. */
export function buildWsOptions(
  monitor: Pick<
    Monitor,
    | 'headers'
    | 'authMethod'
    | 'basicAuthUser'
    | 'basicAuthPass'
    | 'bearerToken'
    | 'tlsCert'
    | 'tlsKey'
    | 'tlsCa'
    | 'ignoreTls'
  >,
  timeoutMs: number,
): ClientOptions {
  const headers: Record<string, string> = {}
  if (monitor.headers) {
    try {
      const parsed = JSON.parse(monitor.headers) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          headers[k] = String(v)
        }
      }
    } catch {
      // Invalid header JSON is ignored, as in Uptime Kuma.
    }
  }

  const options: ClientOptions = {
    handshakeTimeout: timeoutMs,
    headers,
    rejectUnauthorized: !monitor.ignoreTls,
  }

  if (monitor.authMethod === 'basic') {
    if (monitor.basicAuthUser || monitor.basicAuthPass) {
      const credentials = Buffer.from(
        `${monitor.basicAuthUser ?? ''}:${monitor.basicAuthPass ?? ''}`,
      ).toString('base64')
      headers.Authorization = `Basic ${credentials}`
    }
  } else if (monitor.authMethod === 'bearer') {
    if (monitor.bearerToken) headers.Authorization = `Bearer ${monitor.bearerToken}`
  } else if (monitor.authMethod === 'mtls') {
    if (monitor.tlsCert) options.cert = monitor.tlsCert
    if (monitor.tlsKey) options.key = monitor.tlsKey
    if (monitor.tlsCa) options.ca = monitor.tlsCa
  }
  return options
}

export interface UpgradeResult {
  message: string
  code?: number
}

/** Try the upgrade once and report the close code (or the error message when none arrives). */
export async function attemptUpgrade(
  url: string,
  options: ClientOptions,
  extra: { subprotocol?: string | null; ignoreSecWebsocketAcceptHeader?: boolean | null },
): Promise<UpgradeResult> {
  const { default: WebSocket } = await loadOptionalDriver(
    () => import('ws'),
    'ws',
    'WebSocket Upgrade',
  )
  const protocols = extra.subprotocol
    ? extra.subprotocol
        .replace(/\s/g, '')
        .split(',')
        .filter((p) => p.length > 0)
    : undefined

  return new Promise<UpgradeResult>((resolve) => {
    let settled = false
    const done = (result: UpgradeResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const ws = new WebSocket(url, protocols, options)
    ws.on('open', () => ws.close(1000))
    ws.onerror = (event) => {
      // Non-compliant servers may omit the Sec-WebSocket-Accept header; the user may accept that.
      if (
        extra.ignoreSecWebsocketAcceptHeader &&
        event.message === 'Invalid Sec-WebSocket-Accept header'
      ) {
        done({ message: '1000 - OK', code: 1000 })
        return
      }
      const code = (event.error as { code?: unknown } | undefined)?.code
      done({ message: event.message, code: typeof code === 'number' ? code : undefined })
    }
    ws.onclose = (event) => {
      done({
        message: event.wasClean ? `${event.code} - OK` : event.reason,
        code: event.code,
      })
    }
  })
}

registerMonitorType({
  name: 'websocket-upgrade',
  label: 'WebSocket Upgrade',
  group: 'specific',
  async check(ctx) {
    const url = requireField(ctx.monitor.url, 'URL')
    if (!/^wss?:\/\//i.test(url)) {
      throw new Error('URL must start with ws:// or wss://')
    }
    const timeout = checkTimeoutMs(ctx.monitor)
    const wsOptions = buildWsOptions(ctx.monitor, timeout)
    if (outboundGuardActive()) {
      // Outbound address guard: literal hosts are checked here, names by `guardedLookup` when the
      // socket connects (ws does not follow redirects).
      const denial = literalTargetDenial(new URL(url).hostname)
      if (denial) throw new Error(denial)
      Object.assign(wsOptions, { lookup: guardedLookup })
    }
    const startTime = Date.now()
    const { message, code } = await attemptUpgrade(url, wsOptions, {
      subprotocol: ctx.monitor.wsSubprotocol,
      ignoreSecWebsocketAcceptHeader: ctx.monitor.wsIgnoreSecWebsocketAcceptHeader,
    })
    ctx.heartbeat.ping = Date.now() - startTime

    if (code !== undefined) {
      const accepted = ctx.monitor.acceptedStatusCodes?.length
        ? ctx.monitor.acceptedStatusCodes
        : DEFAULT_WS_ACCEPTED_CODES
      if (checkStatusCode(code, accepted)) {
        ctx.heartbeat.status = 'up'
        ctx.heartbeat.msg = message
        return
      }
      throw new Error(WS_ERR_CODE[code] || `Unexpected status code: ${code}`)
    }
    if (message) throw new Error(message)
    throw new Error('Unknown Websocket Error')
  },
})
