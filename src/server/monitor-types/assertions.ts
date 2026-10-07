/**
 * Assertion evaluator (#96): pure functions that judge an HTTP response or a set of DNS records
 * against `monitors.assertions`. No I/O, so the check worker and a future probe agent can share it.
 *
 * Safety: nothing here evaluates JavaScript. JSON assertions use JSONata (a query language with its
 * own interpreter) with a time and stack budget; regular expressions — ours (`matches`) and those
 * inside JSONata expressions — run through `SafeRegExp`, which executes them in a `node:vm` context
 * with a hard timeout, so a catastrophic-backtracking pattern cannot stall the worker.
 */
import vm from 'node:vm'

import jsonata from 'jsonata'

import {
  NUMERIC_COMPARATORS,
  parseAssertionRegex,
  type AssertionComparator,
  type AssertionKind,
  type AssertionResult,
  type MonitorAssertion,
} from '@/lib/validation/assertions'

export type { AssertionResult, MonitorAssertion } from '@/lib/validation/assertions'

/** Budget of one regular-expression execution. */
export const REGEX_TIMEOUT_MS = 50
/** Budget of one JSONata evaluation and its maximum evaluation depth. */
export const JSONATA_TIMEOUT_MS = 1000
export const JSONATA_MAX_DEPTH = 500
/** Observed values are stored truncated to this many characters. */
export const MAX_ACTUAL_LENGTH = 500

// ---- Safe regular expressions -------------------------------------------------------------------

let sandbox: vm.Context | null = null
const EXEC = new vm.Script(
  `(() => {
    const re = new RegExp(__pattern, __flags)
    re.lastIndex = __lastIndex
    const m = re.exec(__input)
    return m === null ? null : { groups: Array.from(m), index: m.index, lastIndex: re.lastIndex }
  })()`,
)

interface SandboxMatch {
  groups: (string | undefined)[]
  index: number
  lastIndex: number
}

/** Run `RegExp.prototype.exec` in the sandbox, aborting after `REGEX_TIMEOUT_MS`. */
function sandboxExec(
  pattern: string,
  flags: string,
  input: string,
  lastIndex: number,
): SandboxMatch | null {
  sandbox ??= vm.createContext(Object.create(null))
  Object.assign(sandbox, {
    __pattern: pattern,
    __flags: flags,
    __input: input,
    __lastIndex: lastIndex,
  })
  try {
    const result = EXEC.runInContext(sandbox, { timeout: REGEX_TIMEOUT_MS }) as SandboxMatch | null
    return result
      ? { groups: [...result.groups], index: result.index, lastIndex: result.lastIndex }
      : null
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new Error(`regular expression timed out after ${REGEX_TIMEOUT_MS} ms`)
    }
    throw new Error(err instanceof Error ? err.message : String(err))
  } finally {
    // Do not keep the (possibly large) response body alive between checks.
    Object.assign(sandbox, { __input: '' })
  }
}

/**
 * Drop-in `RegExp` for JSONata's `RegexEngine` option: JSONata constructs it from the regex literal of
 * the expression and calls `exec()` with `lastIndex`, which here runs with a timeout.
 */
export class SafeRegExp {
  readonly source: string
  readonly flags: string
  lastIndex = 0

  constructor(pattern: string | RegExp, flags?: string) {
    this.source = typeof pattern === 'string' ? pattern : pattern.source
    this.flags = flags ?? (typeof pattern === 'string' ? '' : pattern.flags)
    // Surface syntax errors at construction time, like RegExp.
    new RegExp(this.source, this.flags)
  }

  exec(input: string): RegExpExecArray | null {
    const match = sandboxExec(this.source, this.flags, String(input), this.lastIndex)
    if (!match) {
      this.lastIndex = 0
      return null
    }
    this.lastIndex = match.lastIndex
    const out = match.groups as unknown as RegExpExecArray
    out.index = match.index
    out.input = input
    return out
  }

  test(input: string): boolean {
    return this.exec(input) !== null
  }
}

