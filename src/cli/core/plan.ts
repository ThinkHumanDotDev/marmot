/**
 * Plan: compares a monitors document with the organization's monitors and lists what `apply` would
 * create, update and delete. Pure (no I/O), so it is unit-tested directly and reusable by the
 * GitHub Action (#118).
 *
 * Both sides are compared as monitor form values (`MonitorFormValues`) in "name space": the parent is
 * referenced by key, channels and tags by name. File entries are completed with the form defaults of
 * their type and validated with the API's own schema (`monitorFormSchema`); server documents go
 * through `monitorToFormValues` and the same schema, so equal configurations compare equal.
 *
 * Matching: an entry matches the monitor with the same `key`. An entry whose key is not in use
 * adopts the one monitor without a key that has the same name and type (the key is then recorded on
 * it — that is the only change when nothing else differs); otherwise it is created. Monitors with a
 * key that are not in the file are deleted with `prune`, and only reported otherwise. Monitors
 * without a key are never deleted: the key is the ownership marker.
 */
import {
  defaultMonitorValues,
  monitorToFormValues,
  type MonitorFormValues,
  type MonitorLike,
  type MonitorTypeName,
} from '@/lib/validation/monitor'
import { monitorFormSchema } from '@/lib/validation/monitor-schema'

import { t } from '../text'
import type { Id, MonitorDoc, NamedDoc } from './client'
import { SpecError, type MonitorSpec, type SpecDocument, type SpecIssue, type TagRef } from './spec'

/** What the server holds; `notifications` is `null` when the key may not list channels. */
export interface RemoteState {
  monitors: MonitorDoc[]
  notifications: NamedDoc[] | null
  tags: NamedDoc[]
}

/** Form values with references by name: `parent` is a key (or `#<id>`), channels and tags names. */
export type NamedValues = Omit<MonitorFormValues, 'parent' | 'notifications' | 'tags'> & {
  parent: string | null
  notifications: string[]
  tags: { tag: string; value: string | null }[]
}

export interface FieldChange {
  field: string
  before: unknown
  after: unknown
  /** Credentials: renderers show that the value changed, not the value. */
  secret: boolean
}

export type ChangeAction = 'create' | 'update' | 'delete' | 'unchanged'

export interface MonitorChange {
  action: ChangeAction
  key: string
  name: string
  type: string
  /** Server id (`null` for creates). */
  id: Id | null
  /** The entry takes over a monitor that had no key yet (matched by name and type). */
  adopted: boolean
  fields: FieldChange[]
}

export interface Plan {
  changes: MonitorChange[]
  /** Tags `apply` creates before the monitors. */
  createTags: string[]
  warnings: string[]
  summary: { create: number; update: number; delete: number; unchanged: number }
}

export interface DesiredMonitor {
  values: NamedValues
  /** Fields the file sets; `notifications` and `active` are left alone when omitted. */
  managed: { notifications: boolean; active: boolean }
}

/** A plan plus what `applyPlan` needs to carry it out (kept apart: it holds secrets). */
export interface PreparedPlan {
  plan: Plan
  desired: Map<string, DesiredMonitor>
  state: RemoteState
}

export interface PlanOptions {
  /** Delete monitors with a key that the file does not list. */
  prune?: boolean
}

/** Fields whose values are credentials (masked in plan output). */
export const SECRET_FIELDS: ReadonlySet<string> = new Set([
  'basicAuthPass',
  'bearerToken',
  'oauthClientSecret',
  'tlsKey',
  'headers',
  'databaseConnectionString',
  'mqttPassword',
  'kafkaProducerSaslOptions',
  'grpcMetadata',
  'radiusPassword',
  'radiusSecret',
  'snmpCommunity',
  'sshPassword',
  'sshPrivateKey',
  'sshPassphrase',
  'rabbitmqPassword',
])

/** Every compared field, in form order. */
export const COMPARED_FIELDS: readonly string[] = Object.keys(defaultMonitorValues())

/** Stable JSON (sorted object keys) for comparisons. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** Ids compare as strings (numbers on Postgres, strings on MongoDB). */
const ID_FIELDS = new Set(['proxy', 'dockerHost'])

const comparable = (field: string, value: unknown): string =>
  canonicalJson(
    ID_FIELDS.has(field) && value !== null && value !== undefined ? String(value) : value,
  )

const tagRow = (ref: TagRef): { tag: string; value: string | null } =>
  typeof ref === 'string' ? { tag: ref, value: null } : { tag: ref.tag, value: ref.value ?? null }

const byTagName = (a: { tag: string }, b: { tag: string }) =>
  a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0

/** Sorts the order-insensitive lists so they compare equal regardless of order. */
function normalizeNamed(values: NamedValues): NamedValues {
  return {
    ...values,
    notifications: [...values.notifications].sort(),
    tags: [...values.tags].sort(byTagName),
  }
}

