/**
 * Apply: carries out a prepared plan through the management API. Order: missing tags, creates
 * (parent groups before their children), updates (only the changed fields), deletes. Stops at the
 * first failure and reports how far it got; running `apply` again picks up from there because the
 * plan is recomputed from the server state.
 */
import type { Id, MonitorDoc, NamedDoc } from './client'
import type { DesiredMonitor, FieldChange, MonitorChange, PreparedPlan } from './plan'

/** The part of `MarmotClient` apply needs. */
export interface ApplyApi {
  createMonitor(body: Record<string, unknown>): Promise<MonitorDoc>
  updateMonitor(id: Id, body: Record<string, unknown>): Promise<MonitorDoc>
  deleteMonitor(id: Id): Promise<unknown>
  createTag(name: string): Promise<NamedDoc>
}

export interface ApplyResult {
  created: { key: string; id: Id }[]
  updated: { key: string; id: Id }[]
  deleted: { key: string; id: Id }[]
  tagsCreated: string[]
}

/** A change failed; `result` holds what was done before it. */
export class ApplyError extends Error {
  readonly change: MonitorChange | null
  readonly result: ApplyResult
  readonly cause: unknown

  constructor(change: MonitorChange | null, cause: unknown, result: ApplyResult) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'ApplyError'
    this.change = change
    this.cause = cause
    this.result = result
  }
}

export interface ApplyOptions {
  /** Called after each change was applied. */
  onChange?: (change: MonitorChange) => void
}

/** Creates in an order where a parent created in the same run comes before its children. */
function orderCreates(creates: MonitorChange[], desired: Map<string, DesiredMonitor>) {
  const keys = new Set(creates.map((c) => c.key))
  const depth = (key: string): number => {
    let d = 0
    const seen = new Set<string>()
    let parent = desired.get(key)?.values.parent ?? null
    while (parent && keys.has(parent) && !seen.has(parent)) {
      seen.add(parent)
      d++
      parent = desired.get(parent)?.values.parent ?? null
    }
    return d
  }
  return creates
    .map((change, index) => ({ change, index, depth: depth(change.key) }))
    .sort((a, b) => a.depth - b.depth || a.index - b.index)
    .map(({ change }) => change)
}

export async function applyPlan(
  api: ApplyApi,
  prepared: PreparedPlan,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const { plan, desired, state } = prepared
  const result: ApplyResult = { created: [], updated: [], deleted: [], tagsCreated: [] }

  const tagIds = new Map(state.tags.map((tag) => [tag.name, tag.id]))
  const channelIds = new Map((state.notifications ?? []).map((n) => [n.name, n.id]))
  /** Monitor reference (key or `#<id>`) → id. */
  const monitorIds = new Map<string, Id>()
  for (const doc of state.monitors) {
    monitorIds.set(`#${doc.id}`, doc.id)
    if (doc.key) monitorIds.set(doc.key, doc.id)
  }
  for (const change of plan.changes) {
    if (change.id !== null && change.action !== 'delete') monitorIds.set(change.key, change.id)
  }

  const resolveRef = <T>(map: Map<string, T>, ref: string): T | string => {
    const id = map.get(ref)
    if (id !== undefined) return id
    // `#<id>` references an existing document directly.
    return ref.startsWith('#') ? ref.slice(1) : ref
  }

  /** Request body for `fields` of `want`, with references resolved to ids. */
  const body = (want: DesiredMonitor, fields: string[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    const values = want.values as Record<string, unknown>
    for (const field of fields) {
      if (field === 'parent') {
        out.parent = want.values.parent === null ? null : resolveRef(monitorIds, want.values.parent)
      } else if (field === 'notifications') {
        if (!want.managed.notifications) continue
        out.notifications = want.values.notifications.map((name) => resolveRef(channelIds, name))
      } else if (field === 'tags') {
        out.tags = want.values.tags.map((row) => ({
          tag: resolveRef(tagIds, row.tag),
          value: row.value,
        }))
      } else if (field === 'active') {
        if (want.managed.active) out.active = want.values.active
      } else {
        out[field] = values[field]
      }
    }
    return out
  }

  let current: MonitorChange | null = null
  try {
    for (const name of plan.createTags) {
      const tag = await api.createTag(name)
      tagIds.set(tag.name, tag.id)
      result.tagsCreated.push(tag.name)
    }

    const creates = plan.changes.filter((c) => c.action === 'create')
    for (const change of orderCreates(creates, desired)) {
      current = change
      const want = desired.get(change.key)!
      const doc = await api.createMonitor(body(want, Object.keys(want.values)))
      monitorIds.set(change.key, doc.id)
      result.created.push({ key: change.key, id: doc.id })
      options.onChange?.(change)
    }

    for (const change of plan.changes.filter((c) => c.action === 'update')) {
      current = change
      const want = desired.get(change.key)!
      const fields = change.fields.map((f: FieldChange) => f.field)
      await api.updateMonitor(change.id as Id, body(want, fields))
      result.updated.push({ key: change.key, id: change.id as Id })
      options.onChange?.(change)
    }

    for (const change of plan.changes.filter((c) => c.action === 'delete')) {
      current = change
      await api.deleteMonitor(change.id as Id)
      result.deleted.push({ key: change.key, id: change.id as Id })
      options.onChange?.(change)
    }
  } catch (error) {
    throw new ApplyError(current, error, result)
  }
  return result
}
