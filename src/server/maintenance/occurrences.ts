/**
 * Maintenance occurrences (issue #154): the persisted lifecycle of each concrete window.
 *
 * `syncMaintenance()` is the single place where occurrences are planned and advanced. It runs
 * - in the `maintenance` collection's `afterChange` hook (same transaction as the save),
 * - from delayed `maintenance-wakeup` BullMQ jobs at each planned start, end and reminder
 *   (`queue.ts`), and
 * - from the every-minute `maintenance-status` reconciler (`job.ts`), as a safety net.
 *
 * Steps, for one maintenance at `now`:
 * 1. Plan: the current and next window (`computeMaintenanceTimeslots`) each get an occurrence,
 *    created as `scheduled` (event `scheduled`). A future occurrence whose window disappeared
 *    (schedule edited) is moved to the new next window, or dropped/cancelled.
 * 2. Advance: `scheduled` → `in-progress` at the planned start when `autoStart` is on;
 *    `in-progress`/`verifying` → `completed` at the planned end when `autoComplete` is on. With
 *    `autoStart` off an occurrence waits for an admin (until a later occurrence becomes due); with
 *    `autoComplete` off it runs past its end until an admin completes it. Starting an occurrence
 *    completes any older one still open.
 * 3. Remind: each configured offset is handled once per occurrence (`remindersSent`); reminders
 *    more than `REMINDER_GRACE_MINUTES` late are recorded as skipped instead of sent.
 * 4. Persist the effective status on the maintenance (`under-maintenance` exactly while an
 *    occurrence is open), which is what the engine's maintenance resolver reads.
 *
 * Manual maintenances have one open occurrence for as long as they are active; pausing a
 * maintenance completes its open occurrence and drops unannounced upcoming ones.
 */
import type { Payload, PayloadRequest } from 'payload'

import { afterCommit } from '@/db/after-commit'
import { LocalizedAPIError } from '@/server/errors'
import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import { publicIdOf } from '@/server/status-pages/public-ids'
import {
  canPostStatus,
  isFinishedState,
  isOpenState,
  OCCURRENCE_STATES,
  REMINDER_GRACE_MINUTES,
  REMINDER_OFFSETS,
  UNFINISHED_OCCURRENCE_STATES,
  type OccurrenceState,
  type OccurrenceSummary,
  type OccurrenceUpdate,
  type ReminderOffset,
} from '@/lib/maintenance-announcements'
import type { MaintenanceStatus } from '@/lib/validation/maintenance'
import type { Maintenance, MaintenanceOccurrence } from '@/payload-types'
import {
  dispatchMaintenanceEvents,
  eventTypeFor,
  type MaintenanceEvent,
  type MaintenanceEventType,
} from './events'
import { scheduleMaintenanceWakeups } from './queue'
import { relationId } from './serialize'
import {
  computeMaintenanceTimeslots,
  type MaintenanceTimeslots,
  type MaintenanceWindow,
} from './status'
import { getOrganizationTimezone } from './timezone'

const log = childLogger('maintenance:occurrences')

const MINUTE_MS = 60_000

type UpdateRow = NonNullable<MaintenanceOccurrence['updates']>[number]

const toMs = (value: string | null | undefined): number | null => {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? null : ms
}

const idList = (values: unknown[] | null | undefined): string[] =>
  (values ?? [])
    .map(relationId)
    .filter((id): id is string | number => id !== null)
    .map(String)

export function toOccurrenceUpdate(row: UpdateRow, index: number): OccurrenceUpdate {
  return {
    id: row.id ? String(row.id) : String(index),
    status: row.status,
    message: row.message ?? '',
    postedAt: row.postedAt,
  }
}

