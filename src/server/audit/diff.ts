/**
 * Snapshots and field diffs for audit rows, with secrets redacted. Pure functions (no Payload), so
 * they are unit-tested in `diff.test.ts`.
 *
 * - `snapshot(doc)` — the document as it was created or deleted, without timestamps, ignored fields
 *   and empty values.
 * - `diffDocs(before, after)` — the paths that changed (`active`, `config.webhookUrl`) with their
 *   old and new values. Plain objects (groups, JSON) are compared key by key, arrays as a whole.
 *
 * Values of secret keys (passwords, tokens, webhook URLs, private keys, hashes …) are replaced by
 * `REDACTED` wherever they occur, credentials in URLs (`https://user:pass@host`) are masked and long
 * strings are truncated. A changed secret still shows up in `changedFields`, just not its value.
 */

export const REDACTED = '[redacted]'

/** Strings longer than this are cut so one row never carries a whole TLS bundle or CSS file. */
export const MAX_STRING_LENGTH = 500

/** Nesting depth up to which plain objects are diffed key by key. */
const MAX_DIFF_DEPTH = 3

/** Never part of a diff or snapshot. */
const ALWAYS_IGNORED = new Set(['id', 'createdAt', 'updatedAt', '_status', '__v', 'sizes'])

/**
 * Key names whose values are secrets. Matched case-insensitively against the last path segment, so
 * `basicAuthPass`, `oauthClientSecret`, `sshPrivateKey`, `pushToken`, `slackWebhookURL` and
 * `databaseConnectionString` are all covered without a per-collection list.
 */
const SECRET_KEY_PATTERN =
  /(pass(word|phrase)?$|secret|token|api_?key|private_?key|^tlskey$|credential|connection_?string|webhook|community|cookie|authorization|signature|hash$|salt$|^headers$|sasl|otp|backup_?codes|recovery)/i

export const isSecretKey = (key: string): boolean => SECRET_KEY_PATTERN.test(key)

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type FlatValues = Record<string, JsonValue>

export interface DiffOptions {
  /** Top-level fields to leave out entirely (status caches, server-maintained timestamps). */
  ignore?: readonly string[]
  /** Extra key names (last path segment) whose values are secrets, e.g. a provider's secret fields. */
  secretKeys?: readonly string[]
}

export interface Diff {
  changedFields: string[]
  before: FlatValues
  after: FlatValues
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  !(value instanceof Date) &&
  Object.getPrototypeOf(value) === Object.prototype

/** A populated relationship or upload (`{ id, createdAt, … }`) collapses to its id. */
const isPopulatedDoc = (value: Record<string, unknown>): boolean =>
  'id' in value &&
  (typeof value.id === 'string' || typeof value.id === 'number') &&
  ('createdAt' in value || 'updatedAt' in value)

/** Masks the password of `scheme://user:password@host` URLs. */
export function maskUrlCredentials(value: string): string {
  return value.replace(/([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):[^/\s@]+@/gi, `$1:${REDACTED}@`)
}

function truncate(value: string): string {
  return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value
}

class Redactor {
  private readonly secrets: Set<string>

  constructor(secretKeys: readonly string[] = []) {
    this.secrets = new Set(secretKeys.map((key) => key.toLowerCase()))
  }

  isSecret(key: string): boolean {
    return this.secrets.has(key.toLowerCase()) || isSecretKey(key)
  }

  /** Normalises `value` into JSON (ids for populated docs, ISO dates) and redacts nested secrets. */
  value(value: unknown, key?: string): JsonValue {
    if (value === undefined || value === null) return null
    if (key !== undefined && this.isSecret(key)) {
      return value === '' || (Array.isArray(value) && value.length === 0) ? value : REDACTED
    }
    if (value instanceof Date) return value.toISOString()
    if (typeof value === 'string') return truncate(maskUrlCredentials(value))
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value === 'boolean') return value
    if (Array.isArray(value)) return value.map((item) => this.value(item))
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>
      if (isPopulatedDoc(record)) return record.id as string | number
      const out: Record<string, JsonValue> = {}
      for (const [childKey, child] of Object.entries(record)) {
        out[childKey] = this.value(child, childKey)
      }
      return out
    }
    return null
  }
}

const isEmpty = (value: JsonValue): boolean =>
  value === null ||
  value === '' ||
  (Array.isArray(value) && value.length === 0) ||
  (isPlainObject(value) && Object.keys(value).length === 0)

/** Stable string form for equality checks (object keys sorted). */
function stable(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key]!)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const topLevelKeys = (
  doc: Record<string, unknown> | null | undefined,
  ignore: ReadonlySet<string>,
): string[] => Object.keys(doc ?? {}).filter((key) => !ALWAYS_IGNORED.has(key) && !ignore.has(key))

/**
 * The document as an audit snapshot: secrets redacted, ignored fields and empty values left out.
 * Used for `after` on create and `before` on delete.
 */
export function snapshot(
  doc: Record<string, unknown> | null | undefined,
  options: DiffOptions = {},
): Record<string, JsonValue> {
  const redactor = new Redactor(options.secretKeys)
  const ignore = new Set(options.ignore ?? [])
  const out: Record<string, JsonValue> = {}
  for (const key of topLevelKeys(doc, ignore)) {
    const value = redactor.value(doc![key], key)
    if (!isEmpty(value)) out[key] = value
  }
  return out
}

/**
 * Paths that differ between `before` and `after`, with their redacted values. Empty values (`null`,
 * `''`, `[]`, `{}`) are treated as equal, so a field Payload fills with `null` on save is no change.
 */
export function diffDocs(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  options: DiffOptions = {},
): Diff {
  const redactor = new Redactor(options.secretKeys)
  const ignore = new Set(options.ignore ?? [])
  const result: Diff = { changedFields: [], before: {}, after: {} }

  const visit = (path: string, key: string, a: unknown, b: unknown, depth: number) => {
    if (
      !redactor.isSecret(key) &&
      depth < MAX_DIFF_DEPTH &&
      (isPlainObject(a) || isPlainObject(b)) &&
      !(isPlainObject(a) && isPopulatedDoc(a)) &&
      !(isPlainObject(b) && isPopulatedDoc(b)) &&
      (a === null || a === undefined || isPlainObject(a)) &&
      (b === null || b === undefined || isPlainObject(b))
    ) {
      const left = (a ?? {}) as Record<string, unknown>
      const right = (b ?? {}) as Record<string, unknown>
      const keys = new Set([...Object.keys(left), ...Object.keys(right)])
      for (const child of [...keys].sort()) {
        if (ALWAYS_IGNORED.has(child)) continue
        visit(`${path}.${child}`, child, left[child], right[child], depth + 1)
      }
      return
    }
    const left = redactor.value(a, key)
    const right = redactor.value(b, key)
    if (isEmpty(left) && isEmpty(right)) return
    if (redactor.isSecret(key)) {
      // Both sides read `[redacted]`: compare the raw values to learn whether the secret changed.
      if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) return
    } else if (stable(left) === stable(right)) {
      return
    }
    result.changedFields.push(path)
    result.before[path] = left
    result.after[path] = right
  }

  const keys = new Set([...topLevelKeys(before, ignore), ...topLevelKeys(after, ignore)])
  for (const key of [...keys].sort()) {
    visit(key, key, before?.[key], after?.[key], 1)
  }
  return result
}

/** Redacts an arbitrary metadata object the same way as snapshots (secret keys, URL credentials). */
export function redactMetadata(
  value: Record<string, unknown> | null | undefined,
): Record<string, JsonValue> | null {
  if (!value) return null
  return new Redactor().value(value) as Record<string, JsonValue>
}
