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
 *
 * Components are status page components (`src/lib/status-page-components.ts`), referenced by their
 * stable id (the group row id), with the same impact vocabulary.
 */
import {
  COMPONENT_IMPACTS,
  worstImpact as worstOf,
  type ComponentImpact,
} from '@/lib/status-page-components'

export { COMPONENT_IMPACTS, type ComponentImpact }

export const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number]

/** Legacy card colours of incidents created before the timeline existed. */
export const LEGACY_INCIDENT_STYLES = ['info', 'warning', 'danger', 'primary'] as const
export type LegacyIncidentStyle = (typeof LEGACY_INCIDENT_STYLES)[number]

export interface TimelineComponentImpact {
  /** Component id: the row id in `status-pages.groups[].monitors[]`. */
  component: string
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

export const isIncidentStatus = (value: unknown): value is IncidentStatus =>
  typeof value === 'string' && (INCIDENT_STATUSES as readonly string[]).includes(value)

export const isComponentImpact = (value: unknown): value is ComponentImpact =>
  typeof value === 'string' && (COMPONENT_IMPACTS as readonly string[]).includes(value)

/** The worst of `impacts` (`operational` for an empty list). */
export const worstImpact = (impacts: readonly ComponentImpact[]): ComponentImpact =>
  worstOf(impacts) ?? 'operational'

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
      current.set(row.component, { component: row.component, impact: row.impact })
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

type StoredImpactRow = { component?: string | null; impact?: ComponentImpact | null }

const toImpactRows = (rows: readonly StoredImpactRow[] | null | undefined) =>
  (rows ?? []).flatMap((row) =>
    row?.component && row.impact ? [{ component: String(row.component), impact: row.impact }] : [],
  )

/**
 * The single update that represents an incident written before the timeline existed: its `content`
 * and `affectedComponents`, posted when it was created (or when it was resolved, so `resolvedAt`
 * survives).
 */
export function legacyUpdate(incident: {
  content?: string | null
  affectedComponents?: readonly StoredImpactRow[] | null
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
    components: resolved ? [] : toImpactRows(incident.affectedComponents),
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
        components?: StoredImpactRow[] | null
      }[]
    | null
  affectedComponents?: StoredImpactRow[] | null
  impact?: ComponentImpact | null
  style?: string | null
  content?: string | null
  active?: boolean | null
  createdAt?: string | null
  updatedAt?: string | null
  resolvedAt?: string | null
}

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
      components: toImpactRows(row.components),
    })),
  )
  return { updates, state: deriveIncidentState(updates, incident.impact ?? 'operational') }
}