/** Validates `input` with the API schema; references are names, which the schema accepts as ids. */
function validate(input: Record<string, unknown>): { values?: NamedValues; issues: SpecIssue[] } {
  const parsed = monitorFormSchema.safeParse(input)
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    }
  }
  return { values: normalizeNamed(parsed.data as unknown as NamedValues), issues: [] }
}

/** File entry → desired values (defaults of the type filled in). */
export function desiredMonitor(entry: MonitorSpec): {
  desired?: DesiredMonitor
  issues: SpecIssue[]
} {
  const { notifications, active, tags, parent, ...fields } = entry
  const type = entry.type as MonitorTypeName
  const result = validate({
    ...defaultMonitorValues(type),
    ...fields,
    parent: parent ?? null,
    tags: (tags ?? []).map(tagRow),
    notifications: notifications ?? [],
    active: active ?? true,
  })
  if (!result.values) return { issues: result.issues }
  return {
    desired: {
      values: result.values,
      managed: { notifications: notifications !== undefined, active: active !== undefined },
    },
    issues: [],
  }
}

/** How documents are referenced by name: the parent by its (effective) key, channels and tags by name. */
export interface NameLookup {
  monitorRef(id: Id): string
  channelName(id: Id): string
  tagName(id: Id): string
}

/** Server document → values in name space (unknown references become `#<id>`). */
export function currentValues(doc: MonitorDoc, lookup: NameLookup): NamedValues {
  const form = monitorToFormValues(doc as MonitorLike)
  const named = {
    ...form,
    key: doc.key ?? null,
    parent: form.parent === null ? null : lookup.monitorRef(form.parent),
    notifications: form.notifications.map((id) => lookup.channelName(id)),
    tags: form.tags.map((row) => ({ tag: lookup.tagName(row.tag), value: row.value ?? null })),
  } as unknown as Record<string, unknown>
  // Same normalization as the file side; documents that no longer validate are compared as stored.
  return validate(named).values ?? normalizeNamed(named as unknown as NamedValues)
}

/** Field-by-field differences of `desired` against `current` (`null` for a create). */
export function diffValues(desired: DesiredMonitor, current: NamedValues | null): FieldChange[] {
  const changes: FieldChange[] = []
  for (const field of COMPARED_FIELDS) {
    if (field === 'notifications' && !desired.managed.notifications) continue
    if (field === 'active' && !desired.managed.active) continue
    // Probe locations (#91) are assigned in the UI; files leave them alone for now.
    if (field === 'locations') continue
    const after = (desired.values as Record<string, unknown>)[field]
    const before = current ? (current as Record<string, unknown>)[field] : undefined
    if (current && comparable(field, before) === comparable(field, after)) continue
    if (!current && field !== 'key' && field !== 'name' && field !== 'type') {
      // Creates list the fields that differ from the type's defaults.
      const fallback = (defaultMonitorValues(desired.values.type) as Record<string, unknown>)[field]
      if (comparable(field, fallback) === comparable(field, after)) continue
    }
    changes.push({ field, before: before ?? null, after, secret: SECRET_FIELDS.has(field) })
  }
  return changes
}

/** Lookups for a server state, with the keys entries will give adopted monitors. */
export function nameLookup(
  state: RemoteState,
  adoptedKeys: Map<string, string> = new Map(),
): NameLookup {
  const monitorKeys = new Map(
    state.monitors.map((m) => [String(m.id), adoptedKeys.get(String(m.id)) ?? m.key ?? null]),
  )
  const channels = new Map((state.notifications ?? []).map((n) => [String(n.id), n.name]))
  const tags = new Map(state.tags.map((tag) => [String(tag.id), tag.name]))
  return {
    monitorRef: (id) => monitorKeys.get(String(id)) ?? `#${id}`,
    channelName: (id) => channels.get(String(id)) ?? `#${id}`,
    tagName: (id) => tags.get(String(id)) ?? `#${id}`,
  }
}

/**
 * Computes the plan. Throws `SpecError` when entries do not validate or reference parents and
 * channels that do not exist.
 */
