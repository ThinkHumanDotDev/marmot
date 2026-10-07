/**
 * Compact views of incidents and maintenance windows for lists (the main page's past incidents
 * and the history page, #107), plus the calendar helpers both use. Days and months are taken in
 * the organization's time zone, the zone the page renders its timestamps in.
 */
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'

import type { IncidentStatus } from '@/lib/incident-timeline'
import type { OccurrenceState } from '@/lib/maintenance-announcements'
import type { ComponentImpact } from '@/lib/status-page-components'
import type { EventKind } from '@/lib/status-page-events'
import type { PublicMaintenance } from '@/server/maintenance/status-page'

import type { PublicIncident } from './public'

export interface PublicEventComponent {
  /** Component id, as in `groups[].monitors[].componentId`. */
  id: string
  name: string
}

/** One row of an event list. */
export interface PublicEventSummary {
  kind: EventKind
  /** Short id of the permalink (`<page>/events/<kind>/<publicId>`). */
  publicId: string
  title: string
  /** Incident status, or the maintenance occurrence's state. */
  status: IncidentStatus | OccurrenceState
  /** Worst impact the incident had; null for maintenance. */
  impact: ComponentImpact | null
  /** Still going on (unresolved incident, running maintenance). */
  ongoing: boolean
  /** ISO: first update of the incident; actual (else planned) start of the maintenance. */
  start: string
  /** ISO: resolution / completion / cancellation; null while ongoing. */
  end: string | null
  /** Components the event affected (only those visible on the page). */
  components: PublicEventComponent[]
  /** The latest update (Markdown message), if any. */
  latest: { status: IncidentStatus | OccurrenceState; message: string; postedAt: string } | null
}

export interface PublicIncidentDay {
  /** `YYYY-MM-DD` in the organization's time zone. */
  date: string
  /** ISO instant the day starts at (for formatting). */
  start: string
  incidents: PublicEventSummary[]
}

const IMPACT_RANK: Record<ComponentImpact, number> = {
  operational: 0,
  degraded_performance: 1,
  partial_outage: 2,
  major_outage: 3,
}

/** List view of an incident. Its impact is the worst any update declared, not the current one. */
export function incidentSummary(incident: PublicIncident): PublicEventSummary {
  const components = new Map<string, PublicEventComponent>()
  let impact: ComponentImpact = incident.impact
  for (const update of incident.updates) {
    for (const c of update.components) {
      if (!components.has(c.id)) components.set(c.id, { id: c.id, name: c.name })
      if (IMPACT_RANK[c.impact] > IMPACT_RANK[impact]) impact = c.impact
    }
  }
  const latest = incident.updates[0]
  return {
    kind: 'incident',
    publicId: incident.publicId,
    title: incident.title,
    status: incident.status,
    impact,
    ongoing: incident.active,
    start: incident.startedAt,
    end: incident.active ? null : incident.resolvedAt,
    components: [...components.values()],
    latest: latest
      ? { status: latest.status, message: latest.message, postedAt: latest.postedAt }
      : null,
  }
}

/** List view of a maintenance occurrence; `components` are the page components it covers. */
export function maintenanceSummary(
  item: PublicMaintenance,
  components: PublicEventComponent[] = [],
): PublicEventSummary {
  const latest = item.updates[0]
  const finished = item.completedAt ?? item.cancelledAt
  return {
    kind: 'maintenance',
    publicId: item.publicId,
    title: item.title,
    status: item.state,
    impact: null,
    ongoing: item.status === 'under-maintenance',
    start: item.startedAt ?? item.start ?? finished ?? new Date(0).toISOString(),
    end: finished ?? null,
    components,
    latest: latest
      ? { status: latest.status, message: latest.message, postedAt: latest.postedAt }
      : null,
  }
}

/** `YYYY-MM-DD` of `date` in `timeZone`. */
export const dayKey = (date: Date | string, timeZone: string): string =>
  formatInTimeZone(new Date(date), timeZone, 'yyyy-MM-dd')

/** `YYYY-MM` of `date` in `timeZone`. */
export const monthKey = (date: Date | string, timeZone: string): string =>
  formatInTimeZone(new Date(date), timeZone, 'yyyy-MM')

/** The instant a `YYYY-MM-DD` day starts in `timeZone`. */
export const dayStart = (day: string, timeZone: string): Date =>
  fromZonedTime(`${day}T00:00:00`, timeZone)

/** `[start, end)` of a `YYYY-MM` month in `timeZone`. */
export function monthRange(month: string, timeZone: string): { start: Date; end: Date } {
  const [year, mon] = month.split('-').map(Number) as [number, number]
  const next = mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, '0')}`
  return {
    start: fromZonedTime(`${month}-01T00:00:00`, timeZone),
    end: fromZonedTime(`${next}-01T00:00:00`, timeZone),
  }
}

/** The last `days` calendar days (today first) as `YYYY-MM-DD` in `timeZone`. */
export function lastDays(days: number, timeZone: string, now = new Date()): string[] {
  const out: string[] = []
  // Step back from noon of the current day so DST changes never skip or repeat a day.
  let cursor = fromZonedTime(`${dayKey(now, timeZone)}T12:00:00`, timeZone)
  for (let i = 0; i < days; i += 1) {
    out.push(dayKey(cursor, timeZone))
    cursor = fromZonedTime(
      `${dayKey(new Date(cursor.getTime() - 24 * 60 * 60_000), timeZone)}T12:00:00`,
      timeZone,
    )
  }
  return out
}

/**
 * Incidents grouped by the day they started, for each of the last `days` days (today first).
 * Incidents that started before the oldest day are left out; days without incidents are kept.
 */
export function pastIncidentDays(
  incidents: readonly PublicIncident[],
  days: number,
  timeZone: string,
  now = new Date(),
): PublicIncidentDay[] {
  const keys = lastDays(days, timeZone, now)
  const byDay = new Map<string, PublicEventSummary[]>(keys.map((key) => [key, []]))
  const sorted = incidents.slice().sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
  for (const incident of sorted) {
    byDay.get(dayKey(incident.startedAt, timeZone))?.push(incidentSummary(incident))
  }
  return keys.map((date) => ({
    date,
    start: dayStart(date, timeZone).toISOString(),
    incidents: byDay.get(date) ?? [],
  }))
}
