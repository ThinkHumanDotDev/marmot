/**
 * Event history of a status page (issue #107): every incident and maintenance window the page
 * announced, for the history page (`/status/:slug/events`), the permalinks
 * (`/status/:slug/events/incident/:publicId`, `…/maintenance/:publicId`), their JSON API and the
 * sitemap. Like `public.ts`, everything reads with `overrideAccess: true`; callers check the
 * visitor's access to the page (`checkStatusPageAccess`) first.
 *
 * What is public:
 * - incidents of the page (all of them: incidents have no draft state);
 * - occurrences of maintenances that list the page in `statusPages`: running, completed and
 *   cancelled ones always, `scheduled` ones only while the maintenance is active. Unannounced
 *   occurrences that were dropped are deleted (`syncMaintenance`), so they never show up.
 * Components are named only when they are visible on the page (active monitors of the page's
 * organization and static components).
 */
import type { Payload, Where } from 'payload'

import { statusPageTimeZone } from '@/i18n/resolve'
import {
  OPEN_OCCURRENCE_STATES,
  FINISHED_OCCURRENCE_STATES,
  type OccurrenceState,
} from '@/lib/maintenance-announcements'
import { componentDisplayName, type ComponentType } from '@/lib/status-page-components'
import {
  EVENTS_PER_PAGE,
  isPublicId,
  type EventFilters,
  type EventKind,
} from '@/lib/status-page-events'
import {
  maintenanceTimezone,
  toPublicMaintenance,
  type PublicMaintenance,
} from '@/server/maintenance/status-page'
import { relationId } from '@/server/maintenance/serialize'

import {
  incidentSummary,
  maintenanceSummary,
  monthKey,
  monthRange,
  type PublicEventComponent,
  type PublicEventSummary,
} from './event-summary'
import { toPublicIncident, type PublicIncident } from './public'
import { derivePublicId, publicIdOf } from './public-ids'

import type {
  Incident,
  Maintenance,
  MaintenanceOccurrence,
  Monitor,
  StatusPage,
} from '@/payload-types'

/** States of the occurrences listed in the history (they started, or were announced and cancelled). */
export const HISTORY_OCCURRENCE_STATES: readonly OccurrenceState[] = [
  ...OPEN_OCCURRENCE_STATES,
  ...FINISHED_OCCURRENCE_STATES,
]

/** Most events of each kind the history indexes (older ones are not listed). */
export const MAX_HISTORY_EVENTS = 5000

/** Months offered by the month filter, newest first. */
export const MAX_HISTORY_MONTHS = 60

// ---- Components ----------------------------------------------------------------------------------

/** A component of the page as the public sees it. */
export interface PageComponent {
  /** Component id (the group row id). */
  id: string
  name: string
  type: ComponentType
  /** Monitor id of `monitor` components. */
  monitorId: string | null
}

/**
 * The page's visible components, in page order: static components and the rows of active monitors
 * of the page's organization (as on the page itself; paused or foreign monitors are left out).
 */
export async function pageComponents(payload: Payload, page: StatusPage): Promise<PageComponent[]> {
  const ids = new Set<string>()
  for (const group of page.groups ?? []) {
    for (const row of group.monitors ?? []) {
      if (row.type === 'static') continue
      const id = relationId(row.monitor)
      if (id !== null) ids.add(String(id))
    }
  }
  const monitors =
    ids.size === 0
      ? []
      : (
          await payload.find({
            collection: 'monitors',
            where: {
              and: [
                { id: { in: [...ids] } },
                { organization: { equals: relationId(page.organization) } },
                { active: { equals: true } },
              ],
            },
            depth: 0,
            limit: ids.size,
            pagination: false,
            overrideAccess: true,
            select: { name: true, publicName: true },
          })
        ).docs
  const byId = new Map(
    monitors.map((m) => [String(m.id), m as Pick<Monitor, 'name' | 'publicName'>]),
  )

  const out: PageComponent[] = []
  for (const group of page.groups ?? []) {
    for (const row of group.monitors ?? []) {
      if (!row.id) continue
      if (row.type === 'static') {
        out.push({
          id: String(row.id),
          name: componentDisplayName(row.name),
          type: 'static',
          monitorId: null,
        })
        continue
      }
      const monitorId = String(relationId(row.monitor))
      const monitor = byId.get(monitorId)
      if (!monitor) continue
      out.push({
        id: String(row.id),
        name: componentDisplayName(row.name, monitor),
        type: 'monitor',
        monitorId,
      })
    }
  }
  return out
}

