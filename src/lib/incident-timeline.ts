/**
 * Incident timeline model shared by the `incidents` collection hooks, the public status page payload,
 * the RSS feed and the builder UI. Pure functions only (no Payload imports) so it runs in the browser too.
 *
 * An incident is a list of **updates** (`status`, Markdown `message`, `postedAt`, per-component
 * `impact`). Its current state is derived from them:
 *
 * - updates are applied oldest first (`postedAt`, then array order);
 * - an update sets the impact of the components it lists; components left out keep their last impact;
 * - a `resolved` update resets every component to `operational`;
 * - the incident's `status` is the latest update's status and its `impact` the worst current
 *   component impact. Incidents without components carry a declared `impact` instead.
 */

export const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number]

/** Ordered from best to worst. */
export const COMPONENT_IMPACTS = [
  'operational',
  'degraded_performance',
  'partial_outage',
  'major_outage',
] as const
export type ComponentImpact = (typeof COMPONENT_IMPACTS)[number]

/** Legacy card colours of incidents created before the timeline existed. */
export const LEGACY_INCIDENT_STYLES = ['info', 'warning', 'danger', 'primary'] as const
export type LegacyIncidentStyle = (typeof LEGACY_INCIDENT_STYLES)[number]

export type RelationId = string | number

export interface TimelineComponentImpact {
  /** Monitor id (a status page component). */
  monitor: RelationId
  impact: ComponentImpact
}

export interface TimelineUpdate {
  id?: string | null
  status: IncidentStatus
  message?: string | null
  /** ISO timestamp. */
  postedAt: string
  /** ISO timestamp of the last text edit, if any. */
  editedAt?: string | null
  components?: TimelineComponentImpact[] | null
}

export interface IncidentState {
  status: IncidentStatus
  impact: ComponentImpact
  active: boolean
  /** Current impact per component, in order of first mention. */
  components: TimelineComponentImpact[]
  /** `postedAt` of the resolving update, or null while the incident is open. */
  resolvedAt: string | null
}

const impactRank = (impact: ComponentImpact): number => COMPONENT_IMPACTS.indexOf(impact)

export const isIncidentStatus = (value: unknown): value is IncidentStatus =>
  typeof value === 'string' && (INCIDENT_STATUSES as readonly string[]).includes(value)

export const isComponentImpact = (value: unknown): value is ComponentImpact =>
  typeof value === 'string' && (COMPONENT_IMPACTS as readonly string[]).includes(value)

/** The worst of `impacts` (`operational` for an empty list). */
export function worstImpact(impacts: Iterable<ComponentImpact>): ComponentImpact {
  let worst: ComponentImpact = 'operational'
  for (const impact of impacts) if (impactRank(impact) > impactRank(worst)) worst = impact
  return worst
}

/** Migration of the legacy `style` field: info/primary are notices, warning degrades, danger is an outage. */
export function impactFromLegacyStyle(style: string | null | undefined): ComponentImpact {
  switch (style) {
    case 'warning':
      return 'degraded_performance'
    case 'danger':
      return 'major_outage'
    default:
      return 'operational'
  }
}

/** Card colour for an impact; also written back to the legacy `style` field for old API clients. */
export function legacyStyleFromImpact(impact: ComponentImpact): LegacyIncidentStyle {
  switch (impact) {
    case 'major_outage':
      return 'danger'
    case 'partial_outage':
    case 'degraded_performance':
      return 'warning'
    default:
      return 'info'
  }
}

const relKey = (id: RelationId): string => String(id)

/** Updates oldest first: by `postedAt`, then by their position in the stored list. */
export function sortUpdates<T extends Pick<TimelineUpdate, 'postedAt'>>(
  updates: readonly T[],
): T[] {
  return updates
    .map((update, index) => ({ update, index, time: Date.parse(update.postedAt) || 0 }))
    .sort((a, b) => a.time - b.time || a.index - b.index)
    .map(({ update }) => update)
}

