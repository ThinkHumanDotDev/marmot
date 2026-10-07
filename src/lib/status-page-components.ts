/**
 * Status page components (issue #106): the rows of a status page group. Shared by the collections,
 * the public payload builder and the client views, so it imports nothing server-only.
 *
 * Model (documented in docs/Status-Pages.md → Components):
 * - A component is a row of `status-pages.groups[].monitors[]`. The array keeps its historical name
 *   so existing pages need no data migration; every row is a component.
 * - `type: 'monitor'` (default) mirrors a monitor; `type: 'static'` has no monitor and its status
 *   comes only from active incidents (`incidents.affectedComponents`) and running maintenance.
 * - A component's stable identifier is the array row `id` (a string on every database adapter).
 *   Incidents reference components by that id, so editors must send row ids back when saving.
 */

export const COMPONENT_TYPES = ['monitor', 'static'] as const
export type ComponentType = (typeof COMPONENT_TYPES)[number]

/** Impact an incident has on a component, least to most severe (Atlassian Statuspage vocabulary). */
export const COMPONENT_IMPACTS = [
  'operational',
  'degraded_performance',
  'partial_outage',
  'major_outage',
] as const
export type ComponentImpact = (typeof COMPONENT_IMPACTS)[number]

/** Same vocabulary as `HEARTBEAT_STATUSES` plus `unknown` (never checked / no data). */
export type ComponentStatus = 'up' | 'down' | 'pending' | 'maintenance' | 'degraded' | 'unknown'

const impactRank = (impact: ComponentImpact): number => COMPONENT_IMPACTS.indexOf(impact)

/** The most severe impact, or null when there is none. */
export function worstImpact(
  impacts: readonly (ComponentImpact | null | undefined)[],
): ComponentImpact | null {
  let worst: ComponentImpact | null = null
  for (const impact of impacts) {
    if (!impact || !COMPONENT_IMPACTS.includes(impact)) continue
    if (worst === null || impactRank(impact) > impactRank(worst)) worst = impact
  }
  return worst
}

/**
 * Dot colour of an impact: major outage → down, partial outage → pending (amber), degraded
 * performance → degraded (the monitor state of the same name), else up.
 */
export function impactToStatus(
  impact: ComponentImpact | null,
): 'up' | 'degraded' | 'pending' | 'down' {
  if (impact === 'major_outage') return 'down'
  if (impact === 'partial_outage') return 'pending'
  if (impact === 'degraded_performance') return 'degraded'
  return 'up'
}

/**
 * Impact a component shows: the worst impact of the active incidents naming it, raised to
 * `degraded_performance` while its monitor is degraded (#93). One rule for the page, the overall
 * state and the badge, so a slow monitor reads as "Degraded performance" everywhere.
 */
export function effectiveImpact(
  status: ComponentStatus,
  impact: ComponentImpact | null | undefined,
): ComponentImpact | null {
  return worstImpact([impact, status === 'degraded' ? 'degraded_performance' : null])
}

/**
 * Status of a static component: incident impact first (an outage beats a maintenance window), then
 * running maintenance attached to the page, otherwise operational.
 */
export function staticComponentStatus(
  impact: ComponentImpact | null,
  underMaintenance: boolean,
): ComponentStatus {
  if (impact && impact !== 'operational') return impactToStatus(impact)
  if (underMaintenance) return 'maintenance'
  return 'up'
}

const STATUS_SEVERITY: Record<ComponentStatus, number> = {
  unknown: 0,
  up: 1,
  maintenance: 2,
  degraded: 3,
  pending: 4,
  down: 5,
}

/**
 * Worst status of a set (the collapsed group header):
 * down > pending > degraded > maintenance > up > unknown.
 */
export function worstStatus(statuses: readonly ComponentStatus[]): ComponentStatus {
  let worst: ComponentStatus = 'unknown'
  for (const status of statuses) {
    if ((STATUS_SEVERITY[status] ?? 0) > STATUS_SEVERITY[worst]) worst = status
  }
  return worst
}

/** Public name of a component: its own override, then the monitor's public name, then its name. */
export function componentDisplayName(
  override: string | null | undefined,
  monitor?: { name?: string | null; publicName?: string | null } | null,
): string {
  return override?.trim() || monitor?.publicName?.trim() || monitor?.name?.trim() || ''
}

/** `http(s)://…` with a host. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0
  } catch {
    return false
  }
}

/** Header contact link: an http(s) URL or `mailto:address`. */
export function isContactUrl(value: string): boolean {
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(value)) return true
  return isHttpUrl(value)
}
