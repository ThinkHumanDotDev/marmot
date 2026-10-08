/**
 * Search and filters of the monitor list (#124). Pure and client-safe: the list page parses the
 * URL with it on the server (so the first render is already filtered) and the client island applies
 * it to the live store on every change.
 *
 * - **Search** (`q`) matches every whitespace-separated term against the name, target (URL or
 *   hostname) and description, ignoring case and accents; a term of three or more characters also
 *   matches the name fuzzily (its letters in order, `chkapi` → `Checkout API`). The search box also
 *   understands filter tokens: `status:down`, `type:http`, `tag:prod`, `location:berlin`.
 * - **Filters** (`status`, `type`, `tag`, `notification`, `location`) hold ids or slugs. Values of
 *   one filter are alternatives (OR); different filters and tokens must all match (AND).
 *
 * Everything round-trips through the query string (`?q=api&status=down,degraded&tag=12`), so a
 * filtered view can be bookmarked and shared.
 */
import { monitorLocationKeys, LOCAL_LOCATION } from './probe-locations'

/** Status filter values: the live statuses plus `paused` (inactive monitors). */
export const STATUS_FILTERS = [
  'up',
  'down',
  'pending',
  'degraded',
  'maintenance',
  'paused',
] as const
export type StatusFilter = (typeof STATUS_FILTERS)[number]

/** List-valued filters, in the order the toolbar shows them. */
export const FILTER_KEYS = ['status', 'type', 'tag', 'notification', 'location'] as const
export type FilterKey = (typeof FILTER_KEYS)[number]

export interface MonitorFilters {
  q: string
  status: StatusFilter[]
  type: string[]
  tag: string[]
  notification: string[]
  location: string[]
}

export const EMPTY_FILTERS: MonitorFilters = Object.freeze({
  q: '',
  status: [],
  type: [],
  tag: [],
  notification: [],
  location: [],
}) as MonitorFilters

/** Longest search text kept from the URL. */
export const MAX_QUERY_LENGTH = 200
/** Most values kept per filter from the URL. */
const MAX_FILTER_VALUES = 50

const isStatusFilter = (value: string): value is StatusFilter =>
  (STATUS_FILTERS as readonly string[]).includes(value)

type ParamSource =
  URLSearchParams | Record<string, string | string[] | undefined> | null | undefined

function readParam(source: ParamSource, key: string): string[] {
  if (!source) return []
  if (source instanceof URLSearchParams) return source.getAll(key)
  const value = source[key]
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

/** Comma-separated (`status=down,up`) or repeated (`status=down&status=up`) values, de-duplicated. */
function readList(source: ParamSource, key: string): string[] {
  const values = readParam(source, key)
    .flatMap((raw) => raw.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= 100)
  return [...new Set(values)].slice(0, MAX_FILTER_VALUES)
}

/** Filters from a query string (`useSearchParams()`) or Next.js `searchParams`. Unknown values are dropped. */
export function parseMonitorFilters(source: ParamSource): MonitorFilters {
  const q = (readParam(source, 'q')[0] ?? '').slice(0, MAX_QUERY_LENGTH)
  return {
    q,
    status: readList(source, 'status').filter(isStatusFilter),
    type: readList(source, 'type'),
    tag: readList(source, 'tag'),
    notification: readList(source, 'notification'),
    location: readList(source, 'location'),
  }
}

/** Query string of `filters`, without empty filters, keys in a stable order. */
export function serializeMonitorFilters(filters: MonitorFilters): URLSearchParams {
  const params = new URLSearchParams()
  const q = filters.q.trim()
  if (q) params.set('q', q)
  for (const key of FILTER_KEYS) {
    const values = filters[key]
    if (values.length > 0) params.set(key, values.join(','))
  }
  return params
}

/** Number of list filters with a value (the search text not included). */
export const activeFilterCount = (filters: MonitorFilters): number =>
  FILTER_KEYS.reduce((n, key) => n + (filters[key].length > 0 ? 1 : 0), 0)

export const hasActiveFilters = (filters: MonitorFilters): boolean =>
  filters.q.trim() !== '' || activeFilterCount(filters) > 0

// ---- Search text ---------------------------------------------------------------------------

/** Keys the search box accepts as `key:value` tokens. `is:` is an alias of `status:`. */
const TOKEN_KEYS: Record<string, 'status' | 'type' | 'tag' | 'location'> = {
  status: 'status',
  is: 'status',
  type: 'type',
  tag: 'tag',
  location: 'location',
  loc: 'location',
}

export interface ParsedSearch {
  /** Free-text terms, normalised (lower case, no accents). */
  terms: string[]
  /** `key:value` tokens by filter, normalised. */
  tokens: { status: string[]; type: string[]; tag: string[]; location: string[] }
}

/** Lower case without diacritics, for accent- and case-insensitive matching. */
export function normalizeText(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** Splits the search text into terms and filter tokens (`"status:down api"`). */
export function parseSearchQuery(q: string): ParsedSearch {
  const parsed: ParsedSearch = {
    terms: [],
    tokens: { status: [], type: [], tag: [], location: [] },
  }
  for (const word of normalizeText(q).split(/\s+/)) {
    if (!word) continue
    const colon = word.indexOf(':')
    if (colon > 0 && colon < word.length - 1) {
      const key = TOKEN_KEYS[word.slice(0, colon)]
      if (key) {
        parsed.tokens[key].push(word.slice(colon + 1))
        continue
      }
    }
    parsed.terms.push(word)
  }
  return parsed
}

/** `true` when the characters of `needle` appear in `haystack` in order. */
export function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++
  }
  return i === needle.length
}