const namesOf = (components: readonly PageComponent[]): Map<string, string> =>
  new Map(components.map((c) => [c.id, c.name]))

/** Page components a maintenance covers: rows of its monitors, and static components (always). */
function maintenanceComponents(
  doc: Pick<Maintenance, 'monitors'>,
  components: readonly PageComponent[],
): PublicEventComponent[] {
  const monitors = new Set(
    (doc.monitors ?? [])
      .map(relationId)
      .filter((id) => id !== null)
      .map(String),
  )
  return components
    .filter((c) => c.type === 'monitor' && c.monitorId !== null && monitors.has(c.monitorId))
    .map(({ id, name }) => ({ id, name }))
}

// ---- Maintenance of the page -------------------------------------------------------------------

/** Maintenances that announce on the page. */
async function pageMaintenances(payload: Payload, page: StatusPage): Promise<Maintenance[]> {
  const { docs } = await payload.find({
    collection: 'maintenance',
    where: { statusPages: { equals: page.id } },
    depth: 0,
    limit: 500,
    pagination: false,
    overrideAccess: true,
  })
  return docs as Maintenance[]
}

/** Is this occurrence of `doc` public on the page? */
export const isPublicOccurrence = (
  doc: Pick<Maintenance, 'active'>,
  occurrence: Pick<MaintenanceOccurrence, 'state'>,
): boolean =>
  HISTORY_OCCURRENCE_STATES.includes(occurrence.state) ||
  (occurrence.state === 'scheduled' && doc.active !== false)

// ---- History -------------------------------------------------------------------------------------

export interface EventHistory {
  events: PublicEventSummary[]
  /** 1-based, clamped to the last page. */
  page: number
  totalPages: number
  totalEvents: number
  perPage: number
  /** `YYYY-MM` months from the newest to the oldest event (for the month filter). */
  months: string[]
  /** Components visible on the page (for the component filter). */
  components: PublicEventComponent[]
  /** The filters applied, normalised (unknown components are dropped). */
  filters: EventFilters
  /** ISO range covered by the listed events (oldest start, newest start), null when empty. */
  range: { from: string; to: string } | null
}

interface IndexEntry {
  kind: EventKind
  id: string | number
  /** Sort key (ms). */
  time: number
}

function monthsBetween(oldest: Date | null, timeZone: string, now: Date): string[] {
  if (!oldest) return []
  const out: string[] = []
  const last = monthKey(oldest, timeZone)
  let [year, month] = monthKey(now, timeZone).split('-').map(Number) as [number, number]
  while (out.length < MAX_HISTORY_MONTHS) {
    const key = `${year}-${String(month).padStart(2, '0')}`
    out.push(key)
    if (key <= last) break
    month -= 1
    if (month === 0) {
      month = 12
      year -= 1
    }
  }
  return out
}

/**
 * One page of the history, newest first. Incidents are dated by creation, maintenance windows by
 * their planned start; both are merged before paginating.
 */
