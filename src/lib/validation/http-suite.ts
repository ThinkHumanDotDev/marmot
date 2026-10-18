/**
 * Multi-step API checks (#138): the `http-suite` monitor's definition (`monitors.httpSuite`), its
 * placeholder syntax and the per-step results stored on a heartbeat (`heartbeats.steps`).
 *
 *   httpSuite:
 *     vars:    [{ name: base, value: https://api.example.com }]
 *     secrets: [{ name: password, value: hunter2 }]
 *     steps:
 *       - key: login
 *         name: Log in
 *         method: POST
 *         url: '{{ vars.base }}/login'
 *         body: '{"user": "monitor", "password": "{{ secrets.password }}"}'
 *         store: [{ name: token, from: $.data.token, secret: true }]
 *       - key: profile
 *         name: Get profile
 *         url: '{{ vars.base }}/me'
 *         headers: [{ name: Authorization, value: 'Bearer {{ steps.login.token }}' }]
 *       - key: logout
 *         url: '{{ vars.base }}/logout'
 *         alwaysRun: true
 *
 * Files may also write `vars`, `secrets`, `headers` and `store` as maps (`store: { token: $.data.token }`);
 * the schema turns them into the row form above, which is what is stored and exported.
 *
 * Keep this module free of server-only imports: it is bundled into the monitor form.
 */
import { z } from 'zod'

import {
  ASSERTION_COMPARATORS,
  ASSERTION_KINDS,
  assertionProblems,
  MAX_ASSERTION_TARGET_LENGTH,
  MAX_ASSERTION_VALUE_LENGTH,
  MAX_ASSERTIONS_PER_KIND,
  type AssertionProblemKey,
  type AssertionResult,
  type MonitorAssertion,
} from './assertions'

export const MAX_SUITE_STEPS = 20
export const MAX_SUITE_VARS = 50
export const MAX_SUITE_HEADERS = 30
export const MAX_SUITE_STORE = 20
export const MAX_SUITE_VALUE_LENGTH = 5000
export const MAX_SUITE_URL_LENGTH = 2048
export const MAX_SUITE_BODY_LENGTH = 100_000
export const MAX_SUITE_NAME_LENGTH = 100

export const SUITE_HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
] as const
export const SUITE_BODY_ENCODINGS = ['json', 'form', 'xml'] as const
export const SUITE_AUTH_METHODS = ['none', 'basic', 'bearer'] as const

/** Variable, secret and stored value names: identifiers. */
export const SUITE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Step keys (`{{ steps.<key>.<name> }}`). */
export const SUITE_STEP_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/

