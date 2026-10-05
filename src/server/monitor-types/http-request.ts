/**
 * Shared HTTP request helper for the `http`, `keyword` and `json-query` monitor types.
 *
 * Ported from the HTTP branch of Uptime Kuma 2.5.5 `server/model/monitor.js` (`Monitor.beat`) and
 * `checkStatusCode` in `server/util-server.js` — Copyright (c) 2021 Louis Lam, MIT License.
 * See THIRD_PARTY_NOTICES.md. Uses undici instead of axios.
 */
import { STATUS_CODES } from 'node:http'
import type { Payload } from 'payload'
import { Agent, interceptors, request, type Dispatcher } from 'undici'

import type { Monitor, MonitorProxy } from '@/payload-types'
import { createProxyDispatcher, type ProxyConfig } from '@/server/proxies/dispatcher'
import type { MonitorCheckContext } from './types'

const DEFAULT_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9'

export interface HttpCheckResponse {
  statusCode: number
  statusText: string
  headers: Record<string, string | string[] | undefined>
  body: string
  /** Round-trip time in ms (request start → headers + body received). */
  ping: number
}

/**
 * Is `status` inside one of the accepted codes/ranges (`"200-299"`, `"304"`)?
 * Port of `checkStatusCode`.
 */
export function checkStatusCode(
  status: number,
  acceptedCodes: ReadonlyArray<string> | null | undefined,
): boolean {
  if (acceptedCodes == null || acceptedCodes.length === 0) {
    return false
  }
  for (const codeRange of acceptedCodes) {
    if (typeof codeRange !== 'string') continue
    const parts = codeRange.split('-').map((s) => parseInt(s.trim(), 10))
    if (parts.some((n) => Number.isNaN(n))) continue
    if (parts.length === 1) {
      if (status === parts[0]) return true
    } else if (parts.length === 2) {
      if (status >= parts[0] && status <= parts[1]) return true
    }
  }
  return false
}

const encodeBase64 = (user: string, pass: string) =>
  Buffer.from(`${user}:${pass}`).toString('base64')

/** Two long-lived agents: strict TLS and `ignoreTls`. No session reuse, like Uptime Kuma. */
const agents: Partial<Record<'strict' | 'insecure', Agent>> = {}

function baseAgent(ignoreTls: boolean): Agent {
  const key = ignoreTls ? 'insecure' : 'strict'
  agents[key] ??= new Agent({
    connect: { rejectUnauthorized: !ignoreTls, maxCachedSessions: 0 },
    allowH2: false,
  })
  return agents[key]
}

interface OAuthToken {
  accessToken: string
  tokenType: string
  expiresAt: number
}
const oauthTokens = new Map<string, OAuthToken>()

/** OAuth2 client-credentials grant (RFC 6749 §4.4); tokens are cached per monitor until they expire. */
async function oauthClientCredentials(monitor: Monitor, signal: AbortSignal): Promise<OAuthToken> {
  const cached = oauthTokens.get(String(monitor.id))
  if (cached && cached.expiresAt > Date.now()) return cached
  if (!monitor.oauthTokenUrl || !monitor.oauthClientId) {
    throw new Error('The oauth config is invalid. Token URL and client id are required')
  }
  const params = new URLSearchParams({ grant_type: 'client_credentials' })
  if (monitor.oauthScopes) params.set('scope', monitor.oauthScopes)
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
  if (monitor.oauthAuthMethod === 'client_secret_post') {
    params.set('client_id', monitor.oauthClientId)
    params.set('client_secret', monitor.oauthClientSecret ?? '')
  } else {
    headers.authorization = `Basic ${encodeBase64(monitor.oauthClientId, monitor.oauthClientSecret ?? '')}`
  }
  const res = await request(monitor.oauthTokenUrl, {
    method: 'POST',
    headers,
    body: params.toString(),
    signal,
    dispatcher: baseAgent(Boolean(monitor.ignoreTls)),
  })
  const json = (await res.body.json()) as {
    access_token?: string
    token_type?: string
    expires_in?: number
    error?: string
  }
  if (res.statusCode >= 400 || !json.access_token) {
    throw new Error(
      `The oauth config is invalid. ${json.error ?? `token endpoint returned ${res.statusCode}`}`,
    )
  }
  const token: OAuthToken = {
    accessToken: json.access_token,
    tokenType: json.token_type ?? 'Bearer',
    expiresAt: Date.now() + Math.max(0, (json.expires_in ?? 3600) - 30) * 1000,
  }
  oauthTokens.set(String(monitor.id), token)
  return token
}

/**
 * The monitor's proxy when one is set and active (Uptime Kuma skips inactive proxies and connects
 * directly). Read with `overrideAccess` so the password is available to the worker.
 */
export async function loadMonitorProxy(
  payload: Payload,
  monitor: Pick<Monitor, 'proxy'>,
): Promise<ProxyConfig | null> {
  const ref = monitor.proxy
  if (ref === null || ref === undefined) return null
  let proxy: MonitorProxy | null
  if (typeof ref === 'object') {
    proxy = ref
  } else {
    proxy = (await payload
      .findByID({ collection: 'proxies', id: ref, depth: 0, overrideAccess: true })
      .catch(() => null)) as MonitorProxy | null
  }
  if (!proxy || proxy.active === false) return null
  return proxy
}

