import { readFileSync } from 'node:fs'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import type { Payload } from 'payload'

import type { Monitor } from '@/payload-types'
import { getMonitorType, type MonitorCheckContext } from '@/server/monitor-types'

/**
 * Fixtures for monitor type unit tests. Monitors are built in memory (ids are numbers on Postgres
 * and strings on MongoDB, hence the cast through `unknown`); `payload` is only needed by the types
 * that read other documents or the instance settings.
 */
export function makeMonitor(over: Partial<Monitor> & { type: Monitor['type'] }): Monitor {
  return {
    id: 1,
    name: `test-${over.type}`,
    organization: 1,
    active: true,
    interval: 60,
    retryInterval: 60,
    maxRetries: 0,
    resendInterval: 0,
    timeout: 2,
    upsideDown: false,
    ...over,
  } as unknown as Monitor
}

export interface CheckOptions {
  payload?: Partial<Payload>
  signal?: AbortSignal
}

export function makeContext(monitor: Monitor, options: CheckOptions = {}): MonitorCheckContext {
  const timeoutMs = (monitor.timeout && monitor.timeout > 0 ? monitor.timeout : 2) * 1000
  return {
    monitor,
    heartbeat: { status: 'down', msg: '' },
    signal: options.signal ?? AbortSignal.timeout(timeoutMs + 2000),
    payload: (options.payload ?? {}) as Payload,
  }
}

/** Run the registered type's `check()` and return the heartbeat it produced. */
export async function runCheck(monitor: Monitor, options: CheckOptions = {}) {
  const type = getMonitorType(monitor.type)
  if (!type) throw new Error(`monitor type ${monitor.type} is not registered`)
  const ctx = makeContext(monitor, options)
  await type.check(ctx)
  return ctx.heartbeat
}

/** Local port that nothing listens on (RFC 6335 reserves 1/tcp and 1/udp for tcpmux). */
export const CLOSED_PORT = 1
export const CLOSED_HOST = '127.0.0.1'

/**
 * A TCP port on 127.0.0.1 that was free a moment ago (bind to 0, read the port, close). For clients
 * such as `fetch` that refuse to connect to port 1 ("bad port").
 */
export async function closedTcpPort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, CLOSED_HOST, resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** Self-signed certificate for `localhost` / `127.0.0.1` (valid until 2126). */
export function tlsFixture(): { cert: string; key: string } {
  const dir = path.join(process.cwd(), 'tests/fixtures/tls')
  return {
    cert: readFileSync(path.join(dir, 'localhost.crt'), 'utf8'),
    key: readFileSync(path.join(dir, 'localhost.key'), 'utf8'),
  }
}

/** One client of a `startLineServer` server. */
export interface LineConnection {
  send(line: string): void
  /** Upgrade to TLS with the fixture certificate (after answering STARTTLS / STLS). */
  startTls(): void
  readonly secure: boolean
  close(): void
}

/**
 * Scripted CRLF line server for the mail protocol monitors (IMAP, POP3): `onConnect` greets,
 * `onLine` answers each line. With `implicitTls` the connection is TLS from the start.
 */
export async function startLineServer(options: {
  implicitTls?: boolean
  onConnect(conn: LineConnection): void
  onLine(conn: LineConnection, line: string): void
}): Promise<{ port: number; close(): Promise<void> }> {
  const { cert, key } = tlsFixture()
  const handle = (raw: net.Socket) => {
    let socket: net.Socket = raw
    let buffer = ''
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let index: number
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        options.onLine(conn, line)
      }
    }
    const conn: LineConnection = {
      send: (line) => socket.write(`${line}\r\n`),
      startTls: () => {
        socket.removeListener('data', onData)
        const secure = new tls.TLSSocket(socket, { isServer: true, cert, key })
        secure.on('error', () => undefined)
        secure.on('data', onData)
        socket = secure
      },
      get secure() {
        return socket instanceof tls.TLSSocket
      },
      close: () => socket.end(),
    }
    socket.on('error', () => undefined)
    socket.on('data', onData)
    options.onConnect(conn)
  }
  const server = options.implicitTls
    ? tls.createServer({ cert, key }, handle)
    : net.createServer(handle)
  await new Promise<void>((resolve) => server.listen(0, CLOSED_HOST, resolve))
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
