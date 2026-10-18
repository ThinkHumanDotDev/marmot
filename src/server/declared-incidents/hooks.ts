/**
 * The workflow of declared incidents (#101), enforced in the collection's `beforeChange` hook so
 * every writer (route handlers, the REST API, the worker) gets the same rules:
 *
 * - creating declares the incident (`status: open`, `declaredBy` = the user, `startedAt` from the
 *   body, the linked monitor incident or now);
 * - status changes follow `DECLARED_STATUS_TRANSITIONS` and stamp `mitigatedAt` / `resolvedAt` /
 *   `closedAt` / `canceledAt`; closing needs an approved postmortem unless someone holding
 *   `declared-incident:skip-postmortem` sets `postmortemSkipped`;
 * - closed and canceled incidents are read-only;
 * - the timeline is append-only: the stored rows are kept and the hook appends one row per change
 *   (severity, status, commander, link, postmortem) plus a note passed in `req.context`;
 * - every change counts as activity and re-arms the commander's reminder (`nextReminderAt`).
 *
 * The `afterChange` hook publishes the incident over realtime and enqueues notifications once the
 * transaction commits.
 */
import type { CollectionAfterChangeHook, CollectionBeforeChangeHook, PayloadRequest } from 'payload'

import { canInOrg } from '@/access/overrides'
import { getUserRole } from '@/access/permissions'
import {
  ACTIVE_DECLARED_STATUSES,
  canTransition,
  isTerminalStatus,
  reminderDelaySeconds,
  type DeclaredIncidentSeverity,
  type DeclaredIncidentStatus,
  type DeclaredNotificationEvent,
  type DeclaredTimelineType,
  type PostmortemStatus,
} from '@/lib/declared-incidents'
import { afterCommit } from '@/db/after-commit'
import type { DeclaredIncident, User } from '@/payload-types'
import { apiError } from '@/server/errors'

import { enqueueDeclaredNotifications } from './notify'
import { publishDeclaredIncident } from './realtime'
import { relId, type Id } from './ids'

/** `req.context` keys understood by the hooks. */
export interface DeclaredIncidentContext {
  /** A note to append to the timeline with this write. */
  declaredIncidentNote?: string
  /** The reminder job's bookkeeping write: not activity, no timeline, no notifications. */
  declaredIncidentReminder?: boolean
}

type TimelineRow = NonNullable<DeclaredIncident['timeline']>[number]
type Postmortem = NonNullable<DeclaredIncident['postmortem']>

/** Fields only the hook writes. */
const MANAGED_FIELDS = [
  'declaredBy',
  'mitigatedAt',
  'resolvedAt',
  'closedAt',
  'canceledAt',
  'timeline',
  'lastActivityAt',
  'nextReminderAt',
  'remindersSent',
  'lastReminderAt',
] as const

const sameId = (a: unknown, b: unknown) => String(relId(a) ?? '') === String(relId(b) ?? '')

/** The acting member; `null` for the system and for API keys (named in the audit row instead). */
function actorId(req: PayloadRequest): Id | null {
  const user = req.user as (User & { apiKey?: unknown }) | null | undefined
  if (!user || user.apiKey) return null
  return user.id
}

async function assertMember(req: PayloadRequest, orgId: Id, userId: Id): Promise<void> {
  const user = await req.payload
    .findByID({ collection: 'users', id: userId, depth: 0, overrideAccess: true, req })
    .catch(() => null)
  if (!user || !getUserRole(user, orgId)) throw apiError('declaredIncidentCommanderNotMember', 400)
}

async function loadInOrg<C extends 'incidents' | 'monitor-incidents'>(
  req: PayloadRequest,
  collection: C,
  id: Id,
  orgId: Id,
) {
  const doc = await req.payload
    .findByID({ collection, id, depth: 0, overrideAccess: true, req })
    .catch(() => null)
  if (!doc || !sameId(doc.organization, orgId)) throw apiError('declaredIncidentLinkInvalid', 400)
  return doc
}

type ActionItemRow = NonNullable<Postmortem['actionItems']>[number]

/**
 * The incoming action items as stored rows: rows keep their id only when it names a stored item (so
 * a ticket link stays with its item), owners must be members, and new or newly done items are
 * announced on the timeline.
 */
