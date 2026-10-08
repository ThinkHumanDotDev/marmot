/**
 * Per-check response log (#97): what a check stores about the response it received and how the
 * log is filtered. Shared by the worker (capture limits), the API (`/monitors/:id/logs`) and the UI,
 * so it must stay free of Node-only imports.
 */
import { z } from 'zod'

/** Upper bound of the response headers stored per check (names + values, UTF-8 bytes). */
export const RESPONSE_HEADERS_LIMIT_BYTES = 8 * 1024
/** Upper bound of the response body stored for a failed or degraded check (UTF-8 bytes). */
export const RESPONSE_BODY_LIMIT_BYTES = 16 * 1024

/** Beat statuses whose response body is kept: failed (DOWN, PENDING retries) and degraded checks. */
export const BODY_STATUSES = ['down', 'pending', 'degraded'] as const

/** Placeholder stored instead of a secret (cookies, credentials echoed by the target). */
export const REDACTED = '[redacted]'

export const LOG_STATUSES = ['up', 'down', 'pending', 'maintenance', 'degraded'] as const
export type LogStatus = (typeof LOG_STATUSES)[number]

/** What started a check. Heartbeats leave `trigger` empty for scheduled checks (and pushes). */
export const LOG_TRIGGERS = ['schedule', 'manual'] as const
export type LogTrigger = (typeof LOG_TRIGGERS)[number]

export const LOG_PAGE_SIZE = 50
export const LOG_MAX_PAGE_SIZE = 200

/** `503`, or a class such as `5xx`. */
const STATUS_CODE = /^([1-5])(xx|\d\d)$/i

const dateParam = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'invalid date')

export const responseLogFiltersSchema = z.object({
  /** One status or a comma-separated list (`down,pending`). */
  status: z
    .string()
    .trim()
    .transform((value) => value.split(',').map((part) => part.trim().toLowerCase()))
    .pipe(z.array(z.enum(LOG_STATUSES)).min(1))
    .optional(),
  /** Exact HTTP status code (`503`) or a class (`5xx`). */
  statusCode: z.string().trim().regex(STATUS_CODE, 'expected e.g. 503 or 5xx').optional(),
  trigger: z.enum(LOG_TRIGGERS).optional(),
  /** Inclusive start (ISO instant). */
  from: dateParam.optional(),
  /** Inclusive end (ISO instant). */
  to: dateParam.optional(),
  /** Checks of one location (#92): a location id, or `local` for this server's workers. */
  location: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{1,64}$/, 'expected a location id or "local"')
    .optional(),
})

export type ResponseLogFilters = z.infer<typeof responseLogFiltersSchema>
/** Filters as they travel in the query string (`status` comma-separated). */
export type ResponseLogQuery = Partial<Record<keyof ResponseLogFilters, string>>

/** `5xx` → `[500, 599]`, `503` → `[503, 503]`. */
export function statusCodeRange(value: string): [number, number] | null {
  const match = STATUS_CODE.exec(value.trim())
  if (!match) return null
  if (match[2]!.toLowerCase() === 'xx') {
    const base = Number(match[1]) * 100
    return [base, base + 99]
  }
  const code = Number(value)
  return [code, code]
}

/** Response data stored on a heartbeat (`heartbeats.response`). */
export interface StoredResponse {
  /** Response headers, lower-case names, in the order received; cookies redacted. */
  headers: Record<string, string> | null
  /** Some headers were left out to stay under `RESPONSE_HEADERS_LIMIT_BYTES`. */
  headersTruncated: boolean
  /** First `RESPONSE_BODY_LIMIT_BYTES` of the body (failed and degraded checks only). */
  body: string | null
  /** The body was longer than what is stored. */
  bodyTruncated: boolean
}

/** One row of the log list (`GET …/logs`). */
export interface ResponseLogEntry {
  id: string
  time: string
  status: LogStatus
  msg: string | null
  ping: number | null
  statusCode: number | null
  trigger: LogTrigger
  important: boolean
  /** Assertion counts of the check; `null` when the type evaluates none. */
  assertions: { passed: number; failed: number } | null
  /** Location that ran the check (#91): its id, or `local` for this server's workers. */
  location: string
  /** Multi-location monitors (#92): the location's own status; `status` is the quorum. */
  locationStatus: LogStatus | null
}

export interface ResponseLogPage {
  docs: ResponseLogEntry[]
  /** Pass as `cursor` to get the next (older) page; `null` on the last page. */
  nextCursor: string | null
}

/** One check in full (`GET …/logs/:heartbeatId`). */
export interface ResponseLogDetail extends ResponseLogEntry {
  duration: number | null
  retries: number | null
  /** Request timing phases (`heartbeats.timing`), `null` when not measured. */
  timing: Record<string, number | null> | null
  /** Per-assertion results (`heartbeats.assertions`). */
  assertionResults: unknown[]
  /** Per-probe results of a multi-location check (`heartbeats.probes`). */
  probes: unknown[]
  response: StoredResponse | null
}

/** Query string for the list API (empty values left out). */
export function responseLogQuery(
  filters: ResponseLogQuery,
  extra: Record<string, string | undefined> = {},
): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries({ ...filters, ...extra })) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const query = params.toString()
  return query ? `?${query}` : ''
}
