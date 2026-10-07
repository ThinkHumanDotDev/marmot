/**
 * Request timing phases for HTTP checks (#94): DNS, TCP connect, TLS handshake, time to first byte
 * and body transfer, measured per check.
 *
 * Two probes feed one `HttpTimingCapture`:
 *
 * - `connector()` wraps the check agent's undici connector: it timestamps the start of every new
 *   connection (before the outbound guard resolves the name), and the socket's `lookup`, `connect`
 *   and `secureConnect` events;
 * - `interceptor()` is an undici dispatch interceptor composed *inside* the redirect interceptor, so
 *   it sees every hop: when the hop was dispatched, when its response headers arrived and when its
 *   body ended.
 *
 * `result()` reports the final hop (the response the check judges). Its connection phases are null
 * when that hop reused a socket. Earlier redirect hops are part of the total `ping` but of no phase.
 */
import { performance } from 'node:perf_hooks'
import type { IncomingHttpHeaders } from 'node:http'
import type { Socket } from 'node:net'
import { isIP } from 'node:net'
import type { Duplex } from 'node:stream'

import type { buildConnector, Dispatcher } from 'undici'

import { roundPhase, type RequestTiming } from '@/lib/request-timing'

interface ConnectionMarks {
  start: number
  /** The guarded connector handed over to the real one (the guard resolved the name by then). */
  socketAt?: number
  lookupAt?: number
  connectAt?: number
  secureAt?: number
  secure: boolean
  /** The origin host is an IP literal: there is nothing to resolve. */
  literal: boolean
}

interface HopMarks {
  start: number
  headersAt?: number
  endAt?: number
  connection?: ConnectionMarks
}

const now = () => performance.now()

const span = (from: number | undefined, to: number | undefined): number | null =>
  from === undefined || to === undefined ? null : roundPhase(to - from)

export class HttpTimingCapture {
  private hops: HopMarks[] = []

  /** The hop a new connection belongs to: the latest one still waiting for its headers. */
  private currentHop(): HopMarks | undefined {
    const hop = this.hops[this.hops.length - 1]
    return hop && hop.headersAt === undefined ? hop : undefined
  }

  /**
   * Wrap a connector so each new connection is timed. Place it *outside* the outbound guard so the
   * guard's DNS resolution counts as the DNS phase; `inner` receives the socket-level probe.
   */
  connector(
    wrap: (inner: buildConnector.connector) => buildConnector.connector,
    connector: buildConnector.connector,
  ): buildConnector.connector {
    const marksByCall = new WeakMap<object, ConnectionMarks>()
    const inner: buildConnector.connector = (opts, callback) => {
      const marks = marksByCall.get(callback)
      if (marks) marks.socketAt = now()
      const socket = connector(opts, callback) as unknown as Socket | undefined
      if (marks && socket && typeof socket.once === 'function') {
        socket.once('lookup', () => (marks.lookupAt ??= now()))
        socket.once('connect', () => (marks.connectAt ??= now()))
        if (marks.secure) socket.once('secureConnect', () => (marks.secureAt ??= now()))
      }
      return socket as never
    }
    const guarded = wrap(inner)
    return (opts, callback) => {
      const marks: ConnectionMarks = {
        start: now(),
        secure: opts.protocol === 'https:',
        literal: isIP(opts.hostname.replace(/^\[|\]$/g, '')) !== 0,
      }
      const hop = this.currentHop()
      if (hop) hop.connection = marks
      marksByCall.set(callback, marks)
      return guarded(opts, callback)
    }
  }

  /** Dispatch interceptor recording each hop; compose it inside `interceptors.redirect`. */
  interceptor(): Dispatcher.DispatcherComposeInterceptor {
    return (dispatch) => (opts, handler) => {
      const hop: HopMarks = { start: now() }
      this.hops.push(hop)
      return dispatch(opts, new TimingHandler(handler, hop))
    }
  }

  /** Phases of the final hop, or null when no response headers arrived. */
  result(): RequestTiming | null {
    const hop = this.hops[this.hops.length - 1]
    if (!hop || hop.headersAt === undefined) return null
    const conn = hop.connection
    let dns: number | null = null
    let connect: number | null = null
    let tls: number | null = null
    let ready = hop.start
    if (conn && conn.connectAt !== undefined) {
      // DNS: the socket's own lookup, or the outbound guard's resolution before the socket existed.
      const resolvedAt = conn.lookupAt ?? (conn.literal ? undefined : conn.socketAt)
      dns = span(conn.start, resolvedAt)
      connect = span(resolvedAt ?? conn.start, conn.connectAt)
      tls = conn.secure ? span(conn.connectAt, conn.secureAt) : null
      ready = Math.max(hop.start, conn.secureAt ?? conn.connectAt)
    }
    return {
      dns,
      connect,
      tls,
      ttfb: span(ready, hop.headersAt),
      transfer: span(hop.headersAt, hop.endAt ?? now()),
    }
  }
}

/** Forwards every callback to the wrapped handler, stamping response start and end. */
class TimingHandler implements Dispatcher.DispatchHandler {
  constructor(
    private readonly handler: Dispatcher.DispatchHandler,
    private readonly hop: HopMarks,
  ) {}

  onRequestStart(controller: Dispatcher.DispatchController, context: unknown) {
    return this.handler.onRequestStart?.(controller, context)
  }

  onRequestUpgrade(
    controller: Dispatcher.DispatchController,
    statusCode: number,
    headers: IncomingHttpHeaders,
    socket: Duplex,
  ) {
    return this.handler.onRequestUpgrade?.(controller, statusCode, headers, socket)
  }

  onResponseStarted() {
    return this.handler.onResponseStarted?.()
  }

  onResponseStart(
    controller: Dispatcher.DispatchController,
    statusCode: number,
    headers: IncomingHttpHeaders,
    statusMessage?: string,
  ) {
    this.hop.headersAt ??= now()
    return this.handler.onResponseStart?.(controller, statusCode, headers, statusMessage)
  }

  onResponseData(controller: Dispatcher.DispatchController, chunk: Buffer) {
    return this.handler.onResponseData?.(controller, chunk)
  }

  onResponseEnd(controller: Dispatcher.DispatchController, trailers: IncomingHttpHeaders) {
    this.hop.endAt ??= now()
    return this.handler.onResponseEnd?.(controller, trailers)
  }

  onResponseError(controller: Dispatcher.DispatchController, error: Error) {
    return this.handler.onResponseError?.(controller, error)
  }

  onBodySent(chunk: Buffer) {
    return this.handler.onBodySent?.(chunk)
  }

  onRequestSent() {
    return this.handler.onRequestSent?.()
  }
}