/** API/UI shape of an occurrence; updates newest first. */
export function toOccurrenceSummary(doc: MaintenanceOccurrence): OccurrenceSummary {
  return {
    id: String(doc.id),
    publicId: publicIdOf('maintenance-occurrences', doc),
    maintenanceId: String(relationId(doc.maintenance)),
    state: doc.state,
    start: doc.start,
    end: doc.end ?? null,
    startedAt: doc.startedAt ?? null,
    completedAt: doc.completedAt ?? null,
    cancelledAt: doc.cancelledAt ?? null,
    remindersSent: (doc.remindersSent ?? []).map(Number),
    updates: (doc.updates ?? []).map(toOccurrenceUpdate).reverse(),
  }
}

/**
 * Effective status of a maintenance: the schedule says when windows are planned, the occurrences
 * say what actually happens (a window that was not started is not running; one that was not
 * completed still is).
 */
export function effectiveMaintenanceStatus(
  doc: Pick<Maintenance, 'active' | 'strategy'>,
  slots: Pick<MaintenanceTimeslots, 'status' | 'next'>,
  occurrences: readonly Pick<MaintenanceOccurrence, 'state'>[],
): MaintenanceStatus {
  if (doc.active === false) return 'inactive'
  if (occurrences.some((o) => isOpenState(o.state))) return 'under-maintenance'
  if (doc.strategy === 'manual') return 'ended'
  if (slots.status === 'unknown' || slots.status === 'inactive') return slots.status
  if (occurrences.some((o) => o.state === 'scheduled')) return 'scheduled'
  if (slots.status === 'under-maintenance') return slots.next ? 'scheduled' : 'ended'
  return slots.status
}

// ---- Working set ---------------------------------------------------------------------------------

interface Working {
  /** Persisted id; undefined until created. */
  id?: string | number
  doc: Omit<MaintenanceOccurrence, 'id' | 'createdAt' | 'updatedAt'> & {
    id?: string | number
    createdAt?: string
    updatedAt?: string
  }
  dirty: boolean
  deleted: boolean
}

interface PendingEvent {
  type: MaintenanceEventType
  occurrence: Working
  /** Index of the update row this event added. */
  updateIndex: number | null
  reminderMinutes: number | null
  at: Date
}

class Plan {
  readonly items: Working[]
  readonly events: PendingEvent[] = []

  constructor(
    existing: MaintenanceOccurrence[],
    private readonly maintenance: Maintenance,
  ) {
    this.items = existing.map((doc) => ({
      id: doc.id,
      doc: { ...doc },
      dirty: false,
      deleted: false,
    }))
  }

  get live(): Working[] {
    return this.items.filter((o) => !o.deleted)
  }

  create(window: { start: string; end: string | null }, state: OccurrenceState, at: Date): Working {
    const item: Working = {
      doc: {
        organization: this.maintenance.organization,
        maintenance: this.maintenance.id,
        start: window.start,
        end: window.end,
        state: 'scheduled',
        remindersSent: [],
        updates: [],
      },
      dirty: true,
      deleted: false,
    }
    this.items.push(item)
    if (state === 'scheduled') {
      this.events.push({
        type: 'scheduled',
        occurrence: item,
        updateIndex: null,
        reminderMinutes: null,
        at,
      })
    } else {
      this.transition(item, state, at)
    }
    return item
  }

  addUpdate(item: Working, status: OccurrenceState, message: string, at: Date): number {
    const updates = [...(item.doc.updates ?? [])]
    updates.push({ status, message, postedAt: at.toISOString() })
    item.doc.updates = updates
    item.dirty = true
    return updates.length - 1
  }

  /** Apply a status change (or a note when `to` is the current state) and queue its event. */
  transition(item: Working, to: OccurrenceState, at: Date, message = ''): void {
    const from = item.doc.state
    const iso = at.toISOString()
    item.doc.state = to
    if (to === 'in-progress' && !item.doc.startedAt) item.doc.startedAt = iso
    if (to === 'completed') {
      item.doc.completedAt = iso
      item.doc.startedAt ??= iso
    }
    if (to === 'cancelled') item.doc.cancelledAt = iso
    const updateIndex = this.addUpdate(item, to, message, at)
    this.events.push({
      type: eventTypeFor(from, to),
      occurrence: item,
      updateIndex,
      reminderMinutes: null,
      at,
    })
  }