export async function listStatusPageEvents(
  payload: Payload,
  page: StatusPage,
  requested: EventFilters,
  options: { perPage?: number; now?: Date } = {},
): Promise<EventHistory> {
  const now = options.now ?? new Date()
  const perPage = options.perPage ?? EVENTS_PER_PAGE
  const timeZone = statusPageTimeZone(page)
  const [components, maintenances] = await Promise.all([
    pageComponents(payload, page),
    pageMaintenances(payload, page),
  ])
  const component = requested.component
    ? (components.find((c) => c.id === requested.component) ?? null)
    : null
  const filters: EventFilters = { ...requested, component: component?.id ?? null }
  const range = filters.month ? monthRange(filters.month, timeZone) : null

  const wantIncidents = filters.type !== 'maintenance'
  const wantMaintenance = filters.type !== 'incident'

  // Incidents
  const incidentWhere: Where[] = [{ statusPage: { equals: page.id } }]
  if (component) incidentWhere.push({ 'updates.components.component': { equals: component.id } })
  if (range) {
    incidentWhere.push({ createdAt: { greater_than_equal: range.start.toISOString() } })
    incidentWhere.push({ createdAt: { less_than: range.end.toISOString() } })
  }

  // Maintenance windows of the maintenances covering the component (static: all of them).
  const covering = maintenances.filter(
    (doc) =>
      !component ||
      component.type === 'static' ||
      (doc.monitors ?? []).some((m) => String(relationId(m)) === component.monitorId),
  )
  const occurrenceWhere: Where[] = [
    { maintenance: { in: covering.map((doc) => doc.id) } },
    { state: { in: [...HISTORY_OCCURRENCE_STATES] } },
  ]
  if (range) {
    occurrenceWhere.push({ start: { greater_than_equal: range.start.toISOString() } })
    occurrenceWhere.push({ start: { less_than: range.end.toISOString() } })
  }

  const [incidentIndex, occurrenceIndex, oldestIncident, oldestOccurrence] = await Promise.all([
    wantIncidents
      ? payload.find({
          collection: 'incidents',
          where: { and: incidentWhere },
          sort: '-createdAt',
          limit: MAX_HISTORY_EVENTS,
          depth: 0,
          overrideAccess: true,
          select: { createdAt: true },
        })
      : null,
    wantMaintenance && covering.length > 0
      ? payload.find({
          collection: 'maintenance-occurrences',
          where: { and: occurrenceWhere },
          sort: '-start',
          limit: MAX_HISTORY_EVENTS,
          depth: 0,
          overrideAccess: true,
          select: { start: true },
        })
      : null,
    payload.find({
      collection: 'incidents',
      where: { statusPage: { equals: page.id } },
      sort: 'createdAt',
      limit: 1,
      depth: 0,
      overrideAccess: true,
      select: { createdAt: true },
    }),
    maintenances.length > 0
      ? payload.find({
          collection: 'maintenance-occurrences',
          where: {
            and: [
              { maintenance: { in: maintenances.map((doc) => doc.id) } },
              { state: { in: [...HISTORY_OCCURRENCE_STATES] } },
            ],
          },
          sort: 'start',
          limit: 1,
          depth: 0,
          overrideAccess: true,
          select: { start: true },
        })
      : null,
  ])

  const index: IndexEntry[] = [
    ...(incidentIndex?.docs ?? []).map((doc) => ({
      kind: 'incident' as const,
      id: doc.id,
      time: Date.parse(doc.createdAt) || 0,
    })),
    ...(occurrenceIndex?.docs ?? []).map((doc) => ({
      kind: 'maintenance' as const,
      id: doc.id,
      time: Date.parse(doc.start) || 0,
    })),
  ].sort((a, b) => b.time - a.time)

  const totalEvents = index.length
  const totalPages = Math.max(1, Math.ceil(totalEvents / perPage))
  const pageNumber = Math.min(Math.max(1, filters.page), totalPages)
  const slice = index.slice((pageNumber - 1) * perPage, pageNumber * perPage)

  const incidentIds = slice.filter((e) => e.kind === 'incident').map((e) => e.id)
  const occurrenceIds = slice.filter((e) => e.kind === 'maintenance').map((e) => e.id)
  const [incidentDocs, occurrenceDocs] = await Promise.all([
    incidentIds.length
      ? payload
          .find({
            collection: 'incidents',
            where: { id: { in: incidentIds } },
            limit: incidentIds.length,
            pagination: false,
            depth: 0,
            overrideAccess: true,
          })
          .then((r) => r.docs)
      : [],
    occurrenceIds.length
      ? payload
          .find({
            collection: 'maintenance-occurrences',
            where: { id: { in: occurrenceIds } },
            limit: occurrenceIds.length,
            pagination: false,
            depth: 0,
            overrideAccess: true,
          })
          .then((r) => r.docs as MaintenanceOccurrence[])
      : [],
  ])

  const names = namesOf(components)
  const maintenanceById = new Map(maintenances.map((doc) => [String(doc.id), doc]))
  const incidentsById = new Map(incidentDocs.map((doc) => [String(doc.id), doc]))
  const occurrencesById = new Map(occurrenceDocs.map((doc) => [String(doc.id), doc]))
  const zones = new Map<string, Promise<string>>()
  const zoneOf = (doc: Maintenance) => {
    const key = String(doc.id)
    if (!zones.has(key)) zones.set(key, maintenanceTimezone(payload, doc))
    return zones.get(key) as Promise<string>
  }

  const events: PublicEventSummary[] = []
  for (const entry of slice) {
    if (entry.kind === 'incident') {
      const doc = incidentsById.get(String(entry.id))
      if (doc) events.push(incidentSummary(toPublicIncident(doc, names)))
      continue
    }
    const occurrence = occurrencesById.get(String(entry.id))
    const doc = occurrence ? maintenanceById.get(String(relationId(occurrence.maintenance))) : null
    if (!occurrence || !doc) continue
    events.push(
      maintenanceSummary(
        toPublicMaintenance(doc, occurrence, await zoneOf(doc)),
        maintenanceComponents(doc, components),
      ),
    )
  }

  const oldestTimes = [oldestIncident.docs[0]?.createdAt, oldestOccurrence?.docs[0]?.start].flatMap(
    (value) => (value ? [new Date(value)] : []),
  )
  const oldest = oldestTimes.length
    ? new Date(Math.min(...oldestTimes.map((d) => d.getTime())))
    : null

  return {
    events,
    page: pageNumber,
    totalPages,
    totalEvents,
    perPage,
    months: monthsBetween(oldest, timeZone, now),
    components: components.map(({ id, name }) => ({ id, name })),
    filters: { ...filters, page: pageNumber },
    range:
      events.length > 0
        ? {
            from: events.reduce((min, e) => (e.start < min ? e.start : min), events[0].start),
            to: events.reduce((max, e) => (e.start > max ? e.start : max), events[0].start),
          }
        : null,
  }
}