export function planMonitors(
  document: SpecDocument,
  state: RemoteState,
  options: PlanOptions = {},
): PreparedPlan {
  const issues: SpecIssue[] = []
  const warnings: string[] = []

  // ---- Match entries to monitors ----------------------------------------------------------------
  const byKey = new Map(state.monitors.filter((m) => m.key).map((m) => [m.key as string, m]))
  const matched = new Map<string, { doc: MonitorDoc; adopted: boolean }>()
  const adoptedIds = new Set<string>()
  for (const entry of document.monitors) {
    const doc = byKey.get(entry.key)
    if (doc) matched.set(entry.key, { doc, adopted: false })
  }
  for (const entry of document.monitors) {
    if (matched.has(entry.key)) continue
    const candidates = state.monitors.filter(
      (m) =>
        !m.key && !adoptedIds.has(String(m.id)) && m.name === entry.name && m.type === entry.type,
    )
    if (candidates.length === 1) {
      matched.set(entry.key, { doc: candidates[0], adopted: true })
      adoptedIds.add(String(candidates[0].id))
    } else if (candidates.length > 1) {
      warnings.push(t('plan.adoptAmbiguous', { key: entry.key, count: candidates.length }))
    }
  }
  const adoptedKeys = new Map(
    [...matched].filter(([, m]) => m.adopted).map(([key, m]) => [String(m.doc.id), key]),
  )
  const lookup = nameLookup(state, adoptedKeys)

  // ---- Validate entries and their references ----------------------------------------------------
  const fileKeys = new Set(document.monitors.map((m) => m.key))
  const serverRefs = new Set(state.monitors.map((m) => lookup.monitorRef(m.id)))
  const channelNames = state.notifications ? new Set(state.notifications.map((n) => n.name)) : null
  const tagNames = new Set(state.tags.map((tag) => tag.name))
  const createTags = new Set<string>()
  const desired = new Map<string, DesiredMonitor>()
  let channelsUnreadableWarned = false

  document.monitors.forEach((entry, index) => {
    const at = `monitors[${index}]`
    const result = desiredMonitor(entry)
    issues.push(...result.issues.map((issue) => ({ ...issue, path: `${at}.${issue.path}` })))
    if (!result.desired) return
    const { values, managed } = result.desired

    if (values.parent !== null) {
      if (values.parent === entry.key) {
        issues.push({ path: `${at}.parent`, message: t('plan.parentSelf') })
      } else if (!fileKeys.has(values.parent) && !serverRefs.has(values.parent)) {
        issues.push({
          path: `${at}.parent`,
          message: t('plan.parentUnknown', { key: values.parent }),
        })
      }
    }
    if (managed.notifications) {
      if (channelNames === null) {
        managed.notifications = false
        if (!channelsUnreadableWarned) warnings.push(t('plan.channelsUnreadable'))
        channelsUnreadableWarned = true
      } else {
        for (const name of values.notifications) {
          if (!channelNames.has(name)) {
            issues.push({
              path: `${at}.notifications`,
              message: t('plan.channelUnknown', { name }),
            })
          }
        }
      }
    }
    for (const row of values.tags) if (!tagNames.has(row.tag)) createTags.add(row.tag)
    desired.set(entry.key, result.desired)
  })
  // Parents must be groups (in the file or on the server).
  for (const [key, { values }] of desired) {
    if (values.parent === null) continue
    const parentType =
      desired.get(values.parent)?.values.type ??
      state.monitors.find((m) => lookup.monitorRef(m.id) === values.parent)?.type
    if (parentType && parentType !== 'group') {
      const index = document.monitors.findIndex((m) => m.key === key)
      issues.push({
        path: `monitors[${index}].parent`,
        message: t('plan.parentNotGroup', { key: values.parent }),
      })
    }
  }
  if (issues.length > 0) throw new SpecError(issues)

  // ---- Changes ------------------------------------------------------------------------------------
  const changes: MonitorChange[] = []
  for (const entry of document.monitors) {
    const want = desired.get(entry.key)!
    const match = matched.get(entry.key)
    const fields = diffValues(want, match ? currentValues(match.doc, lookup) : null)
    changes.push({
      action: !match ? 'create' : fields.length > 0 ? 'update' : 'unchanged',
      key: entry.key,
      name: want.values.name,
      type: want.values.type,
      id: match?.doc.id ?? null,
      adopted: match?.adopted ?? false,
      fields,
    })
  }

  const orphans = state.monitors.filter((m) => m.key && !fileKeys.has(m.key))
  if (options.prune) {
    for (const doc of orphans) {
      changes.push({
        action: 'delete',
        key: doc.key as string,
        name: doc.name,
        type: doc.type,
        id: doc.id,
        adopted: false,
        fields: [],
      })
    }
  } else if (orphans.length > 0) {
    warnings.push(
      t('plan.orphans', { count: orphans.length, keys: orphans.map((m) => m.key).join(', ') }),
    )
  }

  const count = (action: ChangeAction) => changes.filter((c) => c.action === action).length
  return {
    plan: {
      changes,
      createTags: [...createTags].sort(),
      warnings,
      summary: {
        create: count('create'),
        update: count('update'),
        delete: count('delete'),
        unchanged: count('unchanged'),
      },
    },
    desired,
    state,
  }
}

/** Whether `apply` would change anything. */
export const hasChanges = (plan: Plan): boolean =>
  plan.summary.create + plan.summary.update + plan.summary.delete + plan.createTags.length > 0