  /** Unannounced, untouched occurrences disappear; announced ones are cancelled publicly. */
  drop(item: Working, at: Date): void {
    if ((item.doc.updates ?? []).length === 0) {
      item.deleted = true
      // A `scheduled` event may have been queued in this very pass; forget it.
      for (let i = this.events.length - 1; i >= 0; i -= 1) {
        if (this.events[i].occurrence === item) this.events.splice(i, 1)
      }
    } else {
      this.transition(item, 'cancelled', at)
    }
  }
}

// ---- Loading -------------------------------------------------------------------------------------

/** Unfinished occurrences of a maintenance plus the finished ones starting at or after `since`. */
async function loadRelevantOccurrences(
  payload: Payload,
  maintenanceId: string | number,
  since: string | null,
  req?: PayloadRequest,
): Promise<MaintenanceOccurrence[]> {
  const { docs } = await payload.find({
    collection: 'maintenance-occurrences',
    where: {
      and: [
        { maintenance: { equals: maintenanceId } },
        {
          or: [
            { state: { in: [...UNFINISHED_OCCURRENCE_STATES] } },
            ...(since ? [{ start: { greater_than_equal: since } }] : []),
          ],
        },
      ],
    },
    sort: 'start',
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
    req,
  })
  return docs as MaintenanceOccurrence[]
}

// ---- Sync ----------------------------------------------------------------------------------------

export interface SyncOptions {
  now?: Date
  /** Run inside this request's transaction; events and wake-ups then wait for the commit. */
  req?: PayloadRequest
  /**
   * Enqueue delayed wake-up jobs: `'all'` for every future instant, `'changed'` (default) only
   * when this pass changed occurrences, `false` never. Always off with `MARMOT_DISABLE_ENGINE_HOOKS`.
   */
  scheduleJobs?: 'all' | 'changed' | false
}

export interface SyncResult {
  status: MaintenanceStatus
  /** `maintenance.status` was written. */
  statusChanged: boolean
  /** Some occurrence was created, changed or deleted. */
  occurrencesChanged: boolean
  events: MaintenanceEvent[]
  /** The unfinished occurrences after the pass. */
  occurrences: MaintenanceOccurrence[]
}

const sameWindow = (doc: Working['doc'], window: MaintenanceWindow): boolean =>
  toMs(doc.start) === toMs(window.start)

/** Which occurrence keeps a window when several match (duplicates from a concurrent sync). */
const rank = (item: Working): number =>
  (isFinishedState(item.doc.state) ? 4 : isOpenState(item.doc.state) ? 2 : 0) +
  ((item.doc.updates ?? []).length > 0 ? 1 : 0)

function planScheduled(plan: Plan, doc: Maintenance, slots: MaintenanceTimeslots, now: Date) {
  const nowMs = now.getTime()
  const windows = [slots.current, slots.next].filter((w): w is MaintenanceWindow => Boolean(w))
  const matched = new Set<Working>()

  for (const window of windows) {
    const candidates = plan.live
      .filter((item) => sameWindow(item.doc, window))
      .sort((a, b) => rank(b) - rank(a))
    let item = candidates[0]
    for (const duplicate of candidates.slice(1)) {
      if (duplicate.doc.state === 'scheduled' && (duplicate.doc.updates ?? []).length === 0) {
        duplicate.deleted = true
      }
    }
    if (!item) {
      // Schedule edited: move an upcoming occurrence that lost its window rather than announcing
      // a second one (keeps its updates; reminders start over).
      item = plan.live.find(
        (o) =>
          o.doc.state === 'scheduled' &&
          !matched.has(o) &&
          (toMs(o.doc.start) ?? 0) > nowMs &&
          !windows.some((w) => sameWindow(o.doc, w)),
      ) as Working
      if (item) {
        item.doc.start = window.start
        item.doc.end = window.end
        item.doc.remindersSent = []
        item.dirty = true
      } else {
        item = plan.create(window, 'scheduled', now)
      }
    } else if (!isFinishedState(item.doc.state) && item.doc.end !== window.end) {
      if (toMs(item.doc.end) !== toMs(window.end)) {
        item.doc.end = window.end
        item.dirty = true
      }
    }
    matched.add(item)
  }

  // Unfinished occurrences without a window.
  for (const item of plan.live) {
    if (matched.has(item)) continue
    // The open-ended run of a former manual strategy ends when the strategy changes.
    if (isOpenState(item.doc.state) && !item.doc.end) {
      plan.transition(item, 'completed', now)
      continue
    }
    if (item.doc.state !== 'scheduled') continue
    const start = toMs(item.doc.start) ?? 0
    if (start > nowMs) {
      plan.drop(item, now)
      continue
    }
    // Past its start but never started. With autoStart it is caught up below; without it, it
    // waits for an admin until a later occurrence becomes due.
    if (doc.autoStart === false) {
      const superseded = plan.live.some(
        (other) =>
          other !== item &&
          (toMs(other.doc.start) ?? 0) > start &&
          (toMs(other.doc.start) ?? 0) <= nowMs,
      )
      if (superseded) plan.drop(item, now)
    }
  }
}

