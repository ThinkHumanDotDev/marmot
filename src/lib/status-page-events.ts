/**
 * Public events of a status page (issue #107): incidents and maintenance windows as the history
 * page and their permalinks see them. Shared by server code and client components, so it imports
 * nothing server-only.
 *
 * Every incident and maintenance occurrence has a `publicId`: 8 characters of base36, random for
 * new documents (`randomPublicId`), stable forever, and never the database id. Permalinks are
 * `<page>/events/incident/<publicId>` and `<page>/events/maintenance/<publicId>`, where `<page>`
 * is `/status/<slug>` on Marmot's own host and the root on the page's custom domains.
 */

export const PUBLIC_ID_LENGTH = 8
export const PUBLIC_ID_PATTERN = /^[0-9a-z]{8}$/

export const isPublicId = (value: unknown): value is string =>
  typeof value === 'string' && PUBLIC_ID_PATTERN.test(value)

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** 8 random base36 characters (rejection sampling keeps every character equally likely). */
export function randomPublicId(): string {
  let out = ''
  while (out.length < PUBLIC_ID_LENGTH) {
    for (const byte of globalThis.crypto.getRandomValues(new Uint8Array(16))) {
      // 252 = 7 × 36: bytes above it would favour the first characters.
      if (byte < 252 && out.length < PUBLIC_ID_LENGTH) out += ALPHABET[byte % 36]
    }
  }
  return out
}

export const EVENT_KINDS = ['incident', 'maintenance'] as const
export type EventKind = (typeof EVENT_KINDS)[number]

export const isEventKind = (value: unknown): value is EventKind =>
  (EVENT_KINDS as readonly unknown[]).includes(value)

/** Path of the history page relative to the page's base path. */
export const EVENTS_PATH = '/events'

/** Path of an event's permalink relative to the page's base path (`/events/incident/k3x9…`). */
export const eventPath = (kind: EventKind, publicId: string): string =>
  `${EVENTS_PATH}/${kind}/${publicId}`

/**
 * Paths below a status page that the login form may return to after signing in (`?next=`):
 * the history page and permalinks. Anything else returns to the page itself.
 */
export function isEventsReturnPath(value: unknown): value is string {
  if (typeof value !== 'string') return false
  return value === EVENTS_PATH || /^\/events\/(incident|maintenance)\/[0-9a-z]{8}$/.test(value)
}

/** `YYYY-MM`, the month filter of the history page. */
export const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/

/** Events per history page. */
export const EVENTS_PER_PAGE = 20

/** Default and maximum of `status-pages.pastIncidentsDays`. */
export const DEFAULT_PAST_INCIDENTS_DAYS = 7
export const MAX_PAST_INCIDENTS_DAYS = 90

export interface EventFilters {
  type: EventKind | null
  /** Component id (a group row id of the page). */
  component: string | null
  /** `YYYY-MM` in the page's time zone. */
  month: string | null
  /** 1-based. */
  page: number
}

type ParamSource =
  URLSearchParams | Record<string, string | string[] | undefined> | null | undefined

const param = (source: ParamSource, name: string): string | null => {
  if (!source) return null
  const value =
    source instanceof URLSearchParams ? source.get(name) : (source as Record<string, unknown>)[name]
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' && first.trim() ? first.trim() : null
}

/** History filters from a query string; unknown or malformed values are ignored. */
export function parseEventFilters(source: ParamSource): EventFilters {
  const type = param(source, 'type')
  const component = param(source, 'component')
  const month = param(source, 'month')
  const page = Number.parseInt(param(source, 'page') ?? '1', 10)
  return {
    type: isEventKind(type) ? type : null,
    component: component && /^[\w-]{1,64}$/.test(component) ? component : null,
    month: month && MONTH_PATTERN.test(month) ? month : null,
    page: Number.isFinite(page) && page >= 1 ? Math.min(page, 10_000) : 1,
  }
}

/** Query string of `filters` (without the leading `?`), dropping defaults. */
export function eventFiltersQuery(filters: Partial<EventFilters>): string {
  const params = new URLSearchParams()
  if (filters.type) params.set('type', filters.type)
  if (filters.component) params.set('component', filters.component)
  if (filters.month) params.set('month', filters.month)
  if (filters.page && filters.page > 1) params.set('page', String(filters.page))
  return params.toString()
}
