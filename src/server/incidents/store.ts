/**
 * Reads and writes of `monitor-incidents`. Every write goes through the Local API with
 * `overrideAccess: true` (the collection is server-written); callers authorise first.
 */
import type { Payload, Where } from 'payload'

import {
  ACTIVE_INCIDENT_STATUSES,
  INCIDENT_RANGE_SECONDS,
  summarizeIncidents,
  type IncidentActionSource,
  type IncidentPerson,
  type IncidentRange,
  type IncidentStats,
  type IncidentStatusFilter,
  type IncidentTimelineType,
  type MonitorIncidentStatus,
  type MonitorIncidentSummary,
} from '@/lib/monitor-incidents'
import { childLogger } from '@/lib/logger'
import type { Incident, Monitor, MonitorIncident, User } from '@/payload-types'
import { apiError } from '@/server/errors'
import type { RequestUser } from '@/server/monitors/http'

const log = childLogger('incidents')

export type Id = string | number

export const relId = (value: unknown): Id | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

type TimelineRow = NonNullable<MonitorIncident['timeline']>[number]

const row = (
  type: IncidentTimelineType,
  at: Date,
  extra: { by?: Id | null; via?: IncidentActionSource | null; message?: string | null } = {},
): TimelineRow =>
  ({
    type,
    at: at.toISOString(),
    by: extra.by ?? null,
    via: extra.via ?? null,
    message: extra.message?.trim() ? extra.message.trim().slice(0, 2000) : null,
  }) as TimelineRow

const keep = (incident: MonitorIncident): TimelineRow[] => [...(incident.timeline ?? [])]

