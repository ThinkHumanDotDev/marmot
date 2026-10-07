/**
 * Shared helpers for HTTP-based providers. Error formatting is a port of
 * `NotificationProvider.throwGeneralAxiosError` from Uptime Kuma 2.5.5
 * `server/notification-providers/notification-provider.js` (MIT, Louis Lam). See THIRD_PARTY_NOTICES.md.
 *
 * Providers call the global `fetch` so tests can stub `globalThis.fetch`. With the outbound address
 * guard on (`MONITOR_DENY_PRIVATE_ADDRESSES`, `MONITOR_DENY_CIDRS`), requests go through
 * `guardedFetch`, which vets every connection and redirect hop after DNS resolution.
 */
import type { Monitor } from '@/payload-types'
import { findBlockedMessage, guardedFetch } from '@/server/security/outbound-guard'

export const OK_MESSAGE = 'Sent Successfully.'

const REQUEST_TIMEOUT_MS = 30_000

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH'
  headers?: Record<string, string>
  /** Serialised as JSON unless `rawBody` is set. */
  json?: unknown
  /** Sent as-is (string or FormData/URLSearchParams). */
  rawBody?: BodyInit
  signal?: AbortSignal
}

/** Trim a response body for error messages. */
const snippet = (text: string, max = 200) => (text.length > max ? `${text.slice(0, max)}…` : text)

/**
 * Perform a request and throw a readable error on network failures or non-2xx responses.
 * Returns the response for callers that need the body.
 */
export async function httpRequest(
  url: string,
  options: HttpRequestOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  let body: BodyInit | undefined = options.rawBody
  if (options.json !== undefined) {
    headers['Content-Type'] ??= 'application/json'
    body = JSON.stringify(options.json)
  }

  let response: Response
  try {
    response = await guardedFetch(url, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body,
      redirect: 'follow',
      signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(describeNetworkError(error))
  }

  if (!response.ok) {
    let text = ''
    try {
      text = await response.text()
    } catch {
      // ignore unreadable bodies
    }
    const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
    throw new Error(`Request failed (${status})${text ? ` ${snippet(text)}` : ''}`)
  }

  return response
}

/** POST a JSON body and discard the response. */
export async function postJson(
  url: string,
  json: unknown,
  headers?: Record<string, string>,
): Promise<void> {
  await httpRequest(url, { method: 'POST', json, headers })
}

/** Expand `fetch` failures (which hide the cause behind "fetch failed") into something actionable. */
export function describeNetworkError(error: unknown): string {
  const blocked = findBlockedMessage(error)
  if (blocked) return blocked
  if (!(error instanceof Error)) return String(error)
  let msg = error.message
  const code = (error as { code?: string }).code
  if (code) msg += ` (code=${code})`

  const cause = (error as { cause?: unknown }).cause
  if (cause instanceof AggregateError && Array.isArray(cause.errors)) {
    const causes = cause.errors
      .map((e: unknown) => {
        const m = e instanceof Error ? e.message : String(e)
        const c = (e as { code?: string })?.code
        return c ? `${m} (code=${c})` : m
      })
      .join('; ')
    msg += ` - caused by: ${causes}`
  } else if (cause instanceof Error) {
    const c = (cause as { code?: string }).code
    msg += ` - cause: ${cause.message}${c ? ` (code=${c})` : ''}`
  }
  return msg
}

/**
 * The address a monitor watches, for display in messages. Port of `extractAddress`.
 */
export function extractAddress(monitor: Monitor | null): string {
  if (!monitor) return ''
  switch (monitor.type) {
    case 'push':
      return 'Heartbeat'
    case 'ping':
    case 'dns':
      return monitor.hostname ?? ''
    case 'port':
      return monitor.port ? `${monitor.hostname ?? ''}:${monitor.port}` : (monitor.hostname ?? '')
    default: {
      const url = monitor.url ?? ''
      return ['https://', 'http://', ''].includes(url) ? '' : url
    }
  }
}

/** Strip a trailing slash from a base URL. */
export const trimSlash = (url: string) => url.replace(/\/+$/, '')

/** Parse a JSON object of extra headers; throws a readable error. */
export function parseHeadersJson(
  value: unknown,
  what = 'Additional headers',
): Record<string, string> {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value !== 'string') throw new Error(`${what} must be a JSON object`)
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`${what} is not valid JSON`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${what} must be a JSON object`)
  }
  const headers: Record<string, string> = {}
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    headers[key] = String(val)
  }
  return headers
}
