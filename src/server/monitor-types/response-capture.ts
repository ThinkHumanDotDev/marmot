/**
 * Response capture for the per-check log (#97). Only response data is kept: request headers are
 * never stored, cookies the target sets are redacted, and every credential the check sent
 * (authorization, custom header values, basic auth password, bearer token, OAuth secret, URL
 * password) is scrubbed from the stored headers and body in case the target echoes the request.
 *
 * The headers are capped at `RESPONSE_HEADERS_LIMIT_BYTES`; the body is cut to
 * `RESPONSE_BODY_LIMIT_BYTES` here and only persisted for failed or degraded beats (`recordBeat`).
 */
import {
  REDACTED,
  RESPONSE_BODY_LIMIT_BYTES,
  RESPONSE_HEADERS_LIMIT_BYTES,
  type StoredResponse,
} from '@/lib/response-log'
import type { Monitor } from '@/payload-types'

/** Response headers whose value is a credential of the session with the target. */
const SECRET_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'set-cookie2',
  'cookie',
  'authorization',
  'proxy-authorization',
])

/** Request headers that never carry a secret; every other request header value is scrubbed. */
const PUBLIC_REQUEST_HEADERS = new Set(['accept', 'content-type', 'user-agent', 'content-length'])

/** Shorter values are not scrubbed: they would match ordinary text. */
const MIN_SECRET_LENGTH = 4

/** Response captured by an HTTP check, before the beat decides whether the body is kept. */
export interface CapturedResponse extends StoredResponse {
  statusCode: number
}

const encoder = new TextEncoder()
const byteLength = (value: string) => encoder.encode(value).length

/** Postgres rejects NUL in text and JSON columns. */
const stripNul = (value: string) => value.replace(/\u0000/g, '�')

/** The first `limit` UTF-8 bytes of `value`, without splitting a character. */
export function truncateUtf8(value: string, limit: number): { text: string; truncated: boolean } {
  const bytes = encoder.encode(value)
  if (bytes.length <= limit) return { text: value, truncated: false }
  let end = limit
  // Step back over continuation bytes (10xxxxxx) so the cut lands on a character boundary.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true }
}

/**
 * Secrets the check sent with its request: every request header value except the harmless ones
 * (and the credential part of `Bearer xyz`), plus the monitor's own credentials.
 */
export function requestSecrets(
  requestHeaders: Record<string, string> | undefined,
  monitor: Pick<
    Monitor,
    'basicAuthPass' | 'bearerToken' | 'oauthClientSecret' | 'url'
  > | null = null,
): string[] {
  const secrets = new Set<string>()
  const add = (value: string | null | undefined) => {
    const trimmed = value?.trim()
    if (trimmed && trimmed.length >= MIN_SECRET_LENGTH) secrets.add(trimmed)
  }
  for (const [name, value] of Object.entries(requestHeaders ?? {})) {
    if (PUBLIC_REQUEST_HEADERS.has(name.toLowerCase())) continue
    add(value)
    const space = value.indexOf(' ')
    if (space > 0) add(value.slice(space + 1))
  }
  add(monitor?.basicAuthPass)
  add(monitor?.bearerToken)
  add(monitor?.oauthClientSecret)
  if (monitor?.url) {
    try {
      add(decodeURIComponent(new URL(monitor.url).password))
    } catch {
      // Not a URL: nothing to scrub.
    }
  }
  // Longest first, so a token inside a longer header value is replaced as a whole.
  return [...secrets].sort((a, b) => b.length - a.length)
}

function scrub(value: string, secrets: readonly string[]): string {
  let out = value
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED)
  }
  return out
}

/**
 * Capped, scrubbed copy of a response for the heartbeat. Headers keep their order until the next
 * one would exceed the limit; multi-value headers are joined with `, `.
 */
export function captureResponse(
  response: {
    statusCode: number
    headers: Record<string, string | string[] | undefined>
    body: string
  },
  secrets: readonly string[] = [],
): CapturedResponse {
  const headers: Record<string, string> = {}
  let headerBytes = 0
  let headersTruncated = false
  for (const [rawName, rawValue] of Object.entries(response.headers)) {
    if (rawValue === undefined) continue
    const name = rawName.toLowerCase()
    const value = SECRET_RESPONSE_HEADERS.has(name)
      ? REDACTED
      : stripNul(scrub(Array.isArray(rawValue) ? rawValue.join(', ') : rawValue, secrets))
    const size = byteLength(name) + byteLength(value) + 4 // `: ` and CRLF, as on the wire
    if (headerBytes + size > RESPONSE_HEADERS_LIMIT_BYTES) {
      headersTruncated = true
      continue
    }
    headers[name] = value
    headerBytes += size
  }

  // Scrub before cutting, so a secret straddling the limit cannot survive half-cut.
  const { text, truncated } = truncateUtf8(scrub(response.body, secrets), RESPONSE_BODY_LIMIT_BYTES)
  return {
    statusCode: response.statusCode,
    headers,
    headersTruncated,
    body: stripNul(text),
    bodyTruncated: truncated,
  }
}