/**
 * Folds the updates into the incident's current state. `declaredImpact` is the incident-level
 * impact used when no update names a component (legacy incidents and page-wide notices).
 */
export function deriveIncidentState(
  updates: readonly TimelineUpdate[],
  declaredImpact: ComponentImpact = 'operational',
): IncidentState {
  const current = new Map<string, TimelineComponentImpact>()
  let status: IncidentStatus = 'investigating'
  let resolvedAt: string | null = null

  for (const update of sortUpdates(updates)) {
    status = update.status
    for (const row of update.components ?? []) {
      current.set(relKey(row.monitor), { monitor: row.monitor, impact: row.impact })
    }
    if (update.status === 'resolved') {
      for (const row of current.values()) row.impact = 'operational'
      resolvedAt = update.postedAt
    } else {
      resolvedAt = null
    }
  }

  const components = [...current.values()]
  const active = status !== 'resolved'
  const impact = !active
    ? 'operational'
    : components.length > 0
      ? worstImpact(components.map((c) => c.impact))
      : declaredImpact
  return { status, impact, active, components, resolvedAt }
}

/** The latest update (by `postedAt`), or undefined for an empty list. */
export const latestUpdate = <T extends Pick<TimelineUpdate, 'postedAt'>>(
  updates: readonly T[],
): T | undefined => sortUpdates(updates).at(-1)

/**
 * The single update that represents an incident written before the timeline existed: its `content`,
 * posted when it was created (or when it was resolved, so `resolvedAt` survives).
 */
export function legacyUpdate(incident: {
  content?: string | null
  active?: boolean | null
  createdAt?: string | null
  resolvedAt?: string | null
  updatedAt?: string | null
}): TimelineUpdate {
  const resolved = incident.active === false
  const postedAt =
    (resolved ? (incident.resolvedAt ?? incident.updatedAt) : incident.createdAt) ??
    incident.createdAt ??
    new Date().toISOString()
  return {
    status: resolved ? 'resolved' : 'investigating',
    message: incident.content ?? '',
    postedAt,
    components: [],
  }
}

/** The stored shape this module reads (a subset of the `incidents` document). */
export interface IncidentLike {
  updates?:
    | {
        id?: string | null
        status: IncidentStatus
        message?: string | null
        postedAt: string
        editedAt?: string | null
        components?:
          { monitor?: RelationId | { id: RelationId } | null; impact: ComponentImpact }[] | null
      }[]
    | null
  impact?: ComponentImpact | null
  style?: string | null
  content?: string | null
  active?: boolean | null
  createdAt?: string | null
  updatedAt?: string | null
  resolvedAt?: string | null
}

const toRelationId = (value: RelationId | { id: RelationId }): RelationId =>
  typeof value === 'object' && value !== null ? value.id : value

/**
 * The incident's updates (oldest first) and derived state, for documents written before or after
 * the timeline existed: a legacy incident without updates reads as its single `legacyUpdate`.
 */
export function incidentTimeline(incident: IncidentLike): {
  updates: TimelineUpdate[]
  state: IncidentState
} {
  const stored = incident.updates ?? []
  if (stored.length === 0) {
    const update = { ...legacyUpdate(incident), id: 'legacy' }
    const declared = incident.impact ?? impactFromLegacyStyle(incident.style)
    return { updates: [update], state: deriveIncidentState([update], declared) }
  }
  const updates = sortUpdates(
    stored.map((row): TimelineUpdate => ({
      id: row.id ?? null,
      status: row.status,
      message: row.message ?? '',
      postedAt: row.postedAt,
      editedAt: row.editedAt ?? null,
      // A deleted monitor leaves a null reference behind; it no longer affects anything.
      components: (row.components ?? []).flatMap((c) =>
        c.monitor === null || c.monitor === undefined
          ? []
          : [{ monitor: toRelationId(c.monitor), impact: c.impact }],
      ),
    })),
  )
  return { updates, state: deriveIncidentState(updates, incident.impact ?? 'operational') }
}