/**
 * Build the request options from the monitor's HTTP settings. `proxy` (see `loadMonitorProxy`)
 * routes the request through an HTTP(S) or SOCKS proxy.
 */
export async function buildHttpRequest(
  monitor: Monitor,
  signal: AbortSignal,
  { proxy = null }: { proxy?: ProxyConfig | null } = {},
): Promise<{ url: string; options: Parameters<typeof request>[1]; cleanup: () => Promise<void> }> {
  if (!monitor.url) {
    throw new Error('URL is required')
  }

  const headers: Record<string, string> = { accept: DEFAULT_ACCEPT }

  // Request body + content type
  let body: string | undefined
  if (monitor.body && monitor.body.trim().length > 0) {
    const encoding = monitor.httpBodyEncoding ?? 'json'
    if (encoding === 'json') {
      try {
        body = JSON.stringify(JSON.parse(monitor.body))
        headers['content-type'] = 'application/json'
      } catch (e) {
        throw new Error(`Your JSON body is invalid. ${e instanceof Error ? e.message : String(e)}`)
      }
    } else if (encoding === 'form') {
      body = monitor.body
      headers['content-type'] = 'application/x-www-form-urlencoded'
    } else if (encoding === 'xml') {
      body = monitor.body
      headers['content-type'] = 'text/xml; charset=utf-8'
    }
  }

  // Authentication
  switch (monitor.authMethod ?? 'none') {
    case 'basic':
      headers.authorization = `Basic ${encodeBase64(monitor.basicAuthUser ?? '', monitor.basicAuthPass ?? '')}`
      break
    case 'bearer':
      headers.authorization = `Bearer ${monitor.bearerToken ?? ''}`
      break
    case 'oauth2-cc': {
      const token = await oauthClientCredentials(monitor, signal)
      headers.authorization = `${token.tokenType} ${token.accessToken}`
      break
    }
    case 'ntlm':
      throw new Error('NTLM authentication is not supported yet')
    case 'mtls':
    case 'none':
    default:
      break
  }

  // Custom headers (JSON object)
  if (monitor.headers && monitor.headers.trim().length > 0) {
    let custom: unknown
    try {
      custom = JSON.parse(monitor.headers)
    } catch (e) {
      throw new Error(`Your headers JSON is invalid. ${e instanceof Error ? e.message : String(e)}`)
    }
    if (custom && typeof custom === 'object' && !Array.isArray(custom)) {
      for (const [k, v] of Object.entries(custom as Record<string, unknown>)) {
        headers[k.toLowerCase()] = String(v)
      }
    }
  }

  // Dispatcher: shared agent (or a throw-away mTLS / proxy agent) + redirect interceptor
  let agent: Dispatcher
  let cleanup = async () => {}
  if (proxy) {
    const proxyAgent = createProxyDispatcher(proxy, {
      rejectUnauthorized: !monitor.ignoreTls,
      ...(monitor.authMethod === 'mtls'
        ? {
            cert: monitor.tlsCert || undefined,
            key: monitor.tlsKey || undefined,
            ca: monitor.tlsCa || undefined,
          }
        : {}),
    })
    agent = proxyAgent
    cleanup = async () => {
      await proxyAgent.close()
    }
  } else if (monitor.authMethod === 'mtls') {
    const mtlsAgent = new Agent({
      connect: {
        rejectUnauthorized: !monitor.ignoreTls,
        maxCachedSessions: 0,
        cert: monitor.tlsCert || undefined,
        key: monitor.tlsKey || undefined,
        ca: monitor.tlsCa || undefined,
      },
    })
    agent = mtlsAgent
    cleanup = async () => {
      await mtlsAgent.close()
    }
  } else {
    agent = baseAgent(Boolean(monitor.ignoreTls))
  }
  const maxRedirections = monitor.maxRedirects ?? 10
  const dispatcher: Dispatcher =
    maxRedirections > 0 ? agent.compose(interceptors.redirect({ maxRedirections })) : agent

  return {
    url: monitor.url,
    options: {
      method: (monitor.method ?? 'GET') as Dispatcher.HttpMethod,
      headers,
      body,
      signal,
      dispatcher,
    },
    cleanup,
  }
}

/**
 * Perform the HTTP request of an http/keyword/json-query monitor. Resolves when the status code is
 * accepted, throws `"<status> - <text>"` otherwise.
 */
export async function performHttpCheck(ctx: MonitorCheckContext): Promise<HttpCheckResponse> {
  const proxy = await loadMonitorProxy(ctx.payload, ctx.monitor)
  const { url, options, cleanup } = await buildHttpRequest(ctx.monitor, ctx.signal, { proxy })
  const startTime = Date.now()
  try {
    const res = await request(url, options)
    const body = await res.body.text()
    const ping = Date.now() - startTime
    const statusText = STATUS_CODES[res.statusCode] ?? ''
    const response: HttpCheckResponse = {
      statusCode: res.statusCode,
      statusText,
      headers: res.headers,
      body,
      ping,
    }
    ctx.heartbeat.ping = ping
    if (!checkStatusCode(res.statusCode, ctx.monitor.acceptedStatusCodes ?? ['200-299'])) {
      throw new Error(`${res.statusCode} - ${statusText}`)
    }
    ctx.heartbeat.msg = `${res.statusCode} - ${statusText}`
    return response
  } finally {
    await cleanup()
  }
}
