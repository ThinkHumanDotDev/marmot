/**
 * Helpers for the monitor types that connect through an SSH tunnel (#160, `ctx.tunnel`). The
 * tunnel exposes a loopback endpoint per target (see `src/server/ssh-tunnels/connection.ts`);
 * these helpers point a driver's socket at it while TLS keeps verifying the target's own name.
 */
import net from 'node:net'

import type { buildConnector } from 'undici'

import type { CheckTunnel } from './types'

/**
 * The name TLS verifies the certificate against when the socket connects to a loopback endpoint:
 * the target's own host (an IP literal too, so a certificate for that IP still verifies).
 */
export const tlsServername = (host: string): string => host.replace(/^\[|\]$/g, '')

const UNIX_SOCKET_ERROR = 'Unix sockets cannot be reached through an SSH tunnel'

/** A socket to `host:port` through the tunnel; it connects once the endpoint is listening. */
export function tunnelSocket(tunnel: CheckTunnel, host: string, port: number): net.Socket {
  const socket = new net.Socket()
  tunnel.endpoint(host.replace(/^\[|\]$/g, ''), port).then(
    (endpoint) => {
      if (!socket.destroyed) socket.connect(endpoint.port, endpoint.host)
    },
    (err: unknown) => socket.destroy(err instanceof Error ? err : new Error(String(err))),
  )
  return socket
}

/**
 * Patch `socket.connect` so drivers that create the socket themselves and call
 * `connect(port, host)` later (node-postgres' `stream` option) connect through the tunnel.
 */
export function tunnelNetSocket(socket: net.Socket, tunnel: CheckTunnel): net.Socket {
  const original = socket.connect.bind(socket) as (port: number, host: string) => net.Socket
  const patched = (...args: unknown[]): net.Socket => {
    const [first, second] = args
    let host = 'localhost'
    let port: number
    if (typeof first === 'object' && first !== null) {
      const options = first as { host?: string; port?: number; path?: string }
      if (options.path) {
        process.nextTick(() => socket.destroy(new Error(UNIX_SOCKET_ERROR)))
        return socket
      }
      host = options.host ?? host
      port = Number(options.port)
    } else if (typeof first === 'string' && !/^\d+$/.test(first)) {
      process.nextTick(() => socket.destroy(new Error(UNIX_SOCKET_ERROR)))
      return socket
    } else {
      port = Number(first)
      if (typeof second === 'string' && second) host = second
    }
    tunnel.endpoint(host.replace(/^\[|\]$/g, ''), port).then(
      (endpoint) => {
        if (!socket.destroyed) original(endpoint.port, endpoint.host)
      },
      (err: unknown) => socket.destroy(err instanceof Error ? err : new Error(String(err))),
    )
    return socket
  }
  socket.connect = patched as typeof socket.connect
  return socket
}

/**
 * Wrap an undici connector (in place of `guardConnector`): every connection, each redirect hop
 * included, goes to the tunnel's endpoint for its origin. The Host header still names the origin
 * and TLS still sends and verifies the origin's name.
 */
export const tunnelConnector =
  (tunnel: CheckTunnel) =>
  (connector: buildConnector.connector): buildConnector.connector =>
  (options, callback) => {
    const hostname = options.hostname.replace(/^\[|\]$/g, '')
    const port = Number(options.port) || (options.protocol === 'https:' ? 443 : 80)
    tunnel.endpoint(hostname, port).then(
      (endpoint) =>
        connector(
          {
            ...options,
            hostname: endpoint.host,
            port: String(endpoint.port),
            servername: options.servername || hostname,
          },
          callback,
        ),
      (err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), null),
    )
  }
