/**
 * Monitor incidents (issue #100): the internal, on-call side of an outage. Shared by the collection,
 * the engine listener, the route handlers and the client views, so it imports nothing server-only.
 *
 * A monitor incident is opened by the engine when a monitor goes DOWN, acknowledged by a member and
 * resolved automatically when the monitor recovers (or by hand). It is separate from the public
 * status-page `incidents` collection, which is written for visitors; a monitor incident can be
 * published to a status page, which creates a status-page incident and links it
 * (`statusPageIncident`).
 */

export const MONITOR_INCIDENT_STATUSES = ['open', 'acknowledged', 'resolved'] as const
export type MonitorIncidentStatus = (typeof MONITOR_INCIDENT_STATUSES)[number]

/** Unresolved incidents: still counted as "active" by filters and badges. */
export const ACTIVE_INCIDENT_STATUSES: readonly MonitorIncidentStatus[] = ['open', 'acknowledged']

/** Kinds of timeline entries. */
export const INCIDENT_TIMELINE_TYPES = [
  'opened',
  'maintenance',
  'acknowledged',
  'resolved',
  'published',
] as const
export type IncidentTimelineType = (typeof INCIDENT_TIMELINE_TYPES)[number]

/** How an acknowledgement or a manual resolution arrived. */
export const INCIDENT_ACTION_SOURCES = ['dashboard', 'api', 'link'] as const
export type IncidentActionSource = (typeof INCIDENT_ACTION_SOURCES)[number]

/**
 * Stable names of the notifications an incident sends besides the heartbeat ones (`down`, `up`,
 * `reminder`). Per-channel event filters (#126) select on these names.
 */
export const INCIDENT_NOTIFICATION_EVENTS = ['acknowledged', 'resolved'] as const
export type IncidentNotificationEvent = (typeof INCIDENT_NOTIFICATION_EVENTS)[number]

export const isMonitorIncidentStatus = (value: unknown): value is MonitorIncidentStatus =>
  typeof value === 'string' && (MONITOR_INCIDENT_STATUSES as readonly string[]).includes(value)

/** Statuses of a beat that mean "the monitor is not failing" (degraded counts as working, #93). */
const NOT_RECOVERED = new Set(['down', 'pending', 'maintenance'])

export type IncidentBeatAction = 'open' | 'resolve' | 'maintenance' | null

/**
 * What a heartbeat does to the monitor's incident. Only important beats (status transitions) act,
 * so an incident resolved by hand while the monitor is still DOWN stays resolved until the monitor
 * recovers and fails again.
 *
 * - transition to DOWN (from UP, PENDING, MAINTENANCE, or the first beat) → open
 * - transition to MAINTENANCE → note on the open incident, which stays open
 * - transition to a working status (UP, DEGRADED) → resolve automatically
 */
export function incidentActionForBeat(beat: {
  status: string
  important: boolean | null | undefined
}): IncidentBeatAction {
  if (!beat.important) return null
  if (beat.status === 'down') return 'open'
  if (beat.status === 'maintenance') return 'maintenance'
  if (!NOT_RECOVERED.has(beat.status)) return 'resolve'
  return null
}

// ---- Serialized shape (REST responses, realtime payloads, client views) ----------------------

export interface IncidentPerson {
  id: string
  name: string
}

export interface MonitorIncidentTimelineEntry {
  id: string
  type: IncidentTimelineType
  /** ISO time. */
  at: string
  by: IncidentPerson | null
  via: IncidentActionSource | null
  message: string | null
}