/** Test `source` (`/pattern/flags` or a bare pattern) against `input` with a timeout. */
export function safeRegexTest(source: string, input: string): boolean {
  const parsed = parseAssertionRegex(source)
  if (!parsed) throw new Error('invalid regular expression')
  // Without `g`/`y` exec ignores lastIndex; strip them so repeated calls are independent.
  return sandboxExec(parsed.pattern, parsed.flags.replace(/[gy]/g, ''), input, 0) !== null
}

/** Evaluate a JSONata expression with the time, depth and regex guards. */
export async function evaluateJsonata(expression: string, data: unknown): Promise<unknown> {
  const expr = jsonata(expression, {
    timeout: JSONATA_TIMEOUT_MS,
    stack: JSONATA_MAX_DEPTH,
    RegexEngine: SafeRegExp as unknown as RegExpConstructor,
  })
  return expr.evaluate(data)
}

// ---- Comparison ---------------------------------------------------------------------------------

const truncate = (value: string, max = MAX_ACTUAL_LENGTH) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value

const toNumber = (value: string | null): number | null => {
  if (value === null || value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

interface CompareOptions {
  /** DNS names: compare case-insensitively and ignore a trailing dot. */
  dnsName?: boolean
  /** Values that also count as empty (`[]`, `{}` for JSON). */
  emptyValues?: readonly string[]
  /** `eq` / `not_eq` also accept numerically equal values (`1.0` == `1`). */
  numericEquality?: boolean
}

const normalizeDns = (value: string) => value.toLowerCase().replace(/\.$/, '')

/** Compare one observed value; `null` means absent. Throws when the comparison cannot run. */
export function compareValue(
  comparator: AssertionComparator,
  actual: string | null,
  expected: string,
  options: CompareOptions = {},
): boolean {
  const isEmpty = actual === null || actual === '' || !!options.emptyValues?.includes(actual)
  const norm = options.dnsName ? normalizeDns : (v: string) => v
  switch (comparator) {
    case 'empty':
      return isEmpty
    case 'not_empty':
      return !isEmpty
    case 'eq': {
      if (actual === null) return false
      if (norm(actual) === norm(expected)) return true
      if (!options.numericEquality) return false
      const a = toNumber(actual)
      const b = toNumber(expected)
      return a !== null && b !== null && a === b
    }
    case 'not_eq':
      return !compareValue('eq', actual, expected, options)
    case 'contains':
      return actual !== null && norm(actual).includes(norm(expected))
    case 'not_contains':
      return !compareValue('contains', actual, expected, options)
    case 'matches':
      return actual !== null && safeRegexTest(expected, actual)
    case 'not_matches':
      return !compareValue('matches', actual, expected, options)
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toNumber(actual)
      const b = toNumber(expected)
      if (a === null || b === null) return false
      if (comparator === 'gt') return a > b
      if (comparator === 'gte') return a >= b
      if (comparator === 'lt') return a < b
      return a <= b
    }
    default:
      throw new Error(`unknown comparator ${String(comparator)}`)
  }
}

/** Comparators that pass when *no* record matches (the others pass when *any* record does). */
const NEGATED: readonly AssertionComparator[] = ['not_eq', 'not_contains', 'not_matches']
const POSITIVE_OF: Partial<Record<AssertionComparator, AssertionComparator>> = {
  not_eq: 'eq',
  not_contains: 'contains',
  not_matches: 'matches',
}

function baseResult(assertion: MonitorAssertion): Omit<AssertionResult, 'actual' | 'passed'> {
  const valueless = assertion.comparator === 'empty' || assertion.comparator === 'not_empty'
  return {
    kind: assertion.kind,
    target: assertion.target?.trim() || null,
    comparator: assertion.comparator,
    expected: valueless ? null : (assertion.value ?? ''),
  }
}

const failed = (
  assertion: MonitorAssertion,
  actual: string | null,
  error: unknown,
): AssertionResult => ({
  ...baseResult(assertion),
  actual,
  passed: false,
  error: error instanceof Error ? error.message : String(error),
})

// ---- HTTP ---------------------------------------------------------------------------------------

export interface HttpAssertionInput {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** Header value by case-insensitive name; repeated headers are joined with `, `. */
export function headerValue(headers: HttpAssertionInput['headers'], name: string): string | null {
  const wanted = name.trim().toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue
    return Array.isArray(value) ? value.join(', ') : String(value)
  }
  return null
}

/** JSONata result → comparable string (`null` when the expression matched nothing). */
export function jsonResultToString(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'function') return null
  try {
    return JSON.stringify(value) ?? null
  } catch {
    return null
  }
}

