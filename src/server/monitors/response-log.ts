/**
 * Per-check response log of a monitor (#97): filter parsing, the Payload `where`, cursor paging and
 * the row shapes of `GET /api/orgs/:orgId/monitors/:id/logs` and `…/logs/:heartbeatId`.
 *
 * Callers load the monitor as the requesting user first (`loadOrgMonitor`), which settles access and
 * organization; heartbeats are then read with the Local API scoped to that monitor.
 *
 * Paging is by cursor, newest first: the cursor holds the time of the last row returned and the ids
 * returned at exactly that time, so the next page is `time < t OR (time = t AND id NOT IN ids)`. It
 * needs no ordering on ids (ObjectIds and serials compare differently) and survives new beats
 * arriving between pages.
 */
import type { Payload, Where } from 'payload'

import { parseAssertionResults } from '@/lib/assertion-results'
import { parseRequestTiming } from '@/lib/request-timing'
import {
  LOG_MAX_PAGE_SIZE,
  LOG_PAGE_SIZE,
  responseLogFiltersSchema,
  statusCodeRange,
  type LogTrigger,
  type ResponseLogDetail,
  type ResponseLogEntry,
  type ResponseLogFilters,
  type ResponseLogPage,
  type StoredResponse,
} from '@/lib/response-log'
import type { Heartbeat } from '@/payload-types'

type Id = string | number

/** Filters from a query string; empty parameters are ignored. */
export function parseResponseLogFilters(
  params: URLSearchParams,
): { ok: true; filters: ResponseLogFilters } | { ok: false; error: string } {
  const raw: Record<string, string> = {}
  for (const key of Object.keys(responseLogFiltersSchema.shape)) {
    const value = params.get(key)
    if (value !== null && value.trim() !== '') raw[key] = value
  }
  const parsed = responseLogFiltersSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, error: `${issue?.path.join('.') || 'query'}: ${issue?.message ?? ''}` }
  }
  return { ok: true, filters: parsed.data }
}

/** Rows sharing one timestamp a cursor can skip; far above anything a real monitor produces. */
const MAX_CURSOR_IDS = 1000

export interface Cursor {
  /** ISO time of the last row returned. */
  t: string
  /** Ids returned at exactly that time. */
  ids: string[]
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/** `null` for anything that is not a cursor this module produced. */
export function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<Cursor>
    if (typeof parsed.t !== 'string' || Number.isNaN(Date.parse(parsed.t))) return null
    if (!Array.isArray(parsed.ids) || parsed.ids.length > MAX_CURSOR_IDS) return null
    if (!parsed.ids.every((id) => typeof id === 'string' && id.length <= 64)) return null
    return { t: parsed.t, ids: parsed.ids }
  } catch {
    return null
  }
}

/** Payload `where` for one monitor's log. */
export function responseLogWhere(
  payload: Payload,
  monitorId: Id,
  filters: ResponseLogFilters,
  cursor: Cursor | null = null,
): Where {
  const and: Where[] = [{ monitor: { equals: monitorId } }]
  if (filters.status?.length) {
    and.push(
      filters.status.length === 1
        ? { status: { equals: filters.status[0] } }
        : { status: { in: filters.status } },
    )
  }
  if (filters.statusCode) {
    const range = statusCodeRange(filters.statusCode)
    if (range) {
      and.push(
        range[0] === range[1]
          ? { statusCode: { equals: range[0] } }
          : {
              and: [
                { statusCode: { greater_than_equal: range[0] } },
                { statusCode: { less_than_equal: range[1] } },
              ],
            },
      )
    }
  }
  if (filters.trigger === 'manual') and.push({ trigger: { equals: 'manual' } })
  // Scheduled checks leave `trigger` empty; `not_equals` matches empty values on every adapter.
  if (filters.trigger === 'schedule') and.push({ trigger: { not_equals: 'manual' } })
  if (filters.from) and.push({ time: { greater_than_equal: new Date(filters.from).toISOString() } })
  if (filters.to) and.push({ time: { less_than_equal: new Date(filters.to).toISOString() } })
  // #92 (multi-location checks): `if (filters.location) and.push({ location: { equals: … } })`.
  if (cursor) {
    const at = new Date(cursor.t).toISOString()
    const ids = cursor.ids.map((id) => toId(payload, id))
    and.push({
      or: [
        { time: { less_than: at } },
        {
          and: [
            { time: { equals: at } },
            ...(ids.length ? [{ id: { not_in: ids } } satisfies Where] : []),
          ],
        },
      ],
    })
  }
  return { and }
}

/** Postgres/SQLite ids are numbers, MongoDB ids strings. */
const toId = (payload: Payload, raw: string): Id =>
  payload.db.defaultIDType === 'number' && /^\d+$/.test(raw) ? Number(raw) : raw