function advance(plan: Plan, doc: Maintenance, now: Date) {
  const nowMs = now.getTime()
  const ordered = [...plan.live].sort((a, b) => (toMs(a.doc.start) ?? 0) - (toMs(b.doc.start) ?? 0))
  for (const item of ordered) {
    if (
      item.doc.state === 'scheduled' &&
      doc.autoStart !== false &&
      (toMs(item.doc.start) ?? Infinity) <= nowMs
    ) {
      plan.transition(item, 'in-progress', now)
    }
    const end = toMs(item.doc.end)
    if (isOpenState(item.doc.state) && doc.autoComplete !== false && end !== null && end <= nowMs) {
      plan.transition(item, 'completed', now)
    }
  }
  completeSuperseded(plan, now)
}

/** Only the latest open occurrence stays open (an overrunning one ends when the next starts). */
function completeSuperseded(plan: Plan, now: Date) {
  const open = plan.live
    .filter((item) => isOpenState(item.doc.state))
    .sort((a, b) => (toMs(b.doc.start) ?? 0) - (toMs(a.doc.start) ?? 0))
  for (const older of open.slice(1)) plan.transition(older, 'completed', now)
}

function remind(plan: Plan, doc: Maintenance, now: Date) {
  const offsets = [...new Set((doc.reminders ?? []).map(Number))]
    .filter((minutes) => Number.isFinite(minutes) && minutes > 0)
    .sort((a, b) => b - a)
  if (offsets.length === 0) return
  const nowMs = now.getTime()
  for (const item of plan.live) {
    if (item.doc.state !== 'scheduled') continue
    const start = toMs(item.doc.start)
    if (start === null || start <= nowMs) continue
    const handled = new Set((item.doc.remindersSent ?? []).map(Number))
    for (const minutes of offsets) {
      if (handled.has(minutes)) continue
      const due = start - minutes * MINUTE_MS
      if (due > nowMs) continue
      handled.add(minutes)
      item.dirty = true
      if (nowMs - due <= REMINDER_GRACE_MINUTES * MINUTE_MS) {
        plan.events.push({
          type: 'reminder',
          occurrence: item,
          updateIndex: null,
          reminderMinutes: minutes,
          at: now,
        })
      }
    }
    item.doc.remindersSent = [...handled]
      .sort((a, b) => a - b)
      .map(String)
      .filter((v): v is ReminderOffset => (REMINDER_OFFSETS as readonly string[]).includes(v))
  }
}

/** Future instants at which something is due for this maintenance. */
function wakeupInstants(doc: Maintenance, occurrences: MaintenanceOccurrence[]): number[] {
  const instants: number[] = []
  const offsets = (doc.reminders ?? []).map(Number).filter((m) => m > 0)
  for (const occurrence of occurrences) {
    const start = toMs(occurrence.start)
    const end = toMs(occurrence.end)
    if (occurrence.state === 'scheduled' && start !== null) {
      // The start is planned even without autoStart: the next window is planned from there.
      instants.push(start)
      const handled = new Set((occurrence.remindersSent ?? []).map(Number))
      for (const minutes of offsets) {
        if (!handled.has(minutes)) instants.push(start - minutes * MINUTE_MS)
      }
    }
    if (!isFinishedState(occurrence.state) && end !== null) instants.push(end)
  }
  return instants
}

