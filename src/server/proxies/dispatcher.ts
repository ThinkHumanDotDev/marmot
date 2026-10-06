/**
 * Proxy support for the HTTP monitor types: turns a `proxies` document into an undici dispatcher.
 *
 * - `http` / `https` proxies use undici's `ProxyAgent` (CONNECT tunnel for https targets, absolute-form
 *   forwarding for plain http targets).
 * - `socks4`, `socks5`, `socks5h` and `socks` use a custom undici connector that dials through the
 *   `socks` client and wraps the tunnel in TLS for https targets. Like Uptime Kuma (which uses
 *   `socks-proxy-agent`), `socks4` and `socks5` resolve the target hostname locally while `socks5h`
 *   and `socks` let the proxy resolve it.
 *
 * Protocol list and semantics follow Uptime Kuma's `server/proxy.js` (MIT, Louis Lam; see
 * THIRD_PARTY_NOTICES.md).
 */
import { lookup } from 'node:dns/promises'
import { isIP, type Socket } from 'node:net'
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls'

import { SocksClient } from 'socks'
import { Agent, ProxyAgent, type buildConnector, type Dispatcher } from 'undici'

import type { ProxyProtocol } from '@/lib/monitor-resources'

export interface ProxyConfig {
  protocol: ProxyProtocol | string
  host: string
  port: number
  auth?: boolean | null
  username?: string | null
  password?: string | null
}

/** TLS settings for the connection to the *target* (not the proxy). */
export interface TargetTlsOptions {
  rejectUnauthorized: boolean
  cert?: string
  key?: string
  ca?: string
}

const SOCKS_PROTOCOLS = new Set(['socks', 'socks4', 'socks5', 'socks5h'])

export const isSocksProtocol = (protocol: string) => SOCKS_PROTOCOLS.has(protocol)

const stripBrackets = (host: string) => host.replace(/^\[(.*)\]$/, '$1')

/** Host part of a URL authority: IPv6 literals need brackets. */
const urlHost = (host: string) =>
  isIP(stripBrackets(host)) === 6 ? `[${stripBrackets(host)}]` : host

/** `protocol://host:port` without credentials, for logs and messages. */
export const describeProxy = (proxy: Pick<ProxyConfig, 'protocol' | 'host' | 'port'>) =>
  `${proxy.protocol}://${urlHost(proxy.host)}:${proxy.port}`

/**
 * undici connector that opens every connection through a SOCKS proxy. Exported for tests.
 */
export function socksConnector(
  proxy: ProxyConfig,
  tlsOptions: TargetTlsOptions,
): buildConnector.connector {
  const version = proxy.protocol === 'socks4' ? 4 : 5
  const resolveLocally = proxy.protocol === 'socks4' || proxy.protocol === 'socks5'
  const credentials = proxy.auth && proxy.username ? proxy : null

  return (options, callback) => {
    const run = async (): Promise<Socket> => {
      const hostname = stripBrackets(options.hostname)
      const port = Number(options.port) || (options.protocol === 'https:' ? 443 : 80)
      const destination =
        resolveLocally && isIP(hostname) === 0
          ? (await lookup(hostname, { family: version === 4 ? 4 : 0 })).address
          : hostname

      const { socket } = await SocksClient.createConnection({
        command: 'connect',
        destination: { host: destination, port },
        proxy: {
          host: stripBrackets(proxy.host),
          port: proxy.port,
          type: version,
          ...(credentials
            ? version === 4
              ? { userId: credentials.username ?? undefined }
              : {
                  userId: credentials.username ?? undefined,
                  password: credentials.password ?? '',
                }
            : {}),
        },
        timeout: 30_000,
      })

      if (options.protocol !== 'https:') return socket

      return await new Promise<Socket>((resolve, reject) => {
        const secure = tlsConnect({
          socket,
          servername: isIP(hostname) === 0 ? (options.servername ?? hostname) : undefined,
          rejectUnauthorized: tlsOptions.rejectUnauthorized,
          cert: tlsOptions.cert,
          key: tlsOptions.key,
          ca: tlsOptions.ca,
          ALPNProtocols: ['http/1.1'],
        } satisfies ConnectionOptions)
        secure.once('secureConnect', () => resolve(secure))
        secure.once('error', (error) => {
          socket.destroy()
          reject(error)
        })
      })
    }

    run().then(
      (socket) => callback(null, socket),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), null),
    )
  }
}

/**
 * A fresh dispatcher that sends requests through `proxy`. The caller owns it and must `close()` it
 * after the check (dispatchers are per check so a changed proxy applies on the next beat).
 */
export function createProxyDispatcher(
  proxy: ProxyConfig,
  tlsOptions: TargetTlsOptions,
): Dispatcher & { close(): Promise<void> } {
  if (proxy.protocol === 'http' || proxy.protocol === 'https') {
    const token =
      proxy.auth && proxy.username
        ? `Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')}`
        : undefined
    return new ProxyAgent({
      uri: describeProxy(proxy),
      token,
      requestTls: { ...tlsOptions, maxCachedSessions: 0 },
      allowH2: false,
    })
  }
  if (isSocksProtocol(proxy.protocol)) {
    return new Agent({ connect: socksConnector(proxy, tlsOptions), allowH2: false })
  }
  throw new Error(`Unsupported proxy protocol "${proxy.protocol}"`)
}
