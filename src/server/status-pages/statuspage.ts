/**
 * Statuspage-compatible JSON (the public Atlassian Statuspage v2 API: `summary.json`, `status.json`,
 * `components.json`, `incidents.json`, `scheduled-maintenances.json`), so dashboards, aggregators and
 * client libraries written for Statuspage can read a Marmot page unchanged. Field names and enum values
 * follow https://metastatuspage.com/api/v2/ (documented in docs/Status-Pages.md):
 *
 * - components: page groups become `group: true` components listing their children; rows become
 *   components with `group_id`. Status is the worst of the monitor state and active incident impact
 *   (`operational`, `degraded_performance`, `partial_outage`, `major_outage`, `under_maintenance`).
 * - incidents: one per Marmot incident; every timeline update becomes an `incident_updates` entry with
 *   `affected_components` (old → new status). `impact` is the peak impact (`none`, `minor`, `major`,
 *   `critical`).
 * - scheduled maintenances: one per maintenance window (`scheduled`, `in_progress`, `completed`).
 *
 * Bodies contain no "now" timestamps so their `ETag`s stay stable while nothing changes.
 */
import type { Payload } from 'payload'

import { getTranslator } from '@/i18n/translator'
import type { Locale } from '@/i18n/locales'
import { statusPageTimeZone } from '@/i18n/resolve'
import {
  COMPONENT_IMPACTS,
  incidentTimeline,
  type ComponentImpact,
  type IncidentStatus,
} from '@/lib/incident-timeline'
import type { Incident, StatusPage } from '@/payload-types'

import { findFeedIncidents, statusSince } from './feed'
import {
  announcedMaintenance,
  listMaintenanceEvents,
  type MaintenanceEvent,
} from './maintenance-events'
import {
  buildPublicGroups,
  componentNamesOf,
  findActiveIncidents,
  type PublicGroup,
  type PublicMonitor,
} from './public'
import type { StatusPageLinks } from './urls'

export type SpComponentStatus = ComponentImpact | 'under_maintenance'
export type SpIndicator = 'none' | 'minor' | 'major' | 'critical'
export type SpIncidentStatus = IncidentStatus | 'postmortem'
export type SpMaintenanceStatus = 'scheduled' | 'in_progress' | 'verifying' | 'completed'

export interface SpPage {
  id: string
  name: string
  url: string
  time_zone: string
  updated_at: string
}

export interface SpStatus {
  indicator: SpIndicator
  description: string
}

export interface SpComponent {
  id: string
  name: string
  status: SpComponentStatus
  created_at: string
  updated_at: string
  position: number
  description: string | null
  showcase: boolean
  start_date: string | null
  group_id: string | null
  page_id: string
  group: boolean
  only_show_if_degraded: boolean
  /** Child component ids (groups only). */
  components?: string[]
}

export interface SpAffectedComponent {
  code: string
  name: string
  old_status: SpComponentStatus
  new_status: SpComponentStatus
}

export interface SpIncidentUpdate {
  id: string
  status: SpIncidentStatus | SpMaintenanceStatus
  body: string
  incident_id: string
  created_at: string
  updated_at: string
  display_at: string
  affected_components: SpAffectedComponent[] | null
  deliver_notifications: boolean
  custom_tweet: null
  tweet_id: null
}

export interface SpIncident {
  id: string
  name: string
  status: SpIncidentStatus
  created_at: string
  updated_at: string
  monitoring_at: string | null
  resolved_at: string | null
  impact: SpIndicator
  shortlink: string
  started_at: string
  page_id: string
  incident_updates: SpIncidentUpdate[]
  components: SpComponent[]
}

export interface SpScheduledMaintenance extends Omit<
  SpIncident,
  'status' | 'impact' | 'incident_updates'
> {
  status: SpMaintenanceStatus
  impact: 'maintenance'
  incident_updates: SpIncidentUpdate[]
  scheduled_for: string
  scheduled_until: string | null
}

export interface SpSummary {
  page: SpPage
  components: SpComponent[]
  incidents: SpIncident[]
  scheduled_maintenances: SpScheduledMaintenance[]
  status: SpStatus
}

// ---------------------------------------------------------------------------------------------
// Mapping

const STATUS_RANK: Record<SpComponentStatus, number> = {
  operational: 0,
  under_maintenance: 1,
  degraded_performance: 2,
  partial_outage: 3,
  major_outage: 4,
}

