/**
 * Monitor assertions (#96): the shape stored in `monitors.assertions`, which comparators each kind
 * accepts and the rules shared by the form schema, the collection's `validate` and the worker's
 * evaluator (`src/server/monitor-types/assertions.ts`).
 *
 * Keep this module free of server-only imports: it is bundled into the monitor form.
 */

export const ASSERTION_KINDS = ['status', 'header', 'textBody', 'jsonBody', 'dnsRecord'] as const
export type AssertionKind = (typeof ASSERTION_KINDS)[number]

export const ASSERTION_COMPARATORS = [
  'eq',
  'not_eq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'not_contains',
  'empty',
  'not_empty',
  'matches',
  'not_matches',
] as const
export type AssertionComparator = (typeof ASSERTION_COMPARATORS)[number]

const NUMERIC: AssertionComparator[] = ['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte']
const TEXT: AssertionComparator[] = [
  'eq',
  'not_eq',
  'contains',
  'not_contains',
  'empty',
  'not_empty',
  'matches',
  'not_matches',
]

/** Comparators offered per kind, in the order the form lists them. */
export const COMPARATORS_BY_KIND: Record<AssertionKind, readonly AssertionComparator[]> = {
  status: NUMERIC,
  header: TEXT,
  textBody: TEXT,
  jsonBody: [...TEXT, 'gt', 'gte', 'lt', 'lte'],
  dnsRecord: ['eq', 'not_eq', 'contains', 'not_contains', 'matches', 'not_matches'],
}

/** Comparators that take no expected value. */
export const VALUELESS_COMPARATORS: readonly AssertionComparator[] = ['empty', 'not_empty']
/** Comparators that compare numbers. */
export const NUMERIC_COMPARATORS: readonly AssertionComparator[] = ['gt', 'gte', 'lt', 'lte']
/** Comparators whose expected value is a regular expression. */
export const REGEX_COMPARATORS: readonly AssertionComparator[] = ['matches', 'not_matches']

/** At most this many assertions of each kind per monitor. */
export const MAX_ASSERTIONS_PER_KIND = 10
/** Longest accepted target (header name, JSONata expression). */
export const MAX_ASSERTION_TARGET_LENGTH = 1000
/** Longest accepted expected value. */
export const MAX_ASSERTION_VALUE_LENGTH = 2000
/** Longest accepted regular expression (`matches` / `not_matches`). */
export const MAX_ASSERTION_REGEX_LENGTH = 500

export const ASSERTION_DNS_RECORD_TYPES = [
  'A',
  'AAAA',
  'CAA',
  'CNAME',
  'MX',
  'NS',
  'PTR',
  'SOA',
  'SRV',
  'TXT',
] as const

/** One row of `monitors.assertions`. */
export interface MonitorAssertion {
  kind: AssertionKind
  /** Header name, JSONata expression or DNS record type; unused for `status` and `textBody`. */
  target?: string | null
  comparator: AssertionComparator
  /** Expected value; unused for `empty` / `not_empty`. */
  value?: string | null
}

/**
 * Outcome of one assertion for one check. Stored on the heartbeat (`heartbeats.assertions`) and shown
 * on the monitor page; the same shape is what a run-on-demand result exposes.
 */
export interface AssertionResult {
  kind: AssertionKind
  target: string | null
  /** `in` is the legacy accepted-status-code ranges check. */
  comparator: AssertionComparator | 'in'
  expected: string | null
  /** Observed value (truncated), `null` when absent (missing header, no records, undefined result). */
  actual: string | null
  passed: boolean
  /** The assertion could not be evaluated (invalid expression, regex timeout, resolver error). */
  error?: string | null
  /**
   * Derived from the monitor's own fields (`acceptedStatusCodes`, `keyword`, JSON query) rather than
   * from `monitors.assertions`.
   */
  legacy?: boolean
}

/** Kinds a monitor type can use: the HTTP family gets HTTP assertions, DNS monitors record ones. */
export function assertionKindsForType(type: string | null | undefined): readonly AssertionKind[] {
  if (type === 'http' || type === 'keyword' || type === 'json-query') {
    return ['status', 'header', 'textBody', 'jsonBody']
  }
  if (type === 'dns') return ['dnsRecord']
  return []
}

export const supportsAssertions = (type: string | null | undefined): boolean =>
  assertionKindsForType(type).length > 0

/** RFC 7230 token (header field names). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** Problem keys, resolved to messages under `monitors.validation` by the callers. */
export type AssertionProblemKey =
  | 'assertionKind'
  | 'assertionComparator'
  | 'assertionTooMany'
  | 'assertionTargetRequired'
  | 'assertionHeaderName'
  | 'assertionRecordType'
  | 'assertionValueRequired'
  | 'assertionStatusCode'
  | 'assertionNumber'
  | 'assertionRegex'
  | 'assertionTooLong'

export interface AssertionProblem {
  /** Row index, or `null` for a problem with the whole list. */
  index: number | null
  field: 'kind' | 'target' | 'comparator' | 'value' | null
  key: AssertionProblemKey
  values?: Record<string, string | number>
}

