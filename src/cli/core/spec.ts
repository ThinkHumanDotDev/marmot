/**
 * Monitors-as-code files (#116): a YAML or JSON document with a `monitors` list.
 *
 *   version: 1
 *   monitors:
 *     - key: api                 # stable identifier, unique per organization
 *       name: API
 *       type: http
 *       url: https://api.example.com/health
 *       interval: 30
 *       parent: backend          # key of a group monitor
 *       notifications: [Ops Slack]   # channel names; omit to leave the monitor's channels alone
 *       tags: [prod, { tag: region, value: eu }]
 *       basicAuthPass: ${API_PASSWORD}
 *
 * Every other field is a field of the monitor form (`src/lib/validation/monitor.ts`), validated with
 * the same zod schema the API uses; fields left out take the form's defaults for the type. Strings
 * may reference environment variables as `${NAME}` or `${NAME:-default}` (`$${` is a literal `${`).
 * A Marmot export (`format: marmot`) is accepted too and converted on the fly.
 */
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

import { detectImportFormat } from '@/lib/import-export'
import { slugify } from '@/lib/slugify'
import {
  createMonitorFormSchema,
  defaultMonitorValues,
  MONITOR_KEY_MAX_LENGTH,
  MONITOR_KEY_PATTERN,
  MONITOR_TYPE_NAMES,
} from '@/lib/validation/monitor'

import { t } from '../text'

export const SPEC_VERSION = 1

export type TagRef = string | { tag: string; value?: string | null }

export interface MonitorSpec {
  key: string
  name: string
  type: string
  /** Key of the parent group monitor. */
  parent?: string | null
  /** Notification channel names; `undefined` leaves the monitor's channels unmanaged. */
  notifications?: string[]
  tags?: TagRef[]
  /** `undefined` leaves the paused/active state unmanaged. */
  active?: boolean
  [field: string]: unknown
}

export interface SpecDocument {
  version: typeof SPEC_VERSION
  monitors: MonitorSpec[]
}

export interface SpecIssue {
  path: string
  message: string
}

/** The file cannot be used: syntax, envelope or field errors (exit code 2). */
export class SpecError extends Error {
  readonly issues: SpecIssue[]

  constructor(issues: SpecIssue[]) {
    super(issues.map((issue) => (issue.path ? `${issue.path}: ` : '') + issue.message).join('\n'))
    this.name = 'SpecError'
    this.issues = issues
  }
}

/** Monitor form fields a file entry may set (besides `key`, `name` and `type`). */
export const MONITOR_SPEC_FIELDS: readonly string[] = Object.keys(defaultMonitorValues())

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Parses YAML (a superset of JSON) into plain data. */
export function parseSpecText(text: string): unknown {
  try {
    return parseYaml(text, { prettyErrors: true, uniqueKeys: true })
  } catch (error) {
    throw new SpecError([
      { path: '', message: error instanceof Error ? error.message : String(error) },
    ])
  }
}

const ENV_REFERENCE = /\$\$\{|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/**
 * Replaces `${NAME}` / `${NAME:-default}` in every string of `value` with values from `env`.
 * References to unset variables without a default are reported as issues.
 */
export function interpolateEnv(
  value: unknown,
  env: Record<string, string | undefined>,
  path = '',
  issues: SpecIssue[] = [],
): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_REFERENCE, (match, name: string | undefined, fallback?: string) => {
      if (name === undefined) return '${'
      const resolved = env[name]
      if (resolved !== undefined && resolved !== '') return resolved
      if (fallback !== undefined) return fallback
      issues.push({ path, message: t('spec.envMissing', { name }) })
      return match
    })
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => interpolateEnv(item, env, `${path}[${index}]`, issues))
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = interpolateEnv(item, env, path ? `${path}.${key}` : key, issues)
    }
    return out
  }
  return value
}

const ENVELOPE_KEYS = new Set(['version', 'monitors', '$schema'])
const ENTRY_KEYS = new Set(['key', 'name', 'type', ...MONITOR_SPEC_FIELDS])