/** Minimum term length for the fuzzy (in-order letters) name match. */
export const FUZZY_MIN_LENGTH = 3

// ---- Matching ------------------------------------------------------------------------------

/** The slice of a monitor (`MonitorSummary` in the store) the filters look at. */
export interface FilterableMonitor {
  name: string
  type: string
  active: boolean
  url?: string | null
  hostname?: string | null
  description?: string | null
  tags?: { id?: string; name: string; value?: string | null }[]
  notifications?: readonly string[]
  locations?: readonly string[]
  includeLocal?: boolean
}

/** Live status key of the store (`statusKey`): `unknown` when there is no heartbeat yet. */
export type LiveStatus = 'up' | 'down' | 'pending' | 'maintenance' | 'degraded' | 'unknown'

/** Status filter value of a monitor: `paused` when inactive, else its live status (none when unknown). */
export function statusFilterOf(active: boolean, live: LiveStatus): StatusFilter | null {
  if (!active) return 'paused'
  return live === 'unknown' ? null : live
}

export interface FilterLookups {
  /** Location names by id, for `location:<name>` tokens. */
  locationNames?: Readonly<Record<string, string>>
}

const anyOverlap = (wanted: readonly string[], have: readonly string[]) =>
  wanted.some((value) => have.includes(value))

function matchesTerms(monitor: FilterableMonitor, terms: string[]): boolean {
  if (terms.length === 0) return true
  const name = normalizeText(monitor.name)
  const haystack = [name, monitor.url, monitor.hostname, monitor.description]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .map(normalizeText)
    .join('\n')
  const compactName = name.replace(/\s+/g, '')
  return terms.every(
    (term) =>
      haystack.includes(term) ||
      (term.length >= FUZZY_MIN_LENGTH && isSubsequence(term, compactName)),
  )
}

/** Does `monitor`, whose live status is `live`, pass `filters`? */
export function matchesMonitorFilters(
  monitor: FilterableMonitor,
  live: LiveStatus,
  filters: MonitorFilters,
  lookups: FilterLookups = {},
  parsed: ParsedSearch = parseSearchQuery(filters.q),
): boolean {
  const status = statusFilterOf(monitor.active, live)
  if (filters.status.length > 0 && (!status || !filters.status.includes(status))) return false
  if (parsed.tokens.status.length > 0 && (!status || !parsed.tokens.status.includes(status))) {
    return false
  }

  if (filters.type.length > 0 && !filters.type.includes(monitor.type)) return false
  if (parsed.tokens.type.length > 0 && !parsed.tokens.type.includes(normalizeText(monitor.type))) {
    return false
  }

  const tags = monitor.tags ?? []
  if (
    filters.tag.length > 0 &&
    !anyOverlap(
      filters.tag,
      tags.map((tag) => String(tag.id ?? '')),
    )
  ) {
    return false
  }
  if (parsed.tokens.tag.length > 0) {
    // `tag:prod` matches a tag named "prod", a tag whose value is "prod" and `tag:env:prod`.
    const names = tags.flatMap((tag) => {
      const name = normalizeText(tag.name)
      const value = tag.value ? normalizeText(tag.value) : null
      return value ? [name, value, `${name}:${value}`] : [name]
    })
    if (!anyOverlap(parsed.tokens.tag, names)) return false
  }

  if (
    filters.notification.length > 0 &&
    !anyOverlap(filters.notification, (monitor.notifications ?? []).map(String))
  ) {
    return false
  }

  if (filters.location.length > 0 || parsed.tokens.location.length > 0) {
    const keys = monitorLocationKeys(monitor)
    if (filters.location.length > 0 && !anyOverlap(filters.location, keys)) return false
    if (parsed.tokens.location.length > 0) {
      const names = keys.map((key) =>
        key === LOCAL_LOCATION
          ? LOCAL_LOCATION
          : normalizeText(lookups.locationNames?.[key] ?? key),
      )
      if (!anyOverlap(parsed.tokens.location, names)) return false
    }
  }

  return matchesTerms(monitor, parsed.terms)
}
