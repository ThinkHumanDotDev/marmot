/**
 * Declared incidents (#101): the internal incident-response record a team declares and runs —
 * severity, commander, an append-only timeline and a postmortem. Kept free of server imports so the
 * collection, the API, the worker and the UI share the same rules.
 *
 * They are distinct from monitor incidents (`monitor-incidents`, opened by the engine for one
 * monitor's outage) and from public status-page incidents (`incidents`, what visitors read). A
 * declared incident may start from a monitor incident (`monitorIncident`, which pre-fills
 * `startedAt`) and may link to the status-page incident that carries its public communication
 * (`statusPageIncident`); neither is copied.
 */

export const DECLARED_INCIDENT_SEVERITIES = ['critical', 'major', 'minor'] as const
export type DeclaredIncidentSeverity = (typeof DECLARED_INCIDENT_SEVERITIES)[number]

export const DECLARED_INCIDENT_STATUSES = [
  'open',
  'mitigated',
  'resolved',
  'closed',
  'canceled',
] as const
export type DeclaredIncidentStatus = (typeof DECLARED_INCIDENT_STATUSES)[number]

/** Incidents someone is still working on (reminders run, the list's "active" filter). */
export const ACTIVE_DECLARED_STATUSES: readonly DeclaredIncidentStatus[] = ['open', 'mitigated']

/** Read-only once reached. */
export const TERMINAL_DECLARED_STATUSES: readonly DeclaredIncidentStatus[] = ['closed', 'canceled']

/**
 * Allowed status changes. Forward through open → mitigated → resolved → closed (mitigated may be
 * skipped), back to `open` when a fix did not hold, and `canceled` for a false alarm before it is
 * resolved. Closed and canceled incidents are read-only.
 */
export const DECLARED_STATUS_TRANSITIONS: Record<
  DeclaredIncidentStatus,
  readonly DeclaredIncidentStatus[]
> = {
  open: ['mitigated', 'resolved', 'canceled'],
  mitigated: ['open', 'resolved', 'canceled'],
  resolved: ['open', 'closed'],
  closed: [],
  canceled: [],
}

export const canTransition = (from: DeclaredIncidentStatus, to: DeclaredIncidentStatus): boolean =>
  DECLARED_STATUS_TRANSITIONS[from].includes(to)

export const isTerminalStatus = (status: string | null | undefined): boolean =>
  (TERMINAL_DECLARED_STATUSES as readonly string[]).includes(status ?? '')

export const isDeclaredSeverity = (value: unknown): value is DeclaredIncidentSeverity =>
  typeof value === 'string' && (DECLARED_INCIDENT_SEVERITIES as readonly string[]).includes(value)

export const isDeclaredStatus = (value: unknown): value is DeclaredIncidentStatus =>
  typeof value === 'string' && (DECLARED_INCIDENT_STATUSES as readonly string[]).includes(value)

export const DECLARED_TIMELINE_TYPES = [
  'declared',
  'severity_changed',
  'status_changed',
  'commander_changed',
  'note',
  'linked',
  'unlinked',
  'postmortem_drafted',
  'postmortem_approved',
  'closed',
  'title_changed',
  'summary_changed',
  'started_changed',
  'action_item_added',
  'action_item_done',
] as const
export type DeclaredTimelineType = (typeof DECLARED_TIMELINE_TYPES)[number]

export const POSTMORTEM_STATUSES = ['none', 'draft', 'approved'] as const
export type PostmortemStatus = (typeof POSTMORTEM_STATUSES)[number]

/** Sections of the postmortem template, in order (headings come from `declaredIncidents.postmortem.sections`). */
export const POSTMORTEM_SECTIONS = [
  'summary',
  'impact',
  'timeline',
  'rootCause',
  'wentWell',
  'wentWrong',
  'actionItems',
] as const
export type PostmortemSection = (typeof POSTMORTEM_SECTIONS)[number]

/** `## Summary\n\n## Impact\n\n…` from the translated section headings. */
export const postmortemTemplate = (heading: (section: PostmortemSection) => string): string =>
  POSTMORTEM_SECTIONS.map((section) => `## ${heading(section)}\n\n`).join('')

/** Inactivity after which the commander is reminded, per severity. */
export const REMINDER_THRESHOLD_SECONDS: Record<DeclaredIncidentSeverity, number> = {
  critical: 3600,
  major: 4 * 3600,
  minor: 24 * 3600,
}

/** Longest gap between two reminders. */
export const MAX_REMINDER_GAP_SECONDS = 7 * 24 * 3600

/**
 * Seconds until the next reminder: the severity's threshold after the last activity, then doubling
 * with every reminder already sent (1 h, 2 h, 4 h, … for a critical incident), capped at a week.
 */