function buildEvent(
  doc: Maintenance,
  pending: PendingEvent,
  persisted: MaintenanceOccurrence,
): MaintenanceEvent {
  const summary = toOccurrenceSummary(persisted)
  const rows = persisted.updates ?? []
  const update =
    pending.updateIndex !== null && rows[pending.updateIndex]
      ? toOccurrenceUpdate(rows[pending.updateIndex], pending.updateIndex)
      : null
  return {
    type: pending.type,
    organizationId: String(relationId(doc.organization)),
    maintenance: {
      id: String(doc.id),
      title: doc.title,
      description: doc.description ?? null,
      strategy: doc.strategy,
      statusPages: idList(doc.statusPages),
      monitors: idList(doc.monitors),
    },
    occurrence: summary,
    update,
    reminderMinutes: pending.reminderMinutes,
    at: pending.at.toISOString(),
  }
}

/** Local API data; the organization is derived from the maintenance on create. */
const occurrenceData = (doc: Working['doc']) => ({
  start: doc.start,
  end: doc.end ?? null,
  state: doc.state,
  startedAt: doc.startedAt ?? null,
  completedAt: doc.completedAt ?? null,
  cancelledAt: doc.cancelledAt ?? null,
  remindersSent: doc.remindersSent ?? [],
  updates: (doc.updates ?? []).map((row) => ({
    ...(row.id ? { id: row.id } : {}),
    status: row.status,
    message: row.message ?? '',
    postedAt: row.postedAt,
  })),
})

/** Write the plan; returns persisted documents by working item. */
async function persist(
  payload: Payload,
  plan: Plan,
  req?: PayloadRequest,
): Promise<Map<Working, MaintenanceOccurrence>> {
  const persisted = new Map<Working, MaintenanceOccurrence>()
  for (const item of plan.items) {
    if (item.deleted) {
      if (item.id !== undefined) {
        await payload.delete({
          collection: 'maintenance-occurrences',
          id: item.id,
          overrideAccess: true,
          req,
        })
      }
      continue
    }
    if (!item.dirty) {
      persisted.set(item, item.doc as MaintenanceOccurrence)
      continue
    }
    const saved =
      item.id === undefined
        ? await payload.create({
            collection: 'maintenance-occurrences',
            data: {
              ...occurrenceData(item.doc),
              maintenance: relationId(item.doc.maintenance) as MaintenanceOccurrence['maintenance'],
            } as MaintenanceOccurrence,
            depth: 0,
            overrideAccess: true,
            req,
          })
        : await payload.update({
            collection: 'maintenance-occurrences',
            id: item.id,
            data: occurrenceData(item.doc),
            depth: 0,
            overrideAccess: true,
            req,
          })
    item.id = saved.id
    persisted.set(item, saved as MaintenanceOccurrence)
  }
  return persisted
}

const scheduleEnabled = () => !env.MARMOT_DISABLE_ENGINE_HOOKS

/** Run `fn` after the request's transaction commits (or now without a request). Never throws. */
async function later(req: PayloadRequest | undefined, fn: () => Promise<void>): Promise<void> {
  if (req) {
    await afterCommit(req, fn)
    return
  }
  try {
    await fn()
  } catch (err) {
    log.error({ err }, 'post-sync side effect failed')
  }
}

