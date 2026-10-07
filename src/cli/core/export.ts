/**
 * Export: the organization's monitors as a monitors document (`marmot monitors import`), compact
 * enough to review: only fields that differ from the defaults of the monitor's type are written,
 * so applying the file again is a no-op. Monitors without a key get one derived from their name;
 * the first `apply` records it on them (adoption, see `plan.ts`).
 */
import { stringify as stringifyYaml } from 'yaml'

import { defaultMonitorValues, type MonitorTypeName } from '@/lib/validation/monitor'

import {
  canonicalJson,
  COMPARED_FIELDS,
  currentValues,
  nameLookup,
  SECRET_FIELDS,
  type RemoteState,
} from './plan'
import { SPEC_VERSION, uniqueKey, type MonitorSpec, type SpecDocument } from './spec'

export interface ExportOptions {
  /** Write `${MARMOT_<KEY>_<FIELD>}` references instead of credentials. */
  redactSecrets?: boolean
}

export interface ExportResult {
  document: SpecDocument
  /** Keys derived from names for monitors that had none. */
  generatedKeys: string[]
  /** Environment variables the redacted file expects. */
  secretVariables: string[]
}

/** `MARMOT_API_HEALTH_BASIC_AUTH_PASS` for key `api-health`, field `basicAuthPass`. */
export const secretVariableName = (key: string, field: string): string =>
  `MARMOT_${key}_${field.replace(/([a-z0-9])([A-Z])/g, '$1_$2')}`
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')

export function exportMonitors(state: RemoteState, options: ExportOptions = {}): ExportResult {
  const taken = new Set(state.monitors.flatMap((m) => (m.key ? [m.key] : [])))
  const generated = new Map<string, string>()
  for (const monitor of state.monitors) {
    if (!monitor.key) generated.set(String(monitor.id), uniqueKey(monitor.name, taken))
  }
  const lookup = nameLookup(state, generated)
  const secretVariables: string[] = []

  const monitors = state.monitors.map((doc) => {
    const values = currentValues(doc, lookup) as unknown as Record<string, unknown>
    const key = (doc.key ?? generated.get(String(doc.id))) as string
    const defaults = defaultMonitorValues(values.type as MonitorTypeName) as Record<string, unknown>
    const entry: MonitorSpec = { key, name: String(values.name), type: String(values.type) }
    for (const field of COMPARED_FIELDS) {
      if (field === 'name' || field === 'type' || field === 'key') continue
      const value = values[field]
      if (canonicalJson(value) === canonicalJson(defaults[field])) continue
      if (options.redactSecrets && SECRET_FIELDS.has(field) && typeof value === 'string') {
        const variable = secretVariableName(key, field)
        secretVariables.push(variable)
        entry[field] = `\${${variable}}`
        continue
      }
      if (field === 'tags') {
        entry.tags = (value as { tag: string; value: string | null }[]).map((row) =>
          row.value === null ? row.tag : { tag: row.tag, value: row.value },
        )
        continue
      }
      entry[field] = value
    }
    return entry
  })

  return {
    document: { version: SPEC_VERSION, monitors },
    generatedKeys: [...generated.values()],
    secretVariables,
  }
}

/** The document as YAML, with an optional `$schema` comment for editors. */
export function toYaml(document: SpecDocument, schemaUrl?: string): string {
  const header = schemaUrl ? `# yaml-language-server: $schema=${schemaUrl}\n` : ''
  return header + stringifyYaml(document, { lineWidth: 0, aliasDuplicateObjects: false })
}