const worstStatus = (statuses: readonly SpComponentStatus[]): SpComponentStatus =>
  statuses.reduce<SpComponentStatus>(
    (worst, s) => (STATUS_RANK[s] > STATUS_RANK[worst] ? s : worst),
    'operational',
  )

/** Statuspage status of a component: the worse of its monitor state and incident impact. */
export function componentStatus(row: Pick<PublicMonitor, 'status' | 'impact'>): SpComponentStatus {
  const impact = row.impact && row.impact !== 'operational' ? row.impact : null
  const fromMonitor: SpComponentStatus | null =
    row.status === 'down'
      ? 'major_outage'
      : row.status === 'pending'
        ? 'degraded_performance'
        : row.status === 'maintenance'
          ? 'under_maintenance'
          : null
  if (impact) return worstStatus([impact, ...(fromMonitor ? [fromMonitor] : [])])
  return fromMonitor ?? 'operational'
}

const IMPACT_INDICATOR: Record<ComponentImpact, SpIndicator> = {
  operational: 'none',
  degraded_performance: 'minor',
  partial_outage: 'major',
  major_outage: 'critical',
}
const INDICATOR_RANK: Record<SpIndicator, number> = { none: 0, minor: 1, major: 2, critical: 3 }
const worstIndicator = (indicators: readonly SpIndicator[]): SpIndicator =>
  indicators.reduce<SpIndicator>(
    (worst, i) => (INDICATOR_RANK[i] > INDICATOR_RANK[worst] ? i : worst),
    'none',
  )

export const impactIndicator = (impact: ComponentImpact): SpIndicator => IMPACT_INDICATOR[impact]

const latestIso = (...values: (string | null | undefined)[]): string => {
  let best = ''
  for (const value of values) if (value && value > best) best = value
  return best
}

const iso = (value: string): string => {
  const time = Date.parse(value)
  return Number.isNaN(time) ? value : new Date(time).toISOString()
}

export interface StatuspageContext {
  page: StatusPage
  links: StatusPageLinks
  locale: Locale
  groups: PublicGroup[]
  components: SpComponent[]
  /** Visible component id → name. */
  names: Map<string, string>
}

/** Flattens the page groups into Statuspage components (groups first, then their children). */
export function toSpComponents(page: StatusPage, groups: readonly PublicGroup[]): SpComponent[] {
  const pageId = String(page.id)
  const created = iso(page.createdAt)
  const pageUpdated = iso(page.updatedAt)
  const out: SpComponent[] = []
  let position = 1
  groups.forEach((group, index) => {
    const groupId = String(page.groups?.[index]?.id ?? `group-${index}`)
    const children: SpComponent[] = group.monitors.map((row) => {
      const latest = row.beats.at(-1)
      const since = latest ? statusSince(row.beats, latest.status) : null
      return {
        id: row.componentId ?? row.id,
        name: row.name,
        status: componentStatus(row),
        created_at: created,
        updated_at: since ? latestIso(pageUpdated, iso(since)) : pageUpdated,
        position: 0,
        description: row.description ?? null,
        showcase: true,
        start_date: null,
        group_id: groupId,
        page_id: pageId,
        group: false,
        only_show_if_degraded: false,
      }
    })
    out.push({
      id: groupId,
      name: group.name,
      status: worstStatus(children.map((c) => c.status)),
      created_at: created,
      updated_at: latestIso(pageUpdated, ...children.map((c) => c.updated_at)),
      position: position++,
      description: null,
      showcase: false,
      start_date: null,
      group_id: null,
      page_id: pageId,
      group: true,
      only_show_if_degraded: false,
      components: children.map((c) => c.id),
    })
    for (const child of children) out.push({ ...child, position: position++ })
  })
  return out
}

/** Peak impact over the incident's whole timeline (Statuspage keeps it after resolution). */
export function peakImpact(incident: Incident): ComponentImpact {
  const { updates } = incidentTimeline(incident)
  const impacts = updates.flatMap((u) => (u.components ?? []).map((c) => c.impact))
  if (impacts.length === 0) {
    impacts.push(incident.impact ?? 'operational')
  }
  let worst: ComponentImpact = 'operational'
  for (const impact of impacts) {
    if (COMPONENT_IMPACTS.indexOf(impact) > COMPONENT_IMPACTS.indexOf(worst)) worst = impact
  }
  return worst
}