export function reminderDelaySeconds(
  severity: DeclaredIncidentSeverity,
  remindersSent: number,
): number {
  const base = REMINDER_THRESHOLD_SECONDS[severity] ?? REMINDER_THRESHOLD_SECONDS.major
  const factor = 2 ** Math.min(Math.max(remindersSent, 0), 16)
  return Math.min(base * factor, MAX_REMINDER_GAP_SECONDS)
}

/** Events channels and the commander hear about. */
export const DECLARED_NOTIFICATION_EVENTS = ['declared', 'commander', 'status', 'reminder'] as const
export type DeclaredNotificationEvent = (typeof DECLARED_NOTIFICATION_EVENTS)[number]

export interface DeclaredPerson {
  id: string
  name: string
}

/** A follow-up of the postmortem, tracked on its own (an issue tracker can turn it into a ticket). */
export interface DeclaredActionItem {
  id: string
  title: string
  owner: DeclaredPerson | null
  /** `YYYY-MM-DD`. */
  dueDate: string | null
  done: boolean
  /** The ticket tracking it, when there is one. */
  ticketUrl: string | null
}

/** Most action items one postmortem holds. */
export const MAX_ACTION_ITEMS = 50

export interface DeclaredTimelineEntry {
  id: string
  type: DeclaredTimelineType
  at: string
  by: DeclaredPerson | null
  from: string | null
  to: string | null
  message: string | null
}

/** What the API, the realtime event and the UI exchange. */
export interface DeclaredIncidentSummary {
  id: string
  organizationId: string
  title: string
  severity: DeclaredIncidentSeverity
  status: DeclaredIncidentStatus
  summary: string | null
  commander: DeclaredPerson | null
  declaredBy: DeclaredPerson | null
  startedAt: string
  mitigatedAt: string | null
  resolvedAt: string | null
  closedAt: string | null
  canceledAt: string | null
  lastActivityAt: string | null
  monitorIncident: { id: string; monitorName: string | null } | null
  statusPageIncident: { id: string; title: string; statusPage: string | null } | null
  postmortem: {
    status: PostmortemStatus
    content: string
    approvedBy: DeclaredPerson | null
    approvedAt: string | null
    actionItems: DeclaredActionItem[]
  }
  postmortemSkipped: boolean
  timeline: DeclaredTimelineEntry[]
}

export const DECLARED_STATUS_FILTERS = ['active', 'all', ...DECLARED_INCIDENT_STATUSES] as const
export type DeclaredStatusFilter = (typeof DECLARED_STATUS_FILTERS)[number]

export const isDeclaredStatusFilter = (value: unknown): value is DeclaredStatusFilter =>
  typeof value === 'string' && (DECLARED_STATUS_FILTERS as readonly string[]).includes(value)

/** The list's commander filter: a user id, or `none` for incidents nobody commands. */
export const UNASSIGNED_COMMANDER = 'none'

/** Counts and response times over the incidents matching the list's severity and commander filters. */
export interface DeclaredIncidentStats {
  total: number
  /** Open or mitigated. */
  active: number
  canceled: number
  /** Mean seconds from the start to mitigation (or resolution when it was never mitigated). */
  meanTimeToMitigate: number | null
  /** Mean seconds from the start to resolution, over resolved and closed incidents. */
  meanTimeToResolve: number | null
}

const seconds = (from: string, to: string): number | null => {
  const value = (new Date(to).getTime() - new Date(from).getTime()) / 1000
  return Number.isFinite(value) ? Math.max(0, value) : null
}

const mean = (values: number[]): number | null =>
  values.length ? Math.round(values.reduce((sum, v) => sum + v, 0) / values.length) : null

/** Counts plus mean time to mitigate and to resolve; canceled incidents (false alarms) are not timed. */
export function summarizeDeclaredIncidents(
  incidents: readonly Pick<
    DeclaredIncidentSummary,
    'status' | 'startedAt' | 'mitigatedAt' | 'resolvedAt'
  >[],
): DeclaredIncidentStats {
  const mitigate: number[] = []
  const resolve: number[] = []
  let active = 0
  let canceled = 0
  for (const incident of incidents) {
    if (ACTIVE_DECLARED_STATUSES.includes(incident.status)) active++
    if (incident.status === 'canceled') {
      canceled++
      continue
    }
    const mitigatedAt = incident.mitigatedAt ?? incident.resolvedAt
    const ttm = mitigatedAt ? seconds(incident.startedAt, mitigatedAt) : null
    if (ttm !== null) mitigate.push(ttm)
    const ttr = incident.resolvedAt ? seconds(incident.startedAt, incident.resolvedAt) : null
    if (ttr !== null) resolve.push(ttr)
  }
  return {
    total: incidents.length,
    active,
    canceled,
    meanTimeToMitigate: mean(mitigate),
    meanTimeToResolve: mean(resolve),
  }
}