/** Reads a parsed file into a `SpecDocument`, checking the envelope and keys (not field values). */
export function readSpecDocument(
  raw: unknown,
  env: Record<string, string | undefined> = {},
): { document: SpecDocument; warnings: string[] } {
  if (detectImportFormat(raw) === 'marmot') {
    const converted = fromMarmotExport(raw as Record<string, unknown>)
    return readConverted(converted.document, env, converted.warnings)
  }
  return readConverted(raw, env, [])
}

function readConverted(
  raw: unknown,
  env: Record<string, string | undefined>,
  warnings: string[],
): { document: SpecDocument; warnings: string[] } {
  const issues: SpecIssue[] = []
  if (!isRecord(raw)) throw new SpecError([{ path: '', message: t('spec.notAnObject') }])
  for (const key of Object.keys(raw)) {
    if (!ENVELOPE_KEYS.has(key)) issues.push({ path: key, message: t('spec.unknownField') })
  }
  if (raw.version !== undefined && raw.version !== SPEC_VERSION) {
    issues.push({ path: 'version', message: t('spec.version', { version: SPEC_VERSION }) })
  }
  const list = raw.monitors ?? []
  if (!Array.isArray(list)) {
    throw new SpecError([...issues, { path: 'monitors', message: t('spec.monitorsList') }])
  }

  const interpolated = interpolateEnv(list, env, 'monitors', issues) as unknown[]
  const seen = new Map<string, number>()
  const monitors: MonitorSpec[] = []
  interpolated.forEach((entry, index) => {
    const at = `monitors[${index}]`
    if (!isRecord(entry)) {
      issues.push({ path: at, message: t('spec.notAnObject') })
      return
    }
    const key = typeof entry.key === 'number' ? String(entry.key) : entry.key
    if (typeof key !== 'string' || !key.trim()) {
      issues.push({ path: `${at}.key`, message: t('spec.keyRequired') })
    } else if (key.length > MONITOR_KEY_MAX_LENGTH || !MONITOR_KEY_PATTERN.test(key)) {
      issues.push({ path: `${at}.key`, message: t('spec.keyInvalid', { key }) })
    } else if (seen.has(key)) {
      issues.push({
        path: `${at}.key`,
        message: t('spec.keyDuplicate', { key, index: seen.get(key) ?? 0 }),
      })
    } else {
      seen.set(key, index)
    }
    if (typeof entry.name !== 'string' || !entry.name.trim()) {
      issues.push({ path: `${at}.name`, message: t('spec.nameRequired') })
    }
    if (!MONITOR_TYPE_NAMES.includes(entry.type as never)) {
      issues.push({ path: `${at}.type`, message: t('spec.typeInvalid') })
    }
    for (const field of Object.keys(entry)) {
      if (!ENTRY_KEYS.has(field))
        issues.push({ path: `${at}.${field}`, message: t('spec.unknownField') })
    }
    if (entry.parent !== undefined && entry.parent !== null) {
      entry.parent = String(entry.parent)
    }
    if (entry.notifications !== undefined) {
      if (
        !Array.isArray(entry.notifications) ||
        entry.notifications.some((n) => typeof n !== 'string')
      ) {
        issues.push({ path: `${at}.notifications`, message: t('spec.namesList') })
      }
    }
    if (entry.tags !== undefined) {
      const valid =
        Array.isArray(entry.tags) &&
        entry.tags.every(
          (tag) =>
            typeof tag === 'string' ||
            (isRecord(tag) &&
              typeof tag.tag === 'string' &&
              (tag.value === undefined || tag.value === null || typeof tag.value === 'string')),
        )
      if (!valid) issues.push({ path: `${at}.tags`, message: t('spec.tagsList') })
    }
    monitors.push({ ...entry, key: String(key) } as MonitorSpec)
  })

  if (issues.length > 0) throw new SpecError(issues)
  return { document: { version: SPEC_VERSION, monitors }, warnings }
}

/**
 * Converts a Marmot export (`GET /api/orgs/:orgId/export`) into a monitors document: ids become keys
 * (the exported `key` when there is one), channel ids become channel names. Tags, proxies and Docker
 * hosts are instance-specific ids the export does not name, so they are dropped with a warning,
 * like the server-side importer does.
 */