export function toSpIncident(incident: Incident, ctx: StatuspageContext): SpIncident {
  const { updates, state } = incidentTimeline(incident)
  const incidentId = String(incident.id)
  const current = new Map<string, ComponentImpact>()
  const spUpdates: SpIncidentUpdate[] = updates.map((update, index) => {
    const changes: SpAffectedComponent[] = []
    const touch = (component: string, next: ComponentImpact) => {
      const name = ctx.names.get(component)
      const previous = current.get(component) ?? 'operational'
      current.set(component, next)
      if (name === undefined) return
      changes.push({ code: component, name, old_status: previous, new_status: next })
    }
    for (const row of update.components ?? []) touch(row.component, row.impact)
    if (update.status === 'resolved') {
      for (const component of [...current.keys()]) {
        if (current.get(component) !== 'operational') touch(component, 'operational')
      }
    }
    const postedAt = iso(update.postedAt)
    return {
      id: update.id ? String(update.id) : `${incidentId}-${index}`,
      status: update.status,
      body: update.message ?? '',
      incident_id: incidentId,
      created_at: postedAt,
      updated_at: update.editedAt ? iso(update.editedAt) : postedAt,
      display_at: postedAt,
      affected_components: changes.length > 0 ? changes : null,
      deliver_notifications: true,
      custom_tweet: null,
      tweet_id: null,
    }
  })

  const byId = new Map(ctx.components.map((c) => [c.id, c]))
  const startedAt = updates[0]?.postedAt ?? incident.createdAt
  return {
    id: incidentId,
    name: incident.title,
    status: state.status,
    created_at: iso(incident.createdAt),
    updated_at: iso(incident.updatedAt),
    monitoring_at: (() => {
      const monitoring = updates.find((u) => u.status === 'monitoring')
      return monitoring ? iso(monitoring.postedAt) : null
    })(),
    resolved_at: state.resolvedAt ? iso(state.resolvedAt) : null,
    impact: impactIndicator(peakImpact(incident)),
    shortlink: ctx.links.incident(incidentId),
    started_at: iso(startedAt),
    page_id: String(ctx.page.id),
    incident_updates: spUpdates.reverse(),
    components: state.components.flatMap((c) => {
      const component = byId.get(c.component)
      return component ? [component] : []
    }),
  }
}

const MAINTENANCE_STATUS: Record<MaintenanceEvent['status'], SpMaintenanceStatus> = {
  scheduled: 'scheduled',
  in_progress: 'in_progress',
  completed: 'completed',
  cancelled: 'completed',
}

export function toSpMaintenance(
  event: MaintenanceEvent,
  ctx: StatuspageContext,
): SpScheduledMaintenance {
  const t = getTranslator(ctx.locale)
  const monitors = new Set(event.monitorIds)
  const status = MAINTENANCE_STATUS[event.status]
  // Manual maintenance has no window: it runs from its last change until switched off.
  const start = iso(event.start ?? event.updatedAt)
  const end = event.end ? iso(event.end) : null
  const childIds = new Set(
    ctx.groups.flatMap((g) =>
      g.monitors
        .filter((m) => m.type === 'monitor' && monitors.has(m.id))
        .map((m) => m.componentId ?? m.id),
    ),
  )
  return {
    id: event.id,
    name: event.title,
    status,
    created_at: iso(event.createdAt),
    updated_at: iso(event.updatedAt),
    monitoring_at: null,
    resolved_at: status === 'completed' ? end : null,
    impact: 'maintenance',
    shortlink: ctx.links.page,
    started_at: start,
    page_id: String(ctx.page.id),
    incident_updates: [
      {
        id: `${event.id}-update`,
        status,
        body: event.description ?? t('statusPages.machine.maintenanceBody', { title: event.title }),
        incident_id: event.id,
        created_at: iso(event.updatedAt),
        updated_at: iso(event.updatedAt),
        display_at: start,
        affected_components: null,
        deliver_notifications: true,
        custom_tweet: null,
        tweet_id: null,
      },
    ],
    components: ctx.components.filter((c) => childIds.has(c.id)),
    scheduled_for: start,
    scheduled_until: end,
  }
}

/**
 * Page indicator: the worst active incident impact, and from components `minor` for degraded
 * performance, `major` for partial outages or some components down, `critical` when all are down.
 */