export interface MonitorIncidentSummary {
  id: string
  organizationId: string
  monitor: { id: string; name: string } | null
  status: MonitorIncidentStatus
  /** First DOWN message. */
  cause: string | null
  startedAt: string
  acknowledgedAt: string | null
  acknowledgedBy: IncidentPerson | null
  acknowledgedVia: IncidentActionSource | null
  resolvedAt: string | null
  resolvedBy: IncidentPerson | null
  autoResolved: boolean
  remindersSent: number
  lastReminderAt: string | null
  /** Linked public status-page incident, if it was published. */
  statusPageIncident: { id: string; title: string; statusPage: string | null } | null
  timeline: MonitorIncidentTimelineEntry[]
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const value = Date.parse(iso)
  return Number.isFinite(value) ? value : null
}

/** Seconds from start to resolution (or to `now` while unresolved). */
export function incidentDurationSeconds(
  incident: Pick<MonitorIncidentSummary, 'startedAt' | 'resolvedAt'>,
  now: number = Date.now(),
): number {
  const start = ms(incident.startedAt) ?? now
  const end = ms(incident.resolvedAt) ?? now
  return Math.max(0, Math.round((end - start) / 1000))
}

/** Seconds from start to acknowledgement, `null` when it was never acknowledged. */
export function timeToAcknowledgeSeconds(
  incident: Pick<MonitorIncidentSummary, 'startedAt' | 'acknowledgedAt'>,
): number | null {
  const start = ms(incident.startedAt)
  const ack = ms(incident.acknowledgedAt)
  if (start === null || ack === null) return null
  return Math.max(0, Math.round((ack - start) / 1000))
}

export interface IncidentStats {
  total: number
  /** Unresolved and not acknowledged. */
  open: number
  acknowledged: number
  resolved: number
  /** Mean time to acknowledge, seconds, over acknowledged incidents (`null` without any). */
  mtta: number | null
  /** Mean time to resolve, seconds, over resolved incidents (`null` without any). */
  mttr: number | null
}

const mean = (values: number[]): number | null =>
  values.length ? Math.round(values.reduce((sum, v) => sum + v, 0) / values.length) : null

/** Counts plus MTTA/MTTR over a set of incidents. */
export function summarizeIncidents(
  incidents: readonly Pick<
    MonitorIncidentSummary,
    'status' | 'startedAt' | 'acknowledgedAt' | 'resolvedAt'
  >[],
): IncidentStats {
  const acks: number[] = []
  const resolutions: number[] = []
  let open = 0
  let acknowledged = 0
  let resolved = 0
  for (const incident of incidents) {
    if (incident.status === 'open') open++
    else if (incident.status === 'acknowledged') acknowledged++
    else resolved++
    const tta = timeToAcknowledgeSeconds(incident)
    if (tta !== null) acks.push(tta)
    if (incident.status === 'resolved' && incident.resolvedAt) {
      resolutions.push(incidentDurationSeconds(incident))
    }
  }
  return {
    total: incidents.length,
    open,
    acknowledged,
    resolved,
    mtta: mean(acks),
    mttr: mean(resolutions),
  }
}

/** Time windows of the incidents page (by start time). */
export const INCIDENT_RANGES = ['24h', '7d', '30d', '90d', 'all'] as const
export type IncidentRange = (typeof INCIDENT_RANGES)[number]

export const INCIDENT_RANGE_SECONDS: Record<Exclude<IncidentRange, 'all'>, number> = {
  '24h': 86_400,
  '7d': 7 * 86_400,
  '30d': 30 * 86_400,
  '90d': 90 * 86_400,
}

/** Status filter of the incidents page: one status, every unresolved one, or all. */
export const INCIDENT_STATUS_FILTERS = ['active', 'all', ...MONITOR_INCIDENT_STATUSES] as const
export type IncidentStatusFilter = (typeof INCIDENT_STATUS_FILTERS)[number]

export const isIncidentRange = (value: unknown): value is IncidentRange =>
  typeof value === 'string' && (INCIDENT_RANGES as readonly string[]).includes(value)

export const isIncidentStatusFilter = (value: unknown): value is IncidentStatusFilter =>
  typeof value === 'string' && (INCIDENT_STATUS_FILTERS as readonly string[]).includes(value)
