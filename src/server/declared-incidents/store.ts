/**
 * Reads of `declared-incidents` and their serialization to `DeclaredIncidentSummary`. Member reads
 * pass the request user with `overrideAccess: false`; names of people, monitors and linked
 * status-page incidents are looked up in batches once the incident itself was authorised.
 */
import type { Payload, Where } from 'payload'

import {
  ACTIVE_DECLARED_STATUSES,
  type DeclaredIncidentSeverity,
  type DeclaredIncidentStatus,
  type DeclaredIncidentSummary,
  type DeclaredPerson,
  type DeclaredStatusFilter,
  type DeclaredTimelineType,
  type PostmortemStatus,
} from '@/lib/declared-incidents'
import type { DeclaredIncident, Incident, Monitor, MonitorIncident, User } from '@/payload-types'
import type { RequestUser } from '@/server/monitors/http'

import { relId, type Id } from './ids'

const iso = (value: string | null | undefined): string | null => value ?? null

const personName = (user: Pick<User, 'name' | 'email'>): string =>
  user.name?.trim() || user.email || ''

async function lookup<T extends { id: Id }>(
  payload: Payload,
  collection: 'users' | 'incidents' | 'monitor-incidents' | 'monitors',
  ids: Set<string>,
  select: Record<string, true>,
): Promise<Map<string, T>> {
  if (ids.size === 0) return new Map()
  const raw = [...ids].map((id) =>
    payload.db.defaultIDType === 'number' && /^\d+$/.test(id) ? Number(id) : id,
  )
  const { docs } = await payload.find({
    collection,
    where: { id: { in: raw } },
    limit: ids.size,
    pagination: false,
    depth: 0,
    overrideAccess: true,
    select,
  })
  return new Map((docs as unknown as T[]).map((doc) => [String(doc.id), doc]))
}

export async function serializeDeclaredIncidents(
  payload: Payload,
  docs: DeclaredIncident[],
): Promise<DeclaredIncidentSummary[]> {
  if (docs.length === 0) return []
  const userIds = new Set<string>()
  const spIds = new Set<string>()
  const miIds = new Set<string>()
  const addUser = (value: unknown) => {
    const id = relId(value)
    if (id !== null) userIds.add(String(id))
  }
  for (const doc of docs) {
    addUser(doc.commander)
    addUser(doc.declaredBy)
    addUser(doc.postmortem?.approvedBy)
    for (const entry of doc.timeline ?? []) {
      addUser(entry.by)
      if (entry.type === 'commander_changed') {
        if (entry.from) userIds.add(entry.from)
        if (entry.to) userIds.add(entry.to)
      }
    }
    const sp = relId(doc.statusPageIncident)
    if (sp !== null) spIds.add(String(sp))
    const mi = relId(doc.monitorIncident)
    if (mi !== null) miIds.add(String(mi))
  }
  const [users, spIncidents, monitorIncidents] = await Promise.all([
    lookup<Pick<User, 'id' | 'name' | 'email'>>(payload, 'users', userIds, {
      name: true,
      email: true,
    }),
    lookup<Pick<Incident, 'id' | 'title' | 'statusPage'>>(payload, 'incidents', spIds, {
      title: true,
      statusPage: true,
    }),
    lookup<Pick<MonitorIncident, 'id' | 'monitor'>>(payload, 'monitor-incidents', miIds, {
      monitor: true,
    }),
  ])
  const monitorIds = new Set(
    [...monitorIncidents.values()]
      .map((doc) => relId(doc.monitor))
      .filter((id): id is Id => id !== null)
      .map(String),
  )
  const monitors = await lookup<Pick<Monitor, 'id' | 'name'>>(payload, 'monitors', monitorIds, {
    name: true,
  })

  const person = (value: unknown): DeclaredPerson | null => {
    const id = relId(value)
    if (id === null) return null
    const user = users.get(String(id))
    return user ? { id: String(id), name: personName(user) } : null
  }
  const personText = (value: string | null | undefined): string | null =>
    value ? (person(value)?.name ?? null) : null

  return docs.map((doc) => {
    const spId = relId(doc.statusPageIncident)
    const sp = spId !== null ? spIncidents.get(String(spId)) : undefined
    const miId = relId(doc.monitorIncident)
    const mi = miId !== null ? monitorIncidents.get(String(miId)) : undefined
    const monitorId = mi ? relId(mi.monitor) : null
    return {
      id: String(doc.id),
      organizationId: String(relId(doc.organization) ?? ''),
      title: doc.title,
      severity: doc.severity as DeclaredIncidentSeverity,
      status: doc.status as DeclaredIncidentStatus,
      summary: doc.summary ?? null,
      commander: person(doc.commander),
      declaredBy: person(doc.declaredBy),
      startedAt: doc.startedAt,
      mitigatedAt: iso(doc.mitigatedAt),
      resolvedAt: iso(doc.resolvedAt),
      closedAt: iso(doc.closedAt),
      canceledAt: iso(doc.canceledAt),
      lastActivityAt: iso(doc.lastActivityAt),
      monitorIncident:
        miId !== null
          ? {
              id: String(miId),
              monitorName:
                monitorId !== null ? (monitors.get(String(monitorId))?.name ?? null) : null,
            }
          : null,
      statusPageIncident: sp
        ? {
            id: String(sp.id),
            title: sp.title,
            statusPage: relId(sp.statusPage) !== null ? String(relId(sp.statusPage)) : null,
          }
        : null,
      postmortem: {
        status: (doc.postmortem?.status ?? 'none') as PostmortemStatus,
        content: doc.postmortem?.content ?? '',
        approvedBy: person(doc.postmortem?.approvedBy),
        approvedAt: iso(doc.postmortem?.approvedAt),
      },
      postmortemSkipped: Boolean(doc.postmortemSkipped),
      timeline: (doc.timeline ?? []).map((entry, index) => ({
        id: entry.id ?? String(index),
        type: entry.type as DeclaredTimelineType,
        at: entry.at,
        by: person(entry.by),
        // Commander changes name the people; other rows carry plain values.
        from: entry.type === 'commander_changed' ? personText(entry.from) : (entry.from ?? null),
        to: entry.type === 'commander_changed' ? personText(entry.to) : (entry.to ?? null),
        message: entry.message ?? null,
      })),
    }
  })
}

