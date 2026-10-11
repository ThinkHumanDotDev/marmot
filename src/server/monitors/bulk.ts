/**
 * Bulk actions on monitors (#124): `POST /api/orgs/:orgId/monitors/bulk` with
 * `{ ids, action, payload }`.
 *
 * Every monitor goes through the same path as its single-monitor route: the Local API as the
 * request user with `overrideAccess: false`, so collection access, the `beforeChange` hooks
 * (organization references, plan limits), the scheduler sync, the realtime deltas and the audit hooks
 * all run per monitor. Each changed monitor therefore gets its own audit row (`monitor.paused`,
 * `monitor.updated`, `monitor.deleted`, …), tagged with `metadata.bulk` so the log shows they
 * belong to one request.
 *
 * Writes are independent (one Local API operation each, processed in order): a failure is reported
 * for its id and the others still apply, the same on Postgres and on MongoDB without transactions.
 * Everything that can be checked up front (permission, size, payload, referenced tags and channels,
 * API key budget) is, so a request is refused as a whole before anything changes.
 */
import type { Payload } from 'payload'
import { type BulkErrorCode, type BulkResponse, type BulkResult } from '@/lib/monitor-bulk'
import { supportsCheckNow } from '@/lib/on-demand-check'
import { isRemoteMonitor } from '@/lib/probe-locations'
import type { Monitor } from '@/payload-types'
import { AUDIT_METADATA_CONTEXT } from '@/server/audit/context'
import { apiKeyOf } from '@/server/auth/request-auth'
import { enqueueOnDemandCheck, onDemandWaitMs } from '@/server/engine/on-demand'
import { MANUAL_CHECK_JOB_NAME } from '@/server/engine/names'
import type { ErrorKey } from '@/server/errors'
import { populateMonitorTags, toRealtimeMonitor } from '@/server/realtime/serialize'
import { errorMessageFor, errorText } from '@/server/request-locale'
import { apiKeyWriteLimiter, onDemandCheckLimiter } from '@/server/security/limiters'
import type { RateLimiter } from '@/server/security/rate-limit'
import { tooManyRequests } from '@/server/security/rate-limit'

import type { MonitorBulkBody } from './bulk-schema'
import { jsonError, relationId, type RequestUser, type RouteId } from './http'

type Id = string | number
const key = (value: unknown): string => String(relationId(value) ?? '')

export interface BulkContext {
  payload: Payload
  request: Request
  user: RequestUser
  orgId: RouteId
  /** Limiters, replaceable in tests. */
  limiters?: { apiKeyWrite?: RateLimiter | null; onDemand?: RateLimiter }
}

/** Ids as the database stores them (numbers on Postgres), de-duplicated, request order kept. */
function normalizeIds(payload: Payload, ids: readonly Id[]): Id[] {
  const seen = new Map<string, Id>()
  for (const raw of ids) {
    const value =
      payload.db.defaultIDType === 'number' && /^\d+$/.test(String(raw)) ? Number(raw) : String(raw)
    if (!seen.has(String(value))) seen.set(String(value), value)
  }
  return [...seen.values()]
}

/**
 * Referenced tags or channels the user can read in the organization; the ids that are not are
 * reported as a 400 before anything changes.
 */
async function missingReferences(
  ctx: BulkContext,
  collection: 'tags' | 'notifications',
  ids: readonly Id[],
): Promise<string[]> {
  const unique = normalizeIds(ctx.payload, ids)
  const { docs } = await ctx.payload.find({
    collection,
    where: { and: [{ id: { in: unique } }, { organization: { equals: ctx.orgId } }] },
    select: { organization: true },
    depth: 0,
    limit: unique.length,
    pagination: false,
    user: ctx.user,
    overrideAccess: false,
  })
  const found = new Set(docs.map((doc) => String(doc.id)))
  return unique.map(String).filter((value) => !found.has(value))
}

const failure = (
  ctx: BulkContext,
  monitorId: string,
  error: BulkErrorCode,
  message: ErrorKey | { text: string },
): BulkResult => ({
  id: monitorId,
  ok: false,
  error,
  message: typeof message === 'string' ? errorText(ctx.request, message) : message.text,
})

type TagRows = NonNullable<Monitor['tags']>

