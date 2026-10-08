/**
 * Collector headers (#99): API keys and tokens of an OTLP backend. They are sealed at rest with a
 * key derived from `PAYLOAD_SECRET` (AES-256-GCM, `src/auth/two-factor/crypto.ts`, the same scheme
 * as single sign-on client secrets), never readable through the API (only their names are) and
 * redacted in the audit log (`headers` is a secret key name, `src/server/audit/diff.ts`).
 */
import { decryptSecret, encryptSecret } from '@/auth/two-factor/crypto'
import { env } from '@/env'
import {
  OTEL_HEADER_NAME_PATTERN,
  OTEL_HEADER_VALUE_MAX_LENGTH,
  OTEL_MAX_HEADERS,
  OTEL_RESERVED_HEADERS,
} from '@/lib/otel'
import type { ErrorKey, ErrorValues } from '@/server/errors'

const PURPOSE = 'marmot:otel-collector-headers'

export type OtelHeaders = Record<string, string>

/** A header as the API receives it; `value: null` keeps the stored value of that name. */
export interface OtelHeaderInput {
  name: string
  value: string | null
}

export const sealHeaders = (headers: OtelHeaders): string | null =>
  Object.keys(headers).length === 0
    ? null
    : encryptSecret(JSON.stringify(headers), env.PAYLOAD_SECRET, PURPOSE)

/** The stored headers, or `{}` when unset or sealed with another `PAYLOAD_SECRET`. */
export function openHeaders(sealed: string | null | undefined): OtelHeaders {
  const plain = decryptSecret(sealed, env.PAYLOAD_SECRET, PURPOSE)
  if (!plain) return {}
  try {
    const parsed = JSON.parse(plain) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => {
        return typeof entry[1] === 'string'
      }),
    )
  } catch {
    return {}
  }
}

export function headersProblem(
  input: readonly OtelHeaderInput[],
): { key: ErrorKey; values?: ErrorValues } | null {
  if (input.length > OTEL_MAX_HEADERS) {
    return { key: 'otelHeadersTooMany', values: { max: OTEL_MAX_HEADERS } }
  }
  const seen = new Set<string>()
  for (const header of input) {
    const name = header.name.trim()
    if (!OTEL_HEADER_NAME_PATTERN.test(name)) {
      return { key: 'otelHeaderNameInvalid', values: { name } }
    }
    const lower = name.toLowerCase()
    if (OTEL_RESERVED_HEADERS.has(lower)) return { key: 'otelHeaderReserved', values: { name } }
    if (seen.has(lower)) return { key: 'otelHeaderDuplicate', values: { name } }
    seen.add(lower)
    if (
      header.value !== null &&
      (header.value.length > OTEL_HEADER_VALUE_MAX_LENGTH || /[\r\n\0]/.test(header.value))
    ) {
      return { key: 'otelHeaderValueInvalid', values: { name } }
    }
  }
  return null
}

/**
 * The headers to store: `input` replaces the whole set; an entry without a value keeps the value
 * stored under that name (case-insensitively), and is dropped when there is none.
 */
export function mergeHeaders(input: readonly OtelHeaderInput[], stored: OtelHeaders): OtelHeaders {
  const previous = new Map(Object.entries(stored).map(([k, v]) => [k.toLowerCase(), v]))
  const next: OtelHeaders = {}
  for (const header of input) {
    const name = header.name.trim()
    const value = header.value ?? previous.get(name.toLowerCase())
    if (value !== undefined) next[name] = value
  }
  return next
}