async function mergeActionItems(
  req: PayloadRequest,
  orgId: Id,
  previous: ActionItemRow[],
  incoming: ActionItemRow[],
  event: (type: DeclaredTimelineType, extra?: { message?: string | null }) => void,
): Promise<ActionItemRow[]> {
  const before = new Map(previous.map((row) => [String(row.id), row]))
  const owners = new Set<string>()
  const rows = incoming.map((row) => {
    const known = row.id ? before.get(String(row.id)) : undefined
    // Rendered as links and read by issue trackers: only web URLs and calendar days.
    if (row.ticketUrl && !/^https?:\/\/[^\s]+$/i.test(row.ticketUrl)) {
      throw apiError('validationFailed', 400)
    }
    if (row.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(row.dueDate)) {
      throw apiError('validationFailed', 400)
    }
    const owner = relId(row.owner)
    if (owner !== null && !sameId(owner, known?.owner)) owners.add(String(owner))
    const next: ActionItemRow = {
      title: row.title,
      owner: owner as ActionItemRow['owner'],
      dueDate: row.dueDate || null,
      done: row.done === true,
      ticketUrl: row.ticketUrl || null,
    }
    if (known) next.id = known.id
    if (!known) event('action_item_added', { message: row.title })
    else if (next.done && !known.done) event('action_item_done', { message: row.title })
    return next
  })
  for (const owner of owners) await assertMember(req, orgId, owner)
  return rows
}

const emptyPostmortem = (): Postmortem => ({
  status: 'none',
  content: '',
  approvedBy: null,
  approvedAt: null,
  actionItems: [],
})