export function pageStatus(
  components: readonly SpComponent[],
  activeImpacts: readonly ComponentImpact[],
  locale: Locale,
  maintenanceInProgress: boolean,
): SpStatus {
  const t = getTranslator(locale)
  const rows = components.filter((c) => !c.group)
  const counted = rows.filter((c) => c.status !== 'under_maintenance')
  const down = counted.filter((c) => c.status === 'major_outage').length
  const fromComponents: SpIndicator =
    down > 0 && down === counted.length
      ? 'critical'
      : down > 0 || counted.some((c) => c.status === 'partial_outage')
        ? 'major'
        : counted.some((c) => c.status === 'degraded_performance')
          ? 'minor'
          : 'none'
  const indicator = worstIndicator([fromComponents, ...activeImpacts.map(impactIndicator)])
  const underMaintenance =
    maintenanceInProgress || rows.some((c) => c.status === 'under_maintenance')
  return {
    indicator,
    description:
      indicator === 'none' && underMaintenance
        ? t('statusPages.machine.indicator.maintenance')
        : t(`statusPages.machine.indicator.${indicator}`),
  }
}

// ---------------------------------------------------------------------------------------------
// Endpoints

export interface StatuspageInput {
  payload: Payload
  page: StatusPage
  links: StatusPageLinks
  locale: Locale
  now?: Date
}

async function loadContext(
  { payload, page, links, locale }: StatuspageInput,
  activeIncidents: Incident[],
): Promise<StatuspageContext> {
  const groups = await buildPublicGroups(payload, page, { incidents: activeIncidents })
  return {
    page,
    links,
    locale,
    groups,
    components: toSpComponents(page, groups),
    names: componentNamesOf(groups),
  }
}

const spPage = (ctx: StatuspageContext, ...changes: (string | null | undefined)[]): SpPage => ({
  id: String(ctx.page.id),
  name: ctx.page.title,
  url: ctx.links.page,
  time_zone: statusPageTimeZone(ctx.page),
  updated_at: latestIso(iso(ctx.page.updatedAt), ...changes.map((c) => (c ? iso(c) : c))),
})

export async function buildSummary(input: StatuspageInput): Promise<SpSummary> {
  const now = input.now ?? new Date()
  const [active, events] = await Promise.all([
    findActiveIncidents(input.payload, input.page.id),
    listMaintenanceEvents(input.payload, input.page.id, { now }),
  ])
  const ctx = await loadContext(input, active)
  const incidents = active.map((incident) => toSpIncident(incident, ctx))
  const announced = announcedMaintenance(events, now)
  const activeImpacts = active.map((incident) => incidentTimeline(incident).state.impact)
  return {
    page: spPage(
      ctx,
      ...active.map((i) => i.updatedAt),
      ...announced.map((m) => m.updatedAt),
      ...ctx.components.map((c) => c.updated_at),
    ),
    components: ctx.components,
    incidents,
    scheduled_maintenances: announced.map((event) => toSpMaintenance(event, ctx)),
    status: pageStatus(
      ctx.components,
      activeImpacts,
      input.locale,
      announced.some((m) => m.status === 'in_progress'),
    ),
  }
}

export async function buildStatus(
  input: StatuspageInput,
): Promise<Pick<SpSummary, 'page' | 'status'>> {
  const summary = await buildSummary(input)
  return { page: summary.page, status: summary.status }
}

export async function buildComponents(
  input: StatuspageInput,
): Promise<Pick<SpSummary, 'page' | 'components'>> {
  const active = await findActiveIncidents(input.payload, input.page.id)
  const ctx = await loadContext(input, active)
  return {
    page: spPage(ctx, ...ctx.components.map((c) => c.updated_at)),
    components: ctx.components,
  }
}

/** The 50 most recent incidents, unresolved and resolved. */
export async function buildIncidents(
  input: StatuspageInput,
): Promise<{ page: SpPage; incidents: SpIncident[] }> {
  const [active, recent] = await Promise.all([
    findActiveIncidents(input.payload, input.page.id),
    findFeedIncidents(input.payload, input.page.id, 50),
  ])
  const ctx = await loadContext(input, active)
  return {
    page: spPage(ctx, ...recent.map((i) => i.updatedAt)),
    incidents: recent.map((incident) => toSpIncident(incident, ctx)),
  }
}

/** Maintenance windows of the last 30 and next 90 days, newest first. */
export async function buildScheduledMaintenances(
  input: StatuspageInput,
): Promise<{ page: SpPage; scheduled_maintenances: SpScheduledMaintenance[] }> {
  const now = input.now ?? new Date()
  const [active, events] = await Promise.all([
    findActiveIncidents(input.payload, input.page.id),
    listMaintenanceEvents(input.payload, input.page.id, { now }),
  ])
  const ctx = await loadContext(input, active)
  return {
    page: spPage(ctx, ...events.map((m) => m.updatedAt)),
    scheduled_maintenances: events
      .slice()
      .reverse()
      .map((event) => toSpMaintenance(event, ctx)),
  }
}