/** `{{ vars.name }}`, `{{ secrets.name }}`, `{{ steps.key.name }}`. */
export const SUITE_PLACEHOLDER =
  /\{\{\s*(vars|secrets|steps)\.([A-Za-z_][A-Za-z0-9_-]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?\s*\}\}/g

export interface SuiteReference {
  scope: 'vars' | 'secrets' | 'steps'
  name: string
  /** Stored value name for `steps.<key>.<field>`. */
  field: string | null
  /** The placeholder as written. */
  raw: string
}

/** Placeholders in `text`, in order. A `steps.<key>` without a field is returned with `field: null`. */
export function suiteReferences(text: string | null | undefined): SuiteReference[] {
  if (!text) return []
  const out: SuiteReference[] = []
  for (const match of text.matchAll(SUITE_PLACEHOLDER)) {
    out.push({
      scope: match[1] as SuiteReference['scope'],
      name: match[2]!,
      field: match[3] ?? null,
      raw: match[0],
    })
  }
  return out
}

/** `vars.token`, `steps.login.token`: how a reference reads in messages. */
export const referenceLabel = (ref: Pick<SuiteReference, 'scope' | 'name' | 'field'>): string =>
  ref.field ? `${ref.scope}.${ref.name}.${ref.field}` : `${ref.scope}.${ref.name}`

// ---- Shape ---------------------------------------------------------------------------------------

export interface SuitePair {
  name: string
  value: string
}

export interface SuiteStoreRow {
  /** Name the value is stored under (`{{ vars.<name> }}`, `{{ steps.<key>.<name> }}`). */
  name: string
  /**
   * Where the value comes from: `header:<name>`, `status`, `body`, or a JSONata expression over the
   * JSON body (JSONPath-style `$.data.token` works).
   */
  from: string
  /** Redact the value from stored results and messages. */
  secret: boolean
}

export interface HttpSuiteStep {
  key: string
  name: string | null
  method: (typeof SUITE_HTTP_METHODS)[number]
  url: string
  headers: SuitePair[]
  body: string | null
  bodyEncoding: (typeof SUITE_BODY_ENCODINGS)[number]
  authMethod: (typeof SUITE_AUTH_METHODS)[number]
  basicAuthUser: string | null
  basicAuthPass: string | null
  bearerToken: string | null
  /** Accepted status codes/ranges; replaced by `status` assertions when the step has any. */
  acceptedStatusCodes: string[]
  assertions: MonitorAssertion[]
  store: SuiteStoreRow[]
  /** Cleanup: runs even after an earlier step failed. */
  alwaysRun: boolean
}

export interface HttpSuite {
  vars: SuitePair[]
  secrets: SuitePair[]
  steps: HttpSuiteStep[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const scalar = (value: unknown): unknown =>
  typeof value === 'number' || typeof value === 'boolean' ? String(value) : value

/** `{ a: 1 }` → `[{ name: 'a', value: '1' }]`; row lists pass through. */
const pairsInput = (value: unknown): unknown => {
  if (value === null || value === undefined) return []
  if (isRecord(value)) {
    return Object.entries(value).map(([name, v]) => ({ name, value: scalar(v) }))
  }
  if (Array.isArray(value)) {
    return value.map((row) => (isRecord(row) ? { ...row, value: scalar(row.value) } : row))
  }
  return value
}

/** `{ token: '$.t' }` / `{ token: { from: '$.t', secret: true } }` → rows. */
const storeInput = (value: unknown): unknown => {
  if (value === null || value === undefined) return []
  if (isRecord(value)) {
    return Object.entries(value).map(([name, v]) =>
      isRecord(v) ? { name, ...v } : { name, from: v },
    )
  }
  return value
}

const text = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null))

const trimmedText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null))

const pairRow = z.object({
  name: z.string().trim().max(200),
  value: z
    .string()
    .max(MAX_SUITE_VALUE_LENGTH)
    .nullish()
    .transform((v) => v ?? ''),
})

const pairs = (max: number) => z.preprocess(pairsInput, z.array(pairRow).max(max))

const storeRow = z.object({
  name: z.string().trim().max(64),
  from: z.string().trim().max(MAX_ASSERTION_TARGET_LENGTH),
  secret: z
    .boolean()
    .nullish()
    .transform((v) => v ?? false),
})

const suiteAssertionRow = z.object({
  kind: z.enum(ASSERTION_KINDS),
  target: trimmedText(MAX_ASSERTION_TARGET_LENGTH),
  comparator: z.enum(ASSERTION_COMPARATORS),
  value: text(MAX_ASSERTION_VALUE_LENGTH),
})

const statusCodes = z.preprocess(
  (value) =>
    typeof value === 'string' || typeof value === 'number'
      ? String(value)
          .split(',')
          .map((v) => v.trim())
      : value,
  z
    .array(z.string().trim().max(20))
    .nullish()
    .transform((list) => {
      const clean = (list ?? []).filter((v) => v.length > 0)
      return clean.length > 0 ? clean : ['200-299']
    }),
)