export function fromMarmotExport(file: Record<string, unknown>): {
  document: Record<string, unknown>
  warnings: string[]
} {
  const warnings: string[] = []
  const channels = new Map<string, string>()
  for (const channel of Array.isArray(file.notifications) ? file.notifications : []) {
    if (isRecord(channel) && channel.id !== undefined && typeof channel.name === 'string') {
      channels.set(String(channel.id), channel.name)
    }
  }
  const exported = (Array.isArray(file.monitors) ? file.monitors : []).filter(isRecord)
  const taken = new Set(
    exported.flatMap((m) => (typeof m.key === 'string' && m.key ? [m.key] : [])),
  )
  const keyById = new Map<string, string>()
  for (const monitor of exported) {
    const key =
      typeof monitor.key === 'string' && monitor.key
        ? monitor.key
        : uniqueKey(String(monitor.name ?? 'monitor'), taken)
    keyById.set(String(monitor.id), key)
  }
  const monitors = exported.map((monitor) => {
    const {
      id,
      parent,
      notifications,
      tags,
      proxy,
      dockerHost,
      locations,
      pushToken: _p,
      ...fields
    } = monitor
    const entry: Record<string, unknown> = { ...fields, key: keyById.get(String(id)) }
    if (parent !== null && parent !== undefined) {
      entry.parent = keyById.get(String(parent)) ?? null
    }
    if (Array.isArray(notifications)) {
      entry.notifications = notifications.flatMap((n) => {
        const name = channels.get(String(n))
        return name ? [name] : []
      })
    }
    const dropped = [
      Array.isArray(tags) && tags.length > 0 ? 'tags' : null,
      proxy !== null && proxy !== undefined ? 'proxy' : null,
      dockerHost !== null && dockerHost !== undefined ? 'dockerHost' : null,
      Array.isArray(locations) && locations.length > 0 ? 'locations' : null,
    ].filter(Boolean)
    if (dropped.length > 0) {
      warnings.push(
        t('spec.exportFieldsDropped', { name: String(fields.name), fields: dropped.join(', ') }),
      )
    }
    return entry
  })
  return { document: { version: SPEC_VERSION, monitors }, warnings }
}

/** A key derived from `name` that is not in `taken` (and is added to it). */
export function uniqueKey(name: string, taken: Set<string>): string {
  const base = slugify(name) || 'monitor'
  let candidate = base
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}`
  taken.add(candidate)
  return candidate
}

/**
 * JSON Schema of a monitors document for editor autocomplete (`marmot monitors schema`). Generated
 * from the monitor form schema; references (parent, channels, tags) are names instead of ids.
 */
export function monitorsDocumentJsonSchema(): Record<string, unknown> {
  const form = createMonitorFormSchema((key) => key)
  const shape: Record<string, z.ZodType> = {}
  for (const [field, schema] of Object.entries(form.shape)) {
    shape[field] = (schema as z.ZodType).optional()
  }
  const entry = z.object({
    ...shape,
    key: z
      .string()
      .regex(MONITOR_KEY_PATTERN)
      .max(MONITOR_KEY_MAX_LENGTH)
      .describe('Stable identifier of the monitor, unique per organization'),
    name: z.string().min(1).max(150),
    type: z.enum(MONITOR_TYPE_NAMES),
    parent: z.string().nullish().describe('Key of the parent group monitor'),
    notifications: z
      .array(z.string())
      .optional()
      .describe('Notification channel names; omit to keep the channels set in Marmot'),
    tags: z
      .array(z.union([z.string(), z.object({ tag: z.string(), value: z.string().nullish() })]))
      .optional()
      .describe('Tag names, optionally with a value; missing tags are created'),
    active: z.boolean().optional().describe('false pauses the monitor; omit to leave it as is'),
  })
  const document = z.object({
    $schema: z.string().optional(),
    version: z.literal(SPEC_VERSION).optional(),
    monitors: z.array(entry),
  })
  const json = z.toJSONSchema(document, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>
  return { ...json, title: 'Marmot monitors' }
}