/** The monitor's tag rows after the action, or `null` when nothing changes. */
function nextTags(monitor: Monitor, body: MonitorBulkBody): TagRows | null {
  const rows = (monitor.tags ?? []).map((row) => ({ ...row, tag: relationId(row.tag)! })) as TagRows
  const wanted = body.payload?.tags ?? []
  if (body.action === 'removeTags') {
    const remove = new Set(wanted.map((row) => String(row.tag)))
    const kept = rows.filter((row) => !remove.has(key(row.tag)))
    return kept.length === rows.length ? null : kept
  }
  let changed = false
  for (const row of wanted) {
    const existing = rows.find((current) => key(current.tag) === String(row.tag))
    if (!existing) {
      rows.push({ tag: row.tag as never, value: row.value ?? null })
      changed = true
    } else if (row.value !== undefined && (existing.value ?? null) !== (row.value ?? null)) {
      existing.value = row.value ?? null
      changed = true
    }
  }
  return changed ? rows : null
}

/** The monitor's channel ids after the action, or `null` when nothing changes. */
function nextNotifications(monitor: Monitor, body: MonitorBulkBody): Id[] | null {
  const current = (monitor.notifications ?? [])
    .map((value) => relationId(value))
    .filter((value): value is Id => value !== null)
  const wanted = body.payload?.notifications ?? []
  if (body.action === 'removeNotifications') {
    const remove = new Set(wanted.map(String))
    const kept = current.filter((value) => !remove.has(String(value)))
    return kept.length === current.length ? null : kept
  }
  const have = new Set(current.map(String))
  const added = wanted.filter((value) => !have.has(String(value)))
  return added.length === 0 ? null : [...current, ...added]
}

/** The `data` of the update an action makes on `monitor`, or `null` when there is nothing to do. */
function updateFor(monitor: Monitor, body: MonitorBulkBody): Partial<Monitor> | null {
  switch (body.action) {
    case 'pause':
      return monitor.active === false ? null : { active: false }
    case 'resume':
      return monitor.active !== false ? null : { active: true }
    case 'addTags':
    case 'removeTags': {
      const tags = nextTags(monitor, body)
      return tags ? { tags } : null
    }
    case 'addNotifications':
    case 'removeNotifications': {
      const notifications = nextNotifications(monitor, body)
      return notifications ? { notifications: notifications as never } : null
    }
    default:
      return null
  }
}

/** Queue a recorded "Check now" (`manual-check`) without waiting for the result. */
async function queueCheck(
  ctx: BulkContext,
  monitor: Monitor,
  budget: { exhausted: boolean },
): Promise<BulkResult> {
  const monitorId = String(monitor.id)
  if (!supportsCheckNow(monitor.type)) {
    return failure(ctx, monitorId, 'notApplicable', 'checkNotApplicable')
  }
  if (monitor.active === false) {
    return failure(ctx, monitorId, 'notApplicable', 'monitorPausedNoCheck')
  }
  if (isRemoteMonitor(monitor)) return failure(ctx, monitorId, 'notApplicable', 'checkOnProbe')
  // The organization's on-demand budget (`ON_DEMAND_CHECKS_PER_MINUTE`) is spent per monitor,
  // exactly as one "Check now" request per monitor would.
  if (!budget.exhausted) {
    const limiter = ctx.limiters?.onDemand ?? onDemandCheckLimiter
    budget.exhausted = !(await limiter.consume(String(ctx.orgId))).allowed
  }
  if (budget.exhausted) return failure(ctx, monitorId, 'rateLimited', 'tooManyRequests')
  const waitMs = onDemandWaitMs(monitor)
  try {
    await enqueueOnDemandCheck(
      {
        name: MANUAL_CHECK_JOB_NAME,
        data: { monitorId, record: true, deadline: Date.now() + waitMs },
        dedupeKey: `manual-${monitorId}-record`,
      },
      waitMs,
    )
    return { id: monitorId, ok: true }
  } catch {
    return failure(ctx, monitorId, 'failed', 'checkFailed')
  }
}

/**
 * Spends the extra write budget of an API key: the request itself paid one point when it was
 * authenticated, a bulk request costs one per monitor, like the single-monitor routes would.
 */