/**
 * Evaluate HTTP assertions (`status`, `header`, `textBody`, `jsonBody`) against one response. Every
 * assertion is evaluated (so the result view is complete); the caller fails the check on the first
 * result with `passed: false`.
 */
export async function evaluateHttpAssertions(
  assertions: readonly MonitorAssertion[],
  response: HttpAssertionInput,
): Promise<AssertionResult[]> {
  let parsedBody: { value: unknown } | null = null
  const json = () => {
    if (!parsedBody) {
      try {
        parsedBody = { value: JSON.parse(response.body) }
      } catch {
        // Like the json-query type: a non-JSON body is queried as a plain string.
        parsedBody = { value: response.body }
      }
    }
    return parsedBody.value
  }

  const results: AssertionResult[] = []
  for (const assertion of assertions) {
    const expected = assertion.value ?? ''
    let actual: string | null = null
    try {
      const options: CompareOptions = {}
      switch (assertion.kind) {
        case 'status':
          actual = String(response.statusCode)
          options.numericEquality = true
          break
        case 'header':
          actual = headerValue(response.headers, assertion.target ?? '')
          break
        case 'textBody':
          actual = response.body
          break
        case 'jsonBody':
          actual = jsonResultToString(await evaluateJsonata(assertion.target ?? '', json()))
          options.emptyValues = ['[]', '{}']
          options.numericEquality = true
          break
        default:
          throw new Error(`${assertion.kind} assertions do not apply to HTTP responses`)
      }
      const passed = compareValue(assertion.comparator, actual, expected, options)
      results.push({
        ...baseResult(assertion),
        actual: actual === null ? null : truncate(actual),
        passed,
      })
    } catch (err) {
      results.push(failed(assertion, actual === null ? null : truncate(actual), jsonataError(err)))
    }
  }
  return results
}

/** JSONata throws plain objects (`{ code, message }`); turn them into Errors with a readable text. */
function jsonataError(err: unknown): unknown {
  if (err instanceof Error) return err
  if (err && typeof err === 'object') {
    const { code, message } = err as { code?: string; message?: string }
    if (code === 'D1012') return new Error(`expression timed out after ${JSONATA_TIMEOUT_MS} ms`)
    if (code === 'D1011') return new Error('expression exceeded the maximum evaluation depth')
    return new Error(message ? `invalid expression: ${message}` : `invalid expression (${code})`)
  }
  return err
}

// ---- DNS ----------------------------------------------------------------------------------------

/**
 * Comparable strings of a `Resolver.resolve()` result: names and addresses as is, TXT chunks joined,
 * MX → exchange, SRV → `priority weight port target`, CAA → `tag value`, SOA → its fields.
 */
export function dnsRecordStrings(rrtype: string, records: unknown): string[] {
  if (records === null || records === undefined) return []
  switch (rrtype) {
    case 'TXT':
      return (records as string[][]).map((chunks) => chunks.join(''))
    case 'MX':
      return (records as { exchange: string }[]).map((r) => r.exchange)
    case 'SRV':
      return (records as { name: string; port: number; priority: number; weight: number }[]).map(
        (r) => `${r.priority} ${r.weight} ${r.port} ${r.name}`,
      )
    case 'CAA':
      return (records as Record<string, unknown>[]).map((r) =>
        Object.entries(r)
          .filter(([key]) => key !== 'critical')
          .map(([key, value]) => `${key} ${String(value)}`)
          .join(' '),
      )
    case 'SOA': {
      const soa = records as Record<string, unknown>
      return [
        [soa.nsname, soa.hostmaster, soa.serial, soa.refresh, soa.retry, soa.expire, soa.minttl]
          .map(String)
          .join(' '),
      ]
    }
    default:
      return Array.isArray(records) ? records.map(String) : [String(records)]
  }
}