export const declaredIncidentBeforeChange: CollectionBeforeChangeHook<DeclaredIncident> = async ({
  data,
  originalDoc,
  operation,
  req,
}) => {
  const context = (req.context ?? {}) as DeclaredIncidentContext
  const prev = operation === 'update' ? originalDoc : undefined

  if (prev && context.declaredIncidentReminder) {
    // Only the reminder bookkeeping changes.
    return {
      ...data,
      ...originalDoc,
      remindersSent: data.remindersSent,
      lastReminderAt: data.lastReminderAt,
      nextReminderAt: data.nextReminderAt,
    }
  }
  if (prev && isTerminalStatus(prev.status)) throw apiError('declaredIncidentReadOnly', 409)

  const now = new Date()
  const at = now.toISOString()
  const actor = actorId(req)
  const incoming = data.postmortem as Partial<Postmortem> | undefined
  for (const key of MANAGED_FIELDS) delete (data as Record<string, unknown>)[key]

  const orgId = relId(prev ? prev.organization : data.organization)
  if (orgId === null) throw apiError('validationFailed', 400)
  if (prev) data.organization = prev.organization

  const events: TimelineRow[] = []
  const event = (
    type: DeclaredTimelineType,
    extra: { from?: string | null; to?: string | null; message?: string | null } = {},
  ) =>
    events.push({
      type,
      at,
      by: actor,
      from: extra.from ?? null,
      to: extra.to ?? null,
      message: extra.message?.trim() ? extra.message.trim().slice(0, 5000) : null,
    } as TimelineRow)

  const severity = (data.severity ?? prev?.severity ?? 'major') as DeclaredIncidentSeverity
  let status = (prev?.status ?? 'open') as DeclaredIncidentStatus

  if (!prev) {
    data.status = 'open'
    data.severity = severity
    data.declaredBy = actor as DeclaredIncident['declaredBy']
    data.postmortemSkipped = false
    const monitorIncidentId = relId(data.monitorIncident)
    if (monitorIncidentId !== null) {
      const source = await loadInOrg(req, 'monitor-incidents', monitorIncidentId, orgId)
      data.startedAt ??= source.startedAt
    }
    data.startedAt ??= at
    event('declared', { to: severity })
  } else {
    if (data.monitorIncident !== undefined && !sameId(data.monitorIncident, prev.monitorIncident)) {
      const monitorIncidentId = relId(data.monitorIncident)
      if (monitorIncidentId !== null) {
        await loadInOrg(req, 'monitor-incidents', monitorIncidentId, orgId)
      }
    }
    if (severity !== prev.severity) {
      event('severity_changed', { from: prev.severity, to: severity })
    }
    if (typeof data.title === 'string' && data.title !== prev.title) {
      event('title_changed', { from: prev.title, to: data.title })
    }
    if (data.summary !== undefined && (data.summary || null) !== (prev.summary || null)) {
      event('summary_changed')
    }
    if (
      data.startedAt &&
      new Date(data.startedAt).getTime() !== new Date(prev.startedAt).getTime()
    ) {
      event('started_changed', {
        from: new Date(prev.startedAt).toISOString(),
        to: new Date(data.startedAt).toISOString(),
      })
    }
  }
  if (data.startedAt && new Date(data.startedAt).getTime() > now.getTime() + 60_000) {
    throw apiError('declaredIncidentStartInFuture', 400)
  }

  // Commander: an org member; changes are announced.
  if (data.commander !== undefined && !sameId(data.commander, prev?.commander)) {
    const commander = relId(data.commander)
    if (commander !== null) await assertMember(req, orgId, commander)
    event('commander_changed', {
      from: prev ? (relId(prev.commander)?.toString() ?? null) : null,
      to: commander === null ? null : String(commander),
    })
  }

  // Link to the public status-page incident.
  if (
    data.statusPageIncident !== undefined &&
    !sameId(data.statusPageIncident, prev?.statusPageIncident)
  ) {
    const previous = relId(prev?.statusPageIncident)
    const next = relId(data.statusPageIncident)
    if (previous !== null) event('unlinked', { from: String(previous) })
    if (next !== null) {
      const linked = await loadInOrg(req, 'incidents', next, orgId)
      event('linked', { to: String(next), message: linked.title })
    }
  }

  // Postmortem: editing makes it a draft (again); approving needs content.
  const postmortem: Postmortem = { ...emptyPostmortem(), ...(prev?.postmortem ?? {}) }
  if (typeof incoming?.content === 'string' && incoming.content !== (postmortem.content ?? '')) {
    postmortem.content = incoming.content
    if (postmortem.status !== 'draft') {
      postmortem.status = 'draft'
      postmortem.approvedBy = null
      postmortem.approvedAt = null
      event('postmortem_drafted')
    }
  }
  if (incoming?.status === 'approved' && postmortem.status !== 'approved') {
    if (!postmortem.content?.trim()) throw apiError('declaredIncidentPostmortemEmpty', 400)
    postmortem.status = 'approved'
    postmortem.approvedBy = actor as Postmortem['approvedBy']
    postmortem.approvedAt = at
    event('postmortem_approved')
  }
  if (Array.isArray(incoming?.actionItems)) {
    postmortem.actionItems = await mergeActionItems(
      req,
      orgId,
      prev?.postmortem?.actionItems ?? [],
      incoming.actionItems,
      event,
    )
  }
  data.postmortem = postmortem

  // Status workflow.
  const requested = (data.status ?? status) as DeclaredIncidentStatus
  const skip = data.postmortemSkipped === true
  data.postmortemSkipped = prev ? Boolean(prev.postmortemSkipped) : false
  const stamps: Partial<DeclaredIncident> = prev
    ? {
        mitigatedAt: prev.mitigatedAt ?? null,
        resolvedAt: prev.resolvedAt ?? null,
        closedAt: prev.closedAt ?? null,
        canceledAt: prev.canceledAt ?? null,
      }
    : {}
  if (prev && requested !== status) {
    if (!canTransition(status, requested)) {
      throw apiError('declaredIncidentInvalidTransition', 409, { from: status, to: requested })
    }
    if (requested === 'closed' && (postmortem.status as PostmortemStatus) !== 'approved') {
      if (!skip) throw apiError('declaredIncidentPostmortemRequired', 409)
      if (
        req.user &&
        !(await canInOrg(req.payload, req.user, orgId, 'declared-incident:skip-postmortem'))
      ) {
        throw apiError('forbidden', 403)
      }
      data.postmortemSkipped = true
    }
    if (requested === 'open') {
      stamps.mitigatedAt = null
      stamps.resolvedAt = null
    }
    if (requested === 'mitigated') stamps.mitigatedAt = at
    if (requested === 'resolved') stamps.resolvedAt = at
    if (requested === 'closed') stamps.closedAt = at
    if (requested === 'canceled') stamps.canceledAt = at
    event('status_changed', { from: status, to: requested })
    if (requested === 'closed') {
      event('closed', { to: data.postmortemSkipped ? 'postmortem_skipped' : null })
    }
    status = requested
  }
  data.status = status
  Object.assign(data, stamps)

  if (context.declaredIncidentNote?.trim()) {
    event('note', { message: context.declaredIncidentNote })
  }

  data.timeline = [...(prev?.timeline ?? []), ...events]
  // Any write is activity: re-arm the commander's reminder from now.
  data.lastActivityAt = at
  data.remindersSent = 0
  data.lastReminderAt = prev?.lastReminderAt ?? null
  data.nextReminderAt = ACTIVE_DECLARED_STATUSES.includes(status)
    ? new Date(now.getTime() + reminderDelaySeconds(severity, 0) * 1000).toISOString()
    : null
  return data
}

/** What to announce for a write, comparing it with the previous version. */
export function notificationEventsFor(
  doc: Pick<DeclaredIncident, 'status' | 'commander'>,
  previous: Pick<DeclaredIncident, 'status' | 'commander'> | null,
): DeclaredNotificationEvent[] {
  const events: DeclaredNotificationEvent[] = []
  if (!previous) events.push('declared')
  else if (doc.status !== previous.status) events.push('status')
  if (relId(doc.commander) !== null && !sameId(doc.commander, previous?.commander)) {
    events.push('commander')
  }
  return events
}

export const declaredIncidentAfterChange: CollectionAfterChangeHook<DeclaredIncident> = async ({
  doc,
  previousDoc,
  operation,
  req,
}) => {
  const context = (req.context ?? {}) as DeclaredIncidentContext
  const previous = operation === 'create' ? null : previousDoc
  const events = context.declaredIncidentReminder ? [] : notificationEventsFor(doc, previous)
  const actor = actorId(req)
  await afterCommit(req, async () => {
    await publishDeclaredIncident(req.payload, doc)
    for (const event of events) {
      await enqueueDeclaredNotifications(req.payload, doc, event, { actorId: actor })
    }
  })
  return doc
}