export const httpSuiteStepSchema = z.object({
  key: z.string().trim().max(64),
  name: trimmedText(MAX_SUITE_NAME_LENGTH),
  method: z
    .preprocess((v) => (typeof v === 'string' ? v.toUpperCase() : v), z.enum(SUITE_HTTP_METHODS))
    .default('GET'),
  url: z.string().trim().max(MAX_SUITE_URL_LENGTH),
  headers: pairs(MAX_SUITE_HEADERS).default([]),
  body: text(MAX_SUITE_BODY_LENGTH),
  bodyEncoding: z.enum(SUITE_BODY_ENCODINGS).default('json'),
  authMethod: z.enum(SUITE_AUTH_METHODS).default('none'),
  basicAuthUser: trimmedText(500),
  basicAuthPass: text(500),
  bearerToken: text(5000),
  acceptedStatusCodes: statusCodes.default(['200-299']),
  assertions: z
    .array(suiteAssertionRow)
    .max(4 * MAX_ASSERTIONS_PER_KIND)
    .nullish()
    .transform((v) => v ?? []),
  store: z.preprocess(storeInput, z.array(storeRow).max(MAX_SUITE_STORE)).default([]),
  alwaysRun: z
    .boolean()
    .nullish()
    .transform((v) => v ?? false),
})

/** `monitors.httpSuite`; `null` for every other monitor type. */
export const httpSuiteSchema = z.object({
  vars: pairs(MAX_SUITE_VARS).default([]),
  secrets: pairs(MAX_SUITE_VARS).default([]),
  steps: z.array(httpSuiteStepSchema).max(MAX_SUITE_STEPS).default([]),
})

/** A new step as the form adds it. */
export function emptySuiteStep(index: number): HttpSuiteStep {
  return {
    key: `step${index + 1}`,
    name: null,
    method: 'GET',
    url: 'https://',
    headers: [],
    body: null,
    bodyEncoding: 'json',
    authMethod: 'none',
    basicAuthUser: null,
    basicAuthPass: null,
    bearerToken: null,
    acceptedStatusCodes: ['200-299'],
    assertions: [],
    store: [],
    alwaysRun: false,
  }
}

export const emptyHttpSuite = (): HttpSuite => ({
  vars: [],
  secrets: [],
  steps: [emptySuiteStep(0)],
})

/** The stored value as a suite (anything malformed is `null`). */
export function parseHttpSuite(value: unknown): HttpSuite | null {
  if (value === null || value === undefined) return null
  const parsed = httpSuiteSchema.safeParse(value)
  return parsed.success ? (parsed.data as HttpSuite) : null
}

/** Display name of a step: its name, else its key. */
export const stepLabel = (step: Pick<HttpSuiteStep, 'key' | 'name'>): string =>
  step.name || step.key

// ---- Rules ---------------------------------------------------------------------------------------

export type SuiteProblemKey =
  | 'suiteStepsRequired'
  | 'suiteStepKey'
  | 'suiteStepKeyDuplicate'
  | 'suiteName'
  | 'suiteNameDuplicate'
  | 'suiteHeaderName'
  | 'suiteUrl'
  | 'suiteStatusCodes'
  | 'suiteStoreFrom'
  | 'suiteUnknownReference'
  | 'suiteAuthRequired'
  | AssertionProblemKey

export interface SuiteProblem {
  /** Path below `httpSuite`, e.g. `['steps', 1, 'url']`. */
  path: (string | number)[]
  key: SuiteProblemKey
  values?: Record<string, string | number>
}

/** RFC 7230 token (header field names). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const STATUS_RANGE = /^([1-5]\d{2})(-([1-5]\d{2}))?$/

/**
 * Check a suite: names and keys well-formed and unique, URLs http(s) (or starting with a
 * placeholder), assertions valid for HTTP responses, and every placeholder resolvable — `vars` are
 * static vars or values stored by an earlier step, `secrets` are defined, `steps.<key>.<name>` names
 * an earlier step that stores `<name>`.
 */