/** Plan, advance and remind one maintenance at `now`; see the module comment. */
export async function syncMaintenance(
  payload: Payload,
  doc: Maintenance,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const now = options.now ?? new Date()
  const req = options.req
  const serverTimezone = await getOrganizationTimezone(payload, relationId(doc.organization), req)
  const slots = computeMaintenanceTimeslots(doc, now, { serverTimezone })
  const since = slots.current?.start ?? slots.next?.start ?? null
  const plan = new Plan(await loadRelevantOccurrences(payload, doc.id, since, req), doc)

  if (doc.active === false) {
    for (const item of plan.live) {
      if (isOpenState(item.doc.state)) plan.transition(item, 'completed', now)
      else if (item.doc.state === 'scheduled' && (item.doc.updates ?? []).length === 0) {
        item.deleted = true
      }
    }
  } else if (doc.strategy === 'manual') {
    for (const item of plan.live) {
      if (item.doc.state === 'scheduled') plan.drop(item, now)
    }
    if (!plan.live.some((item) => isOpenState(item.doc.state))) {
      plan.create({ start: now.toISOString(), end: null }, 'in-progress', now)
    }
    completeSuperseded(plan, now)
  } else {
    planScheduled(plan, doc, slots, now)
    advance(plan, doc, now)
    remind(plan, doc, now)
  }

  const occurrencesChanged = plan.items.some((item) => item.dirty || item.deleted)
  const persisted = occurrencesChanged
    ? await persist(payload, plan, req)
    : new Map(plan.items.map((item) => [item, item.doc as MaintenanceOccurrence]))
  const current = plan.live.map((item) => persisted.get(item) as MaintenanceOccurrence)
  const unfinished = current.filter((o) => !isFinishedState(o.state))

  const status = effectiveMaintenanceStatus(doc, slots, current)
  let statusChanged = false
  if (status !== doc.status) {
    await payload.update({
      collection: 'maintenance',
      id: doc.id,
      data: { status },
      depth: 0,
      overrideAccess: true,
      context: { skipMaintenanceHooks: true },
      req,
    })
    statusChanged = true
    log.info({ maintenanceId: doc.id, from: doc.status, to: status }, 'maintenance status changed')
  }

  const events = plan.events
    .filter((pending) => !pending.occurrence.deleted)
    .map((pending) =>
      buildEvent(doc, pending, persisted.get(pending.occurrence) as MaintenanceOccurrence),
    )

  const mode = options.scheduleJobs ?? 'changed'
  const schedule =
    scheduleEnabled() && (mode === 'all' || (mode === 'changed' && occurrencesChanged))
  if (events.length > 0 || schedule) {
    await later(req, async () => {
      if (schedule) await scheduleMaintenanceWakeups(doc.id, wakeupInstants(doc, unfinished))
      if (events.length > 0) await dispatchMaintenanceEvents(payload, events)
    })
  }

  return { status, statusChanged, occurrencesChanged, events, occurrences: unfinished }
}

/** Load and sync one maintenance by id; null when it no longer exists. */
export async function syncMaintenanceById(
  payload: Payload,
  id: string | number,
  options: SyncOptions = {},
): Promise<SyncResult | null> {
  const doc = await payload.findByID({
    collection: 'maintenance',
    id,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
    req: options.req,
  })
  if (!doc) return null
  return syncMaintenance(payload, doc as Maintenance, options)
}

/** Remove a maintenance's occurrences (before the maintenance itself is deleted). */
export async function deleteMaintenanceOccurrences(
  payload: Payload,
  maintenanceId: string | number,
  req?: PayloadRequest,
): Promise<void> {
  // One by one: a `where` delete queries concurrently, which a transaction's single connection
  // does not support well.
  const { docs } = await payload.find({
    collection: 'maintenance-occurrences',
    where: { maintenance: { equals: maintenanceId } },
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
    select: { state: true },
    req,
  })
  for (const doc of docs) {
    await payload.delete({
      collection: 'maintenance-occurrences',
      id: doc.id,
      overrideAccess: true,
      req,
    })
  }
}

// ---- Admin updates -------------------------------------------------------------------------------

/** 409: the status cannot be posted on an occurrence in its current state. */
export class OccurrenceTransitionError extends LocalizedAPIError {
  constructor(
    readonly from: OccurrenceState,
    readonly to: OccurrenceState,
  ) {
    super('maintenanceTransitionInvalid', 409, { from, to }, { data: { from, to } })
    this.name = 'OccurrenceTransitionError'
  }
}