/** Records per type, or the error that prevented resolving that type. */
export type DnsRecordSets = Map<string, string[] | Error>

/**
 * Evaluate `dnsRecord` assertions. `eq`, `contains` and `matches` pass when **any** record matches;
 * `not_eq`, `not_contains` and `not_matches` pass when **no** record does. Names compare
 * case-insensitively and ignore a trailing dot. `target` (record type) defaults to `defaultType`.
 */
export function evaluateDnsAssertions(
  assertions: readonly MonitorAssertion[],
  recordSets: DnsRecordSets,
  defaultType: string,
): AssertionResult[] {
  return assertions.map((assertion) => {
    const rrtype = (assertion.target?.trim() || defaultType).toUpperCase()
    const base = { ...baseResult(assertion), target: rrtype }
    const records = recordSets.get(rrtype)
    if (records instanceof Error)
      return { ...base, actual: null, passed: false, error: records.message }
    const list = records ?? []
    const actual = list.length ? truncate(list.join(' | ')) : null
    try {
      const expected = assertion.value ?? ''
      const positive = POSITIVE_OF[assertion.comparator] ?? assertion.comparator
      const any = list.some((record) => compareValue(positive, record, expected, { dnsName: true }))
      const passed = NEGATED.includes(assertion.comparator) ? !any : any
      return { ...base, actual, passed }
    } catch (err) {
      return {
        ...base,
        actual,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  })
}

// ---- Messages -----------------------------------------------------------------------------------

const OPERATOR: Record<AssertionComparator | 'in', string> = {
  eq: '==',
  not_eq: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  contains: 'contains',
  not_contains: 'not contains',
  empty: 'empty',
  not_empty: 'not empty',
  matches: 'matches',
  not_matches: 'not matches',
  in: 'in',
}

const SUBJECT: Record<AssertionKind, (target: string | null) => string> = {
  status: () => 'status code',
  header: (target) => `header ${target ?? ''}`.trim(),
  textBody: () => 'body',
  jsonBody: (target) => `json ${target ?? ''}`.trim(),
  dnsRecord: (target) => `${target ?? ''} record`.trim(),
}

const quote = (value: string, max = 100) => JSON.stringify(truncate(value, max))

/**
 * One-line English description of a result, used as the heartbeat message of a failed check:
 * `header content-type: expected contains "json", got "text/html"`. Heartbeat messages are stored
 * data and stay English (docs/Development.md → Server-side strings); the UI renders the structured
 * result in the reader's language instead.
 */
export function describeAssertionResult(result: AssertionResult): string {
  const subject = SUBJECT[result.kind](result.target)
  if (result.error) return `${subject}: ${result.error}`
  const numeric =
    result.kind === 'status' ||
    result.comparator === 'in' ||
    NUMERIC_COMPARATORS.includes(result.comparator)
  const expected =
    result.expected === null ? '' : ` ${numeric ? result.expected : quote(result.expected)}`
  const actual =
    result.actual === null
      ? '(none)'
      : numeric
        ? truncate(result.actual, 100)
        : quote(result.actual)
  return `${subject}: expected ${OPERATOR[result.comparator]}${expected}, got ${actual}`
}

/** Suffix of a passing check's message: `, 3 assertions passed`. */
export function passedSuffix(results: readonly AssertionResult[]): string {
  const count = results.filter((r) => !r.legacy).length
  if (count === 0) return ''
  return `, ${count} assertion${count === 1 ? '' : 's'} passed`
}
