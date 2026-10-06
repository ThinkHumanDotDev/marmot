import net from 'node:net'
import type { AddressInfo } from 'node:net'
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