export interface PostUpdateInput {
  status: OccurrenceState
  message?: string
  now?: Date
  /** Run inside this request's transaction. */
  req?: PayloadRequest
}

export interface PostUpdateResult {
  occurrence: OccurrenceSummary
  maintenance: Maintenance
  events: MaintenanceEvent[]
}

/**
 * Post an update on an occurrence: a note when `status` is its current state, otherwise a manual
 * transition (start, verifying, back in progress, complete, cancel — see `OCCURRENCE_TRANSITIONS`).
 * Completing the run of a manual maintenance also pauses the maintenance (that is how a manual
 * window ends). Afterwards the maintenance is synced so its status, the realtime list and the next
 * occurrence follow at once.
 */
export async function postOccurrenceUpdate(
  payload: Payload,
  maintenance: Maintenance,
  occurrence: MaintenanceOccurrence,
  input: PostUpdateInput,
): Promise<PostUpdateResult> {
  const now = input.now ?? new Date()
  const { req } = input
  if (!(OCCURRENCE_STATES as readonly string[]).includes(input.status)) {
    throw new OccurrenceTransitionError(occurrence.state, input.status)
  }
  if (!canPostStatus(occurrence.state, input.status)) {
    throw new OccurrenceTransitionError(occurrence.state, input.status)
  }

  const others =
    input.status === 'in-progress' && occurrence.state === 'scheduled'
      ? await loadRelevantOccurrences(payload, maintenance.id, null, req)
      : []
  const plan = new Plan(
    [occurrence, ...others.filter((o) => String(o.id) !== String(occurrence.id))],
    maintenance,
  )
  const [item] = plan.items
  plan.transition(item, input.status, now, input.message?.trim() ?? '')
  if (input.status === 'in-progress') {
    for (const other of plan.items.slice(1)) {
      if (isOpenState(other.doc.state)) plan.transition(other, 'completed', now)
    }
  }
  const persisted = await persist(payload, plan, req)
  const events = plan.events.map((pending) =>
    buildEvent(maintenance, pending, persisted.get(pending.occurrence) as MaintenanceOccurrence),
  )
  await later(req, async () => {
    await dispatchMaintenanceEvents(payload, events)
  })

  let current = maintenance
  if (
    maintenance.strategy === 'manual' &&
    input.status === 'completed' &&
    maintenance.active !== false
  ) {
    // Ends the manual window; the collection hook syncs (nothing left open) and publishes.
    current = (await payload.update({
      collection: 'maintenance',
      id: maintenance.id,
      data: { active: false },
      depth: 0,
      overrideAccess: true,
      req,
    })) as Maintenance
  } else {
    const result = await syncMaintenance(payload, maintenance, { now, req, scheduleJobs: 'all' })
    current = { ...maintenance, status: result.status }
    const orgId = relationId(maintenance.organization)
    if (orgId !== null && scheduleEnabled()) {
      await later(req, async () => {
        const { emitOrgMaintenanceList } = await import('./realtime')
        await emitOrgMaintenanceList(payload, orgId)
      })
    }
  }

  return {
    occurrence: toOccurrenceSummary(persisted.get(item) as MaintenanceOccurrence),
    maintenance: current,
    events,
  }
}

/** Occurrences of a maintenance for the editor: upcoming and recent, newest start first. */
export async function listMaintenanceOccurrences(
  payload: Payload,
  maintenanceId: string | number,
  options: { limit?: number; user?: Parameters<Payload['find']>[0]['user'] } = {},
): Promise<OccurrenceSummary[]> {
  const { docs } = await payload.find({
    collection: 'maintenance-occurrences',
    where: { maintenance: { equals: maintenanceId } },
    sort: '-start',
    depth: 0,
    limit: options.limit ?? 20,
    user: options.user,
    overrideAccess: options.user ? false : true,
  })
  return (docs as MaintenanceOccurrence[]).map(toOccurrenceSummary)
}