export async function serializeDeclaredIncident(
  payload: Payload,
  doc: DeclaredIncident,
): Promise<DeclaredIncidentSummary> {
  const [summary] = await serializeDeclaredIncidents(payload, [doc])
  return summary
}

/**
 * Loads an incident as the user, and only when it belongs to `orgId`; `null` for missing, foreign
 * and forbidden incidents alike, so callers answer 404 without leaking existence.
 */
export async function loadOrgDeclaredIncident(
  payload: Payload,
  user: RequestUser,
  orgId: Id,
  id: Id,
): Promise<DeclaredIncident | null> {
  try {
    const doc = (await payload.findByID({
      collection: 'declared-incidents',
      id,
      depth: 0,
      user,
      overrideAccess: false,
    })) as DeclaredIncident
    return String(relId(doc.organization)) === String(orgId) ? doc : null
  } catch {
    return null
  }
}

export interface DeclaredListOptions {
  status?: DeclaredStatusFilter
  page?: number
  limit?: number
  user: RequestUser
}

export interface DeclaredListResult {
  docs: DeclaredIncidentSummary[]
  page: number
  totalPages: number
  totalDocs: number
}

/** Incidents of an organization as the user, newest first. */
export async function listDeclaredIncidents(
  payload: Payload,
  orgId: Id,
  options: DeclaredListOptions,
): Promise<DeclaredListResult> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100)
  const page = Math.max(options.page ?? 1, 1)
  const and: Where[] = [{ organization: { equals: orgId } }]
  const status = options.status ?? 'all'
  if (status === 'active') and.push({ status: { in: [...ACTIVE_DECLARED_STATUSES] } })
  else if (status !== 'all') and.push({ status: { equals: status } })
  const result = await payload.find({
    collection: 'declared-incidents',
    where: { and },
    sort: '-startedAt',
    limit,
    page,
    depth: 0,
    user: options.user,
    overrideAccess: false,
  })
  return {
    docs: await serializeDeclaredIncidents(payload, result.docs as DeclaredIncident[]),
    page: result.page ?? page,
    totalPages: result.totalPages,
    totalDocs: result.totalDocs,
  }
}