/** The unresolved incident of a monitor, if any (at most one, guarded by `openKey`). */
export async function findOpenIncident(
  payload: Payload,
  monitorId: Id,
): Promise<MonitorIncident | null> {
  const { docs } = await payload.find({
    collection: 'monitor-incidents',
    where: { openKey: { equals: `open:${monitorId}` } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  return (docs[0] as MonitorIncident | undefined) ?? null
}

export async function getIncident(payload: Payload, id: Id): Promise<MonitorIncident | null> {
  try {
    return (await payload.findByID({
      collection: 'monitor-incidents',
      id,
      depth: 0,
      overrideAccess: true,
    })) as MonitorIncident
  } catch {
    return null
  }
}

export interface OpenIncidentInput {
  monitor: Pick<Monitor, 'id' | 'organization'>
  /** Message of the DOWN beat that opened it. */
  cause: string | null | undefined
  startedAt: Date
}

/**
 * Opens the monitor's incident, or returns the one already open (`created: false`). Two racing
 * opens collide on the unique `openKey`; the loser reads the winner's row.
 */
export async function openIncident(
  payload: Payload,
  input: OpenIncidentInput,
): Promise<{ incident: MonitorIncident; created: boolean }> {
  const existing = await findOpenIncident(payload, input.monitor.id)
  if (existing) return { incident: existing, created: false }
  const cause = input.cause?.trim() ? input.cause.trim().slice(0, 2000) : null
  try {
    const incident = (await payload.create({
      collection: 'monitor-incidents',
      depth: 0,
      overrideAccess: true,
      data: {
        organization: relId(input.monitor.organization) as MonitorIncident['organization'],
        monitor: input.monitor.id,
        status: 'open',
        cause,
        startedAt: input.startedAt.toISOString(),
        remindersSent: 0,
        timeline: [row('opened', input.startedAt, { message: cause })],
      },
    })) as MonitorIncident
    return { incident, created: true }
  } catch (err) {
    const winner = await findOpenIncident(payload, input.monitor.id)
    if (winner) return { incident: winner, created: false }
    throw err
  }
}

/** Notes that the monitor entered maintenance; the incident stays open. */
export async function noteMaintenance(
  payload: Payload,
  incident: MonitorIncident,
  at: Date,
): Promise<MonitorIncident> {
  return (await payload.update({
    collection: 'monitor-incidents',
    id: incident.id,
    depth: 0,
    overrideAccess: true,
    data: { timeline: [...keep(incident), row('maintenance', at)] },
  })) as MonitorIncident
}

export interface ActorInput {
  /** The member acting; `null` for the engine or an anonymous signed link. */
  userId?: Id | null
  via?: IncidentActionSource | null
  note?: string | null
  at?: Date
}

/** Acknowledges an open incident. 409 when it is already acknowledged or resolved. */
export async function acknowledgeIncident(
  payload: Payload,
  incident: MonitorIncident,
  actor: ActorInput,
): Promise<MonitorIncident> {
  if (incident.status === 'resolved') throw apiError('incidentAlreadyResolved', 409)
  if (incident.status === 'acknowledged') throw apiError('incidentAlreadyAcknowledged', 409)
  const at = actor.at ?? new Date()
  return (await payload.update({
    collection: 'monitor-incidents',
    id: incident.id,
    depth: 0,
    overrideAccess: true,
    data: {
      status: 'acknowledged',
      acknowledgedAt: at.toISOString(),
      acknowledgedBy: (actor.userId ?? null) as MonitorIncident['acknowledgedBy'],
      acknowledgedVia: actor.via ?? null,
      timeline: [
        ...keep(incident),
        row('acknowledged', at, { by: actor.userId, via: actor.via, message: actor.note }),
      ],
    },
  })) as MonitorIncident
}

/**
 * Resolves an incident: by a member (`auto: false`, 409 when it is already resolved) or by the
 * engine on recovery (`auto: true`).
 */
export async function resolveIncident(
  payload: Payload,
  incident: MonitorIncident,
  actor: ActorInput & { auto: boolean },
): Promise<MonitorIncident> {
  if (incident.status === 'resolved') throw apiError('incidentAlreadyResolved', 409)
  const at = actor.at ?? new Date()
  return (await payload.update({
    collection: 'monitor-incidents',
    id: incident.id,
    depth: 0,
    overrideAccess: true,
    data: {
      status: 'resolved',
      resolvedAt: at.toISOString(),
      resolvedBy: (actor.auto ? null : (actor.userId ?? null)) as MonitorIncident['resolvedBy'],
      autoResolved: actor.auto,
      timeline: [
        ...keep(incident),
        row('resolved', at, {
          by: actor.auto ? null : actor.userId,
          via: actor.auto ? null : actor.via,
          message: actor.note,
        }),
      ],
    },
  })) as MonitorIncident
}

/** Records one reminder that went out (bookkeeping for the reminder policy). */
export async function recordReminder(
  payload: Payload,
  incident: MonitorIncident,
  at: Date = new Date(),
): Promise<void> {
  try {
    await payload.update({
      collection: 'monitor-incidents',
      id: incident.id,
      depth: 0,
      overrideAccess: true,
      data: { remindersSent: (incident.remindersSent ?? 0) + 1, lastReminderAt: at.toISOString() },
    })
  } catch (err) {
    log.warn({ err, incidentId: incident.id }, 'failed to record incident reminder')
  }
}

/** Links a published status-page incident. */
export async function linkStatusPageIncident(
  payload: Payload,
  incident: MonitorIncident,
  statusPageIncident: Pick<Incident, 'id' | 'title'>,
  actor: ActorInput,
): Promise<MonitorIncident> {
  const at = actor.at ?? new Date()
  return (await payload.update({
    collection: 'monitor-incidents',
    id: incident.id,
    depth: 0,
    overrideAccess: true,
    data: {
      statusPageIncident: statusPageIncident.id as MonitorIncident['statusPageIncident'],
      timeline: [
        ...keep(incident),
        row('published', at, {
          by: actor.userId,
          via: actor.via,
          message: statusPageIncident.title,
        }),
      ],
    },
  })) as MonitorIncident
}

// ---- Serialization ----------------------------------------------------------------------------

const iso = (value: string | null | undefined): string | null => value ?? null

const personName = (user: Pick<User, 'name' | 'email'>): string =>
  user.name?.trim() || user.email || ''

/**
 * Turns documents into `MonitorIncidentSummary` rows. Monitor names, member names and linked
 * status-page incidents are looked up in batches with `overrideAccess` (the caller already checked
 * that the reader may see the incidents; member names are visible to every member anyway).
 */
export async function serializeIncidents(
  payload: Payload,
  docs: MonitorIncident[],
): Promise<MonitorIncidentSummary[]> {
  if (docs.length === 0) return []
  const monitorIds = new Set<string>()
  const userIds = new Set<string>()
  const spIncidentIds = new Set<string>()
  for (const doc of docs) {
    const monitor = relId(doc.monitor)
    if (monitor !== null) monitorIds.add(String(monitor))
    for (const value of [
      doc.acknowledgedBy,
      doc.resolvedBy,
      ...(doc.timeline ?? []).map((r) => r.by),
    ]) {
      const user = relId(value)
      if (user !== null) userIds.add(String(user))
    }
    const sp = relId(doc.statusPageIncident)
    if (sp !== null) spIncidentIds.add(String(sp))
  }

  const lookup = async <T extends { id: Id }>(
    collection: 'monitors' | 'users' | 'incidents',
    ids: Set<string>,
    select: Record<string, true>,
  ): Promise<Map<string, T>> => {
    if (ids.size === 0) return new Map()
    const raw = [...ids].map((id) => (payload.db.defaultIDType === 'number' ? Number(id) : id))
    const { docs: found } = await payload.find({
      collection,
      where: { id: { in: raw } },
      limit: ids.size,
      pagination: false,
      depth: 0,
      overrideAccess: true,
      select,
    })
    return new Map((found as unknown as T[]).map((item) => [String(item.id), item]))
  }

  const [monitors, users, spIncidents] = await Promise.all([
    lookup<Pick<Monitor, 'id' | 'name'>>('monitors', monitorIds, { name: true }),
    lookup<Pick<User, 'id' | 'name' | 'email'>>('users', userIds, { name: true, email: true }),
    lookup<Pick<Incident, 'id' | 'title' | 'statusPage'>>('incidents', spIncidentIds, {
      title: true,
      statusPage: true,
    }),
  ])

  const person = (value: unknown): IncidentPerson | null => {
    const id = relId(value)
    if (id === null) return null
    const user = users.get(String(id))
    return user ? { id: String(id), name: personName(user) } : null
  }

  return docs.map((doc) => {
    const monitorId = relId(doc.monitor)
    const monitor = monitorId !== null ? monitors.get(String(monitorId)) : undefined
    const spId = relId(doc.statusPageIncident)
    const sp = spId !== null ? spIncidents.get(String(spId)) : undefined
    return {
      id: String(doc.id),
      organizationId: String(relId(doc.organization) ?? ''),
      monitor: monitorId !== null ? { id: String(monitorId), name: monitor?.name ?? '' } : null,
      status: doc.status as MonitorIncidentStatus,
      cause: doc.cause ?? null,
      startedAt: doc.startedAt,
      acknowledgedAt: iso(doc.acknowledgedAt),
      acknowledgedBy: person(doc.acknowledgedBy),
      acknowledgedVia: doc.acknowledgedVia ?? null,
      resolvedAt: iso(doc.resolvedAt),
      resolvedBy: person(doc.resolvedBy),
      autoResolved: Boolean(doc.autoResolved),
      remindersSent: doc.remindersSent ?? 0,
      lastReminderAt: iso(doc.lastReminderAt),
      statusPageIncident: sp
        ? {
            id: String(sp.id),
            title: sp.title,
            statusPage: relId(sp.statusPage) !== null ? String(relId(sp.statusPage)) : null,
          }
        : null,
      timeline: (doc.timeline ?? []).map((entry, index) => ({
        id: entry.id ?? String(index),
        type: entry.type,
        at: entry.at,
        by: person(entry.by),
        via: entry.via ?? null,
        message: entry.message ?? null,
      })),
    }
  })
}

export async function serializeIncident(
  payload: Payload,
  doc: MonitorIncident,
): Promise<MonitorIncidentSummary> {
  const [summary] = await serializeIncidents(payload, [doc])
  return summary
}

// ---- Listing ----------------------------------------------------------------------------------

export interface IncidentListFilters {
  status?: IncidentStatusFilter
  monitor?: Id | null
  range?: IncidentRange
  page?: number
  limit?: number
  now?: Date
  /** Read as this user (`overrideAccess: false`); the engine and tests read without one. */
  user?: RequestUser
}

export interface IncidentListResult {
  docs: MonitorIncidentSummary[]
  page: number
  totalPages: number
  totalDocs: number
  /** Counts and MTTA/MTTR over every incident matching the monitor and range filters. */
  stats: IncidentStats
}

/** Upper bound of incidents folded into the summary (the newest ones). */
export const STATS_SAMPLE_LIMIT = 5_000

export function incidentWhere(
  orgId: Id,
  filters: Pick<IncidentListFilters, 'monitor' | 'range' | 'now'>,
  status?: IncidentStatusFilter,
): Where {
  const and: Where[] = [{ organization: { equals: orgId } }]
  if (filters.monitor !== undefined && filters.monitor !== null) {
    and.push({ monitor: { equals: filters.monitor } })
  }
  const range = filters.range ?? '30d'
  if (range !== 'all') {
    const now = filters.now ?? new Date()
    const since = new Date(now.getTime() - INCIDENT_RANGE_SECONDS[range] * 1000)
    and.push({ startedAt: { greater_than_equal: since.toISOString() } })
  }
  if (status === 'active') and.push({ status: { in: [...ACTIVE_INCIDENT_STATUSES] } })
  else if (status && status !== 'all') and.push({ status: { equals: status } })
  return { and }
}

/**
 * Incidents of an organization, newest first, with the MTTA/MTTR summary of the same window. The
 * caller has checked `monitor-incident:read` in `orgId`.
 */
export async function listOrgIncidents(
  payload: Payload,
  orgId: Id,
  filters: IncidentListFilters = {},
): Promise<IncidentListResult> {
  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100)
  const page = Math.max(filters.page ?? 1, 1)
  const access = filters.user
    ? ({ user: filters.user, overrideAccess: false } as const)
    : ({ overrideAccess: true } as const)
  const [result, sample] = await Promise.all([
    payload.find({
      collection: 'monitor-incidents',
      where: incidentWhere(orgId, filters, filters.status ?? 'all'),
      sort: '-startedAt',
      limit,
      page,
      depth: 0,
      ...access,
    }),
    payload.find({
      collection: 'monitor-incidents',
      where: incidentWhere(orgId, filters),
      sort: '-startedAt',
      limit: STATS_SAMPLE_LIMIT,
      pagination: false,
      depth: 0,
      ...access,
      select: { status: true, startedAt: true, acknowledgedAt: true, resolvedAt: true },
    }),
  ])
  return {
    docs: await serializeIncidents(payload, result.docs as MonitorIncident[]),
    page: result.page ?? page,
    totalPages: result.totalPages,
    totalDocs: result.totalDocs,
    stats: summarizeIncidents(
      (sample.docs as MonitorIncident[]).map((doc) => ({
        status: doc.status as MonitorIncidentStatus,
        startedAt: doc.startedAt,
        acknowledgedAt: doc.acknowledgedAt ?? null,
        resolvedAt: doc.resolvedAt ?? null,
      })),
    ),
  }
}

/** Most recent incidents of one monitor (detail page card). */
export async function recentMonitorIncidents(
  payload: Payload,
  monitorId: Id,
  options: { limit?: number; user?: RequestUser } = {},
): Promise<MonitorIncidentSummary[]> {
  const { docs } = await payload.find({
    collection: 'monitor-incidents',
    where: { monitor: { equals: monitorId } },
    sort: '-startedAt',
    limit: options.limit ?? 5,
    depth: 0,
    ...(options.user ? { user: options.user, overrideAccess: false } : { overrideAccess: true }),
  })
  return serializeIncidents(payload, docs as MonitorIncident[])
}

/**
 * Loads an incident as the user, and only when it belongs to `orgId`. `null` for missing, foreign and
 * forbidden incidents alike, so callers answer 404 without leaking existence.
 */
export async function loadOrgIncident(
  payload: Payload,
  user: RequestUser,
  orgId: Id,
  id: Id,
): Promise<MonitorIncident | null> {
  try {
    const doc = (await payload.findByID({
      collection: 'monitor-incidents',
      id,
      depth: 0,
      user,
      overrideAccess: false,
    })) as MonitorIncident
    return String(relId(doc.organization)) === String(orgId) ? doc : null
  } catch {
    return null
  }
}

/** Render time for server components (ongoing durations hydrate from it). */
export const renderTime = (): number => Date.now()