// ---- Permalinks ----------------------------------------------------------------------------------

/**
 * Finds a document of `collection` by public id. Documents written before public ids existed have
 * none stored; their derived id is matched among the candidates without one.
 */
async function findByPublicId<T extends { id: string | number; publicId?: string | null }>(
  payload: Payload,
  collection: 'incidents' | 'maintenance-occurrences',
  scope: Where,
  publicId: string,
): Promise<T | null> {
  const stored = await payload.find({
    collection,
    where: { and: [scope, { publicId: { equals: publicId } }] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  if (stored.docs[0]) return stored.docs[0] as unknown as T
  const legacy = await payload.find({
    collection,
    where: {
      and: [scope, { publicId: { exists: false } }],
    },
    limit: MAX_HISTORY_EVENTS,
    depth: 0,
    overrideAccess: true,
    select: { createdAt: true },
  })
  const match = legacy.docs.find((doc) => derivePublicId(collection, doc.id) === publicId)
  if (!match) return null
  return (await payload.findByID({
    collection,
    id: match.id,
    depth: 0,
    overrideAccess: true,
  })) as unknown as T
}

export interface PublicIncidentEvent {
  incident: PublicIncident
  summary: PublicEventSummary
}

/** The incident of `page` with this public id, or null. */
export async function getIncidentEvent(
  payload: Payload,
  page: StatusPage,
  publicId: string,
): Promise<PublicIncidentEvent | null> {
  if (!isPublicId(publicId)) return null
  const doc = await findByPublicId<Incident>(
    payload,
    'incidents',
    { statusPage: { equals: page.id } },
    publicId,
  )
  if (!doc) return null
  const components = await pageComponents(payload, page)
  const incident = toPublicIncident(doc, namesOf(components))
  return { incident, summary: incidentSummary(incident) }
}

export interface PublicMaintenanceEvent {
  maintenance: PublicMaintenance
  summary: PublicEventSummary
}

/** The public maintenance occurrence of `page` with this public id, or null. */
export async function getMaintenanceEvent(
  payload: Payload,
  page: StatusPage,
  publicId: string,
): Promise<PublicMaintenanceEvent | null> {
  if (!isPublicId(publicId)) return null
  const maintenances = await pageMaintenances(payload, page)
  if (maintenances.length === 0) return null
  const occurrence = await findByPublicId<MaintenanceOccurrence>(
    payload,
    'maintenance-occurrences',
    { maintenance: { in: maintenances.map((doc) => doc.id) } },
    publicId,
  )
  const doc = occurrence
    ? maintenances.find((m) => String(m.id) === String(relationId(occurrence.maintenance)))
    : undefined
  if (!occurrence || !doc || !isPublicOccurrence(doc, occurrence)) return null
  const [components, zone] = await Promise.all([
    pageComponents(payload, page),
    maintenanceTimezone(payload, doc),
  ])
  const maintenance = toPublicMaintenance(doc, occurrence, zone)
  return {
    maintenance,
    summary: maintenanceSummary(maintenance, maintenanceComponents(doc, components)),
  }
}

// ---- Sitemap -------------------------------------------------------------------------------------

export interface SitemapEvent {
  kind: EventKind
  publicId: string
  /** ISO time of the last change. */
  lastModified: string
}

/** Every public event of the page (newest first) for `sitemap.xml`. */
export async function sitemapEvents(payload: Payload, page: StatusPage): Promise<SitemapEvent[]> {
  const maintenances = await pageMaintenances(payload, page)
  const [incidents, occurrences] = await Promise.all([
    payload.find({
      collection: 'incidents',
      where: { statusPage: { equals: page.id } },
      sort: '-createdAt',
      limit: MAX_HISTORY_EVENTS,
      depth: 0,
      overrideAccess: true,
      select: { publicId: true, updatedAt: true },
    }),
    maintenances.length > 0
      ? payload.find({
          collection: 'maintenance-occurrences',
          where: { maintenance: { in: maintenances.map((doc) => doc.id) } },
          sort: '-start',
          limit: MAX_HISTORY_EVENTS,
          depth: 0,
          overrideAccess: true,
          select: { publicId: true, updatedAt: true, state: true, maintenance: true },
        })
      : null,
  ])
  const byId = new Map(maintenances.map((doc) => [String(doc.id), doc]))
  return [
    ...incidents.docs.map((doc) => ({
      kind: 'incident' as const,
      publicId: publicIdOf('incidents', doc),
      lastModified: doc.updatedAt,
    })),
    ...(occurrences?.docs ?? []).flatMap((doc) => {
      const maintenance = byId.get(String(relationId(doc.maintenance)))
      if (!maintenance || !isPublicOccurrence(maintenance, doc as MaintenanceOccurrence)) return []
      return [
        {
          kind: 'maintenance' as const,
          publicId: publicIdOf('maintenance-occurrences', doc),
          lastModified: doc.updatedAt,
        },
      ]
    }),
  ]
}