async function spendApiKeyBudget(ctx: BulkContext, count: number): Promise<Response | null> {
  const apiKey = apiKeyOf(ctx.user)
  const limiter =
    ctx.limiters && 'apiKeyWrite' in ctx.limiters ? ctx.limiters.apiKeyWrite : apiKeyWriteLimiter
  if (!apiKey || !limiter || count <= 1) return null
  if (count > limiter.points) {
    return jsonError(400, errorText(ctx.request, 'bulkTooManyMonitors', { max: limiter.points }))
  }
  const decision = await limiter.consume(apiKey.id, count - 1)
  return decision.allowed ? null : tooManyRequests(decision, ctx.request)
}

/**
 * Runs a validated bulk request. Returns the response body, or a `Response` when the request is
 * refused as a whole (unknown references, API key budget).
 */
export async function runMonitorBulkAction(
  ctx: BulkContext,
  body: MonitorBulkBody,
): Promise<BulkResponse | Response> {
  const { payload, user, orgId } = ctx
  const ids = normalizeIds(payload, body.ids)

  if (body.payload?.tags && (body.action === 'addTags' || body.action === 'removeTags')) {
    const missing = await missingReferences(
      ctx,
      'tags',
      body.payload.tags.map((row) => row.tag),
    )
    if (missing.length > 0) {
      return jsonError(
        400,
        errorText(ctx.request, 'unknownTags', { count: missing.length, ids: missing.join(', ') }),
      )
    }
  }
  if (
    body.payload?.notifications &&
    (body.action === 'addNotifications' || body.action === 'removeNotifications')
  ) {
    const missing = await missingReferences(ctx, 'notifications', body.payload.notifications)
    if (missing.length > 0) {
      return jsonError(
        400,
        errorText(ctx.request, 'unknownNotificationChannels', {
          count: missing.length,
          ids: missing.join(', '),
        }),
      )
    }
  }

  const limited = await spendApiKeyBudget(ctx, ids.length)
  if (limited) return limited

  // Monitors of the organization the user can see; anything else is reported as not found
  // (the same answer for missing, foreign and hidden monitors, as the single-monitor routes give).
  const { docs } = await payload.find({
    collection: 'monitors',
    where: { and: [{ id: { in: ids } }, { organization: { equals: orgId } }] },
    depth: 0,
    limit: ids.length,
    pagination: false,
    user,
    overrideAccess: false,
  })
  const byId = new Map((docs as Monitor[]).map((doc) => [String(doc.id), doc]))

  const context = {
    [AUDIT_METADATA_CONTEXT]: { bulk: { action: body.action, count: ids.length } },
  }
  const budget = { exhausted: false }
  const results: BulkResult[] = []
  const updated: Monitor[] = []

  for (const monitorId of ids) {
    const monitor = byId.get(String(monitorId))
    if (!monitor) {
      results.push(failure(ctx, String(monitorId), 'notFound', 'monitorNotFound'))
      continue
    }
    if (body.action === 'check') {
      results.push(await queueCheck(ctx, monitor, budget))
      continue
    }
    try {
      if (body.action === 'delete') {
        await payload.delete({
          collection: 'monitors',
          id: monitor.id,
          user,
          overrideAccess: false,
          depth: 0,
          context,
        })
        results.push({ id: String(monitor.id), ok: true })
        continue
      }
      const data = updateFor(monitor, body)
      if (!data) {
        results.push({ id: String(monitor.id), ok: true, unchanged: true })
        continue
      }
      const doc = await payload.update({
        collection: 'monitors',
        id: monitor.id,
        data,
        user,
        overrideAccess: false,
        depth: 0,
        context,
      })
      updated.push(doc)
      results.push({ id: String(doc.id), ok: true })
    } catch (error) {
      results.push(
        failure(ctx, String(monitor.id), 'failed', {
          text: errorMessageFor(ctx.request, error, 'unexpected'),
        }),
      )
    }
  }

  // The changed monitors in their list shape, so a client without a live socket can update too.
  if (updated.length > 0) {
    const shaped = new Map(
      (await populateMonitorTags(payload, updated)).map((doc) => [
        String(doc.id),
        toRealtimeMonitor(doc),
      ]),
    )
    for (const result of results) {
      if (result.ok && shaped.has(result.id)) result.monitor = shaped.get(result.id)
    }
  }

  const summary = { changed: 0, unchanged: 0, failed: 0 }
  for (const result of results) {
    if (!result.ok) summary.failed++
    else if (result.unchanged) summary.unchanged++
    else summary.changed++
  }
  return { action: body.action, results, summary }
}