const triggerOf = (heartbeat: Pick<Heartbeat, 'trigger'>): LogTrigger =>
  heartbeat.trigger === 'manual' ? 'manual' : 'schedule'

function assertionCounts(value: unknown): ResponseLogEntry['assertions'] {
  const results = parseAssertionResults(value)
  if (results.length === 0) return null
  const passed = results.filter((result) => result.passed).length
  return { passed, failed: results.length - passed }
}

export function toResponseLogEntry(heartbeat: Heartbeat): ResponseLogEntry {
  return {
    id: String(heartbeat.id),
    time: new Date(heartbeat.time).toISOString(),
    status: heartbeat.status,
    msg: heartbeat.msg ?? null,
    ping: typeof heartbeat.ping === 'number' ? heartbeat.ping : null,
    statusCode: typeof heartbeat.statusCode === 'number' ? heartbeat.statusCode : null,
    trigger: triggerOf(heartbeat),
    important: Boolean(heartbeat.important),
    assertions: assertionCounts(heartbeat.assertions),
  }
}

function storedResponse(value: Heartbeat['response']): StoredResponse | null {
  if (!value) return null
  const headers =
    value.headers && typeof value.headers === 'object' && !Array.isArray(value.headers)
      ? Object.fromEntries(
          Object.entries(value.headers as Record<string, unknown>).map(([name, v]) => [
            name,
            String(v),
          ]),
        )
      : null
  const body = typeof value.body === 'string' ? value.body : null
  if (!headers && body === null) return null
  return {
    headers,
    headersTruncated: Boolean(value.headersTruncated),
    body,
    bodyTruncated: Boolean(value.bodyTruncated),
  }
}

export function toResponseLogDetail(heartbeat: Heartbeat): ResponseLogDetail {
  return {
    ...toResponseLogEntry(heartbeat),
    duration: typeof heartbeat.duration === 'number' ? heartbeat.duration : null,
    retries: typeof heartbeat.retries === 'number' ? heartbeat.retries : null,
    timing: parseRequestTiming(heartbeat.timing),
    assertionResults: parseAssertionResults(heartbeat.assertions),
    probes: Array.isArray(heartbeat.probes) ? (heartbeat.probes as unknown[]) : [],
    response: storedResponse(heartbeat.response),
  }
}

/** Fields of a list row; the response headers and body are left for the detail. */
const LIST_SELECT = {
  status: true,
  msg: true,
  ping: true,
  statusCode: true,
  trigger: true,
  important: true,
  assertions: true,
  time: true,
} as const

/** One page of a monitor's log, newest first. */
export async function listResponseLog(
  payload: Payload,
  monitorId: Id,
  filters: ResponseLogFilters,
  { cursor = null, limit = LOG_PAGE_SIZE }: { cursor?: Cursor | null; limit?: number } = {},
): Promise<ResponseLogPage> {
  const size = Math.min(Math.max(1, Math.trunc(limit) || LOG_PAGE_SIZE), LOG_MAX_PAGE_SIZE)
  const decoded = cursor
  const { docs } = await payload.find({
    collection: 'heartbeats',
    where: responseLogWhere(payload, monitorId, filters, decoded),
    sort: '-time',
    limit: size + 1,
    pagination: false,
    depth: 0,
    overrideAccess: true,
    select: LIST_SELECT,
  })
  const rows = (docs as Heartbeat[]).slice(0, size).map(toResponseLogEntry)
  let nextCursor: string | null = null
  if (docs.length > size && rows.length > 0) {
    const last = rows[rows.length - 1]!.time
    const atLast = rows.filter((row) => row.time === last).map((row) => row.id)
    // Rows at the same time on an earlier page are excluded as well.
    const carried = decoded && decoded.t === last ? decoded.ids : []
    nextCursor = encodeCursor({
      t: last,
      ids: [...new Set([...carried, ...atLast])].slice(-MAX_CURSOR_IDS),
    })
  }
  return { docs: rows, nextCursor }
}

/** One heartbeat of the monitor in full, or `null` when it is not this monitor's. */
export async function getResponseLogEntry(
  payload: Payload,
  monitorId: Id,
  heartbeatId: Id,
): Promise<ResponseLogDetail | null> {
  const { docs } = await payload.find({
    collection: 'heartbeats',
    where: { and: [{ id: { equals: heartbeatId } }, { monitor: { equals: monitorId } }] },
    limit: 1,
    pagination: false,
    depth: 0,
    overrideAccess: true,
  })
  const heartbeat = docs[0] as Heartbeat | undefined
  return heartbeat ? toResponseLogDetail(heartbeat) : null
}