export function httpSuiteProblems(suite: HttpSuite | null | undefined): SuiteProblem[] {
  const problems: SuiteProblem[] = []
  if (!suite || suite.steps.length === 0) {
    problems.push({ path: ['steps'], key: 'suiteStepsRequired' })
    return problems
  }

  const checkPairs = (list: SuitePair[], scope: 'vars' | 'secrets') => {
    const seen = new Set<string>()
    list.forEach((row, index) => {
      if (!SUITE_NAME_PATTERN.test(row.name) || row.name.length > 64) {
        problems.push({ path: [scope, index, 'name'], key: 'suiteName' })
      } else if (seen.has(row.name)) {
        problems.push({ path: [scope, index, 'name'], key: 'suiteNameDuplicate' })
      }
      seen.add(row.name)
    })
    return seen
  }
  const vars = checkPairs(suite.vars, 'vars')
  const secrets = checkPairs(suite.secrets, 'secrets')

  const keys = new Set<string>()
  /** Values stored by the steps so far, per step key. */
  const stored = new Map<string, Set<string>>()

  suite.steps.forEach((step, index) => {
    const at = (...rest: (string | number)[]) => ['steps', index, ...rest]
    if (!SUITE_STEP_KEY_PATTERN.test(step.key)) {
      problems.push({ path: at('key'), key: 'suiteStepKey' })
    } else if (keys.has(step.key)) {
      problems.push({ path: at('key'), key: 'suiteStepKeyDuplicate' })
    }

    const resolves = (ref: SuiteReference): boolean => {
      if (ref.scope === 'secrets') return ref.field === null && secrets.has(ref.name)
      if (ref.scope === 'vars') {
        if (ref.field !== null) return false
        if (vars.has(ref.name)) return true
        return [...stored.values()].some((names) => names.has(ref.name))
      }
      return ref.field !== null && Boolean(stored.get(ref.name)?.has(ref.field))
    }
    const checkText = (value: string | null | undefined, ...path: (string | number)[]) => {
      for (const ref of suiteReferences(value)) {
        if (!resolves(ref)) {
          problems.push({
            path: at(...path),
            key: 'suiteUnknownReference',
            values: { name: referenceLabel(ref) },
          })
          return
        }
      }
    }

    if (!/^(https?:\/\/\S+|\{\{)/i.test(step.url)) {
      problems.push({ path: at('url'), key: 'suiteUrl' })
    }
    checkText(step.url, 'url')
    step.headers.forEach((header, h) => {
      if (!HEADER_NAME.test(header.name)) {
        problems.push({ path: at('headers', h, 'name'), key: 'suiteHeaderName' })
      }
      checkText(header.value, 'headers', h, 'value')
    })
    checkText(step.body, 'body')
    if (step.authMethod === 'basic') {
      if (!step.basicAuthUser)
        problems.push({ path: at('basicAuthUser'), key: 'suiteAuthRequired' })
      checkText(step.basicAuthUser, 'basicAuthUser')
      checkText(step.basicAuthPass, 'basicAuthPass')
    }
    if (step.authMethod === 'bearer') {
      if (!step.bearerToken) problems.push({ path: at('bearerToken'), key: 'suiteAuthRequired' })
      checkText(step.bearerToken, 'bearerToken')
    }
    if (step.acceptedStatusCodes.some((code) => !isStatusRange(code))) {
      problems.push({ path: at('acceptedStatusCodes'), key: 'suiteStatusCodes' })
    }
    for (const problem of assertionProblems(step.assertions, 'http')) {
      problems.push({
        path:
          problem.index === null
            ? at('assertions')
            : at('assertions', problem.index, problem.field ?? 'kind'),
        key: problem.key,
        values: problem.values,
      })
    }
    step.assertions.forEach((assertion, a) => {
      checkText(assertion.target, 'assertions', a, 'target')
      checkText(assertion.value, 'assertions', a, 'value')
    })

    const names = new Set<string>()
    step.store.forEach((row, s) => {
      if (!SUITE_NAME_PATTERN.test(row.name)) {
        problems.push({ path: at('store', s, 'name'), key: 'suiteName' })
      } else if (names.has(row.name)) {
        problems.push({ path: at('store', s, 'name'), key: 'suiteNameDuplicate' })
      }
      names.add(row.name)
      if (!row.from) problems.push({ path: at('store', s, 'from'), key: 'suiteStoreFrom' })
    })
    keys.add(step.key)
    stored.set(step.key, names)
  })
  return problems
}

/**
 * The steps' URLs with the static `vars` filled in, for save-time target checks and the
 * connectivity probe. URLs whose host still depends on a stored value are left out.
 */
export function suiteTargetUrls(value: unknown): string[] {
  const suite = parseHttpSuite(value)
  if (!suite) return []
  const vars = new Map(suite.vars.map((row) => [row.name, row.value]))
  return suite.steps.flatMap((step) => {
    const url = step.url.replace(
      SUITE_PLACEHOLDER,
      (match, scope: string, name: string, field?: string) =>
        scope === 'vars' && !field && vars.has(name) ? vars.get(name)! : match,
    )
    const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url)?.[1]
    return authority && !authority.includes('{{') ? [url] : []
  })
}

const isStatusRange = (value: string): boolean => {
  const match = STATUS_RANGE.exec(value)
  if (!match) return false
  return match[3] === undefined || Number(match[1]) <= Number(match[3])
}

// ---- Results -------------------------------------------------------------------------------------

export const SUITE_STEP_OUTCOMES = ['passed', 'failed', 'skipped'] as const
export type SuiteStepOutcome = (typeof SUITE_STEP_OUTCOMES)[number]

/**
 * One step of one check (`heartbeats.steps`). Every string has the suite's secrets redacted (suite
 * secrets, values stored with `secret: true`, credentials and header values the step sent).
 */
export interface SuiteStepResult {
  key: string
  name: string
  method: string
  /** The URL as requested (placeholders resolved, secrets redacted). */
  url: string
  outcome: SuiteStepOutcome
  alwaysRun: boolean
  statusCode: number | null
  /** Start of the step in ms after the suite started. */
  start: number
  /** Duration of the step in ms (`0` for skipped steps). */
  duration: number
  /** Request timing phases (`dns`, `connect`, …), when measured. */
  timing: Record<string, number | null> | null
  /** Why the step failed or was skipped; the status text when it passed. */
  msg: string
  assertions: AssertionResult[]
  /** Names of the values the step stored. */
  stored: string[]
}

const OUTCOMES = new Set<string>(SUITE_STEP_OUTCOMES)

/** Step results stored on a heartbeat (`heartbeats.steps`); malformed rows are skipped. */
export function parseSuiteStepResults(value: unknown): SuiteStepResult[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((row) => {
    if (!isRecord(row)) return []
    if (typeof row.key !== 'string' || !OUTCOMES.has(row.outcome as string)) return []
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    return [
      {
        key: row.key,
        name: typeof row.name === 'string' ? row.name : row.key,
        method: typeof row.method === 'string' ? row.method : 'GET',
        url: typeof row.url === 'string' ? row.url : '',
        outcome: row.outcome as SuiteStepOutcome,
        alwaysRun: row.alwaysRun === true,
        statusCode: num(row.statusCode),
        start: num(row.start) ?? 0,
        duration: num(row.duration) ?? 0,
        timing: isRecord(row.timing) ? (row.timing as Record<string, number | null>) : null,
        msg: typeof row.msg === 'string' ? row.msg : '',
        assertions: Array.isArray(row.assertions) ? (row.assertions as AssertionResult[]) : [],
        stored: Array.isArray(row.stored)
          ? row.stored.filter((v): v is string => typeof v === 'string')
          : [],
      },
    ]
  })
}