/** Validate a regular expression the way the evaluator compiles it (`/pattern/flags` or a bare pattern). */
export function parseAssertionRegex(source: string): { pattern: string; flags: string } | null {
  if (source.length === 0 || source.length > MAX_ASSERTION_REGEX_LENGTH) return null
  const literal = /^\/(.+)\/([imsu]*)$/s.exec(source)
  const pattern = literal ? literal[1] : source
  const flags = literal ? literal[2] : ''
  try {
    new RegExp(pattern, flags)
  } catch {
    return null
  }
  return { pattern, flags }
}

const isFiniteNumber = (value: string) => value.trim() !== '' && Number.isFinite(Number(value))

/**
 * Check a list of assertions against a monitor type. Used by the form schema (`superRefine`), the
 * `monitors.assertions` field `validate` and imports, so every entry point agrees.
 */
export function assertionProblems(
  assertions: readonly Partial<MonitorAssertion>[] | null | undefined,
  type: string | null | undefined,
): AssertionProblem[] {
  const problems: AssertionProblem[] = []
  if (!assertions || assertions.length === 0) return problems
  const allowed = assertionKindsForType(type)
  const counts = new Map<string, number>()

  assertions.forEach((row, index) => {
    const kind = row?.kind as AssertionKind | undefined
    if (!kind || !ASSERTION_KINDS.includes(kind) || !allowed.includes(kind)) {
      problems.push({ index, field: 'kind', key: 'assertionKind' })
      return
    }
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
    const comparator = row.comparator as AssertionComparator | undefined
    if (!comparator || !COMPARATORS_BY_KIND[kind].includes(comparator)) {
      problems.push({ index, field: 'comparator', key: 'assertionComparator' })
      return
    }
    const target = (row.target ?? '').trim()
    const value = row.value ?? ''

    if (target.length > MAX_ASSERTION_TARGET_LENGTH) {
      problems.push({
        index,
        field: 'target',
        key: 'assertionTooLong',
        values: { max: MAX_ASSERTION_TARGET_LENGTH },
      })
    } else if (kind === 'header') {
      if (!target) problems.push({ index, field: 'target', key: 'assertionTargetRequired' })
      else if (!HEADER_NAME.test(target)) {
        problems.push({ index, field: 'target', key: 'assertionHeaderName' })
      }
    } else if (kind === 'jsonBody' && !target) {
      problems.push({ index, field: 'target', key: 'assertionTargetRequired' })
    } else if (
      kind === 'dnsRecord' &&
      target &&
      !(ASSERTION_DNS_RECORD_TYPES as readonly string[]).includes(target.toUpperCase())
    ) {
      problems.push({ index, field: 'target', key: 'assertionRecordType' })
    }

    if (VALUELESS_COMPARATORS.includes(comparator)) return
    if (value.length > MAX_ASSERTION_VALUE_LENGTH) {
      problems.push({
        index,
        field: 'value',
        key: 'assertionTooLong',
        values: { max: MAX_ASSERTION_VALUE_LENGTH },
      })
      return
    }
    if (kind === 'status') {
      const code = Number(value)
      if (!/^\d{3}$/.test(value.trim()) || code < 100 || code > 599) {
        problems.push({ index, field: 'value', key: 'assertionStatusCode' })
      }
      return
    }
    if (REGEX_COMPARATORS.includes(comparator)) {
      if (!parseAssertionRegex(value)) {
        problems.push({
          index,
          field: 'value',
          key: 'assertionRegex',
          values: { max: MAX_ASSERTION_REGEX_LENGTH },
        })
      }
      return
    }
    if (NUMERIC_COMPARATORS.includes(comparator) && !isFiniteNumber(value)) {
      problems.push({ index, field: 'value', key: 'assertionNumber' })
      return
    }
    // `eq ""` is a legitimate check for an empty string only through `empty`; require a value.
    if (value.length === 0) {
      problems.push({ index, field: 'value', key: 'assertionValueRequired' })
    }
  })

  for (const [kind, count] of counts) {
    if (count > MAX_ASSERTIONS_PER_KIND) {
      problems.push({
        index: null,
        field: null,
        key: 'assertionTooMany',
        values: { kind, max: MAX_ASSERTIONS_PER_KIND },
      })
    }
  }
  return problems
}

/**
 * Normalise stored rows (Payload adds `id`, Mongo may keep `null`s) to the form/export shape:
 * `{ kind, target, comparator, value }` with `null` for unused parts.
 */
export function normalizeAssertions(rows: unknown): MonitorAssertion[] {
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return []
    const { kind, target, comparator, value } = row as Record<string, unknown>
    if (typeof kind !== 'string' || typeof comparator !== 'string') return []
    return [
      {
        kind: kind as AssertionKind,
        target: typeof target === 'string' && target.length > 0 ? target : null,
        comparator: comparator as AssertionComparator,
        value: typeof value === 'string' ? value : null,
      },
    ]
  })
}
