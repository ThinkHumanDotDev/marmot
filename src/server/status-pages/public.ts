/**
 * Public status page data: what `GET /api/status-pages/:slug/public`, the SSR page and the RSS feed
 * share. Everything here runs server side with `overrideAccess: true` and strips internal fields
 * (organization, ids of other collections, domains) before anything leaves the process.
 *
 * `overallStatus` / `statusDescription` are ported from Uptime Kuma's
 * `server/model/status_page.js` (MIT, see THIRD_PARTY_NOTICES.md).
 */
import type { Payload } from 'payload'

import type { HEARTBEAT_STATUSES } from '@/collections/Heartbeats'
import type { StatusPageTheme, StatusPageTimeZoneMode } from '@/collections/StatusPages'
import type { Locale } from '@/i18n/locales'
import { statusPageTimeZone } from '@/i18n/resolve'
import { DEFAULT_PAST_INCIDENTS_DAYS, MAX_PAST_INCIDENTS_DAYS } from '@/lib/status-page-events'
import {
  followsVisitorTimeZone,
  offeredLocales,
  pageDefaultLocale,
} from '@/lib/status-page-locales'
import { getThemePreset } from '@/lib/status-page-themes'
import { offeredChannels, type SubscriberChannel } from '@/lib/status-page-subscribers'
import {
  incidentTimeline,
  legacyStyleFromImpact,
  type IncidentStatus,
  type LegacyIncidentStyle,
} from '@/lib/incident-timeline'
import {
  componentDisplayName,
  effectiveImpact,
  staticComponentStatus,
  worstImpact,
  worstStatus,
  type ComponentImpact,
  type ComponentType,
} from '@/lib/status-page-components'
import {
  getActiveMaintenanceForStatusPage,
  type PublicMaintenance,
} from '@/server/maintenance/status-page'
import { populateMonitorTags, toRealtimeTags } from '@/server/realtime/serialize'
import {
  isAudiencePage,
  lockAudiencePage,
  visibleIncidents,
  type AudienceScopedPage,
} from '@/server/status-pages/audiences'
import { pastIncidentDays, type PublicIncidentDay } from '@/server/status-pages/event-summary'
import { publicIdOf } from '@/server/status-pages/public-ids'
import { getUptime } from '@/server/stats/uptime-calculator'
import {
  componentMode,
  loadPageUptime,
  pageUptimeMode,
  type ComponentUptime,
  type UptimeComponent,
} from '@/server/status-pages/uptime-history'
import {
  dayLabel,
  downtimeOf,
  uptimeBarDaysOf,
  uptimeOf,
  windowDays,
  type DayState,
  type UptimeBarDays,
  type UptimeCalculationMode,
} from '@/lib/uptime-history'

import type { Incident, Media, Monitor, StatusPage } from '@/payload-types'

export type BeatStatus = (typeof HEARTBEAT_STATUSES)[number]
export type MonitorPublicStatus = BeatStatus | 'unknown'
export type OverallStatus = 'up' | 'degraded' | 'partial' | 'down' | 'maintenance' | 'unknown'

export const BEATS_PER_MONITOR = 50

export interface PublicBeat {
  status: BeatStatus
  /** ISO timestamp. */
  time: string
  /** Response time in ms; absent when the component hides its values. */
  ping?: number | null
}

/**
 * One row of a group: a monitor or a static component (see `src/lib/status-page-components.ts`).
 * The interface keeps its historical name; `PublicComponent` is the same type.
 */
export interface PublicMonitor {
  /** Monitor id for `monitor` components (unchanged from before components), component id otherwise. */
  id: string
  /** Stable component id (the group row id); incidents reference components by it. */
  componentId: string | null
  type: ComponentType
  /** Public display name: component override → monitor `publicName` → monitor name. */
  name: string
  /** Shown as a tooltip. */
  description?: string
  /** Link shown to visitors (custom URL, or the monitor's URL when `sendUrl` is on). */
  url?: string
  status: MonitorPublicStatus
  /** Worst impact of the active incidents affecting this component, or null. */
  impact: ComponentImpact | null
  /** False when the page or the component hides uptime and response times. */
  showValues: boolean
  /** 0..1; only present when `showValues`. */
  uptime24h?: number
  /** 0..1; only present when `showValues`. */
  uptime30d?: number
  /** Oldest first, at most `BEATS_PER_MONITOR`; always empty for static components. */
  beats: PublicBeat[]
  /**
   * Daily bars, oldest first: `config.uptimeBarDays` of them on the page payload (#112); empty
   * where the bars are not built (badges, feeds).
   */
  days: PublicUptimeDay[]
  /**
   * Uptime (0..1) over the bars' window under the page's calculation mode, null without data; only
   * with `showValues` and `showUptimePercentage`.
   */
  uptime?: number | null
  tags?: { name: string; color?: string | null; value?: string | null }[]
  /**
   * A third-party status page monitor (#125): shown like a static component, its state written out
   * ("Major outage") instead of a beat bar, since it mirrors what the vendor reports.
   */
  vendor?: boolean
}

export type PublicComponent = PublicMonitor

/** One daily bar of a component (#112): a UTC day. */
export interface PublicUptimeDay {
  /** `YYYY-MM-DD` (UTC). */
  date: string
  /** Worst state of the day; `nodata` when nothing was recorded. */
  state: DayState
  /** 0..1 under the page's calculation mode; only with `showValues` and `showUptimePercentage`. */
  uptime?: number | null
  /** Seconds down (incident downtime in `manual` mode); only with `showValues`. */
  downtimeSeconds?: number | null
  /** Incidents of the day affecting the component (or the whole page); `id` is the permalink id. */
  incidents: { id: string; title: string; impact: ComponentImpact | null }[]
  /** Maintenance windows of the day covering the component; `id` is the permalink id. */
  maintenance: { id: string; title: string }[]
}

export interface PublicGroup {
  name: string
  /** Expanded on load; collapsed groups show `status` in their header. */
  defaultOpen: boolean
  /** Worst status of the group's components. */
  status: MonitorPublicStatus
  monitors: PublicMonitor[]
}

/** A status page component named by an incident (only components visible on the page). */
export interface PublicIncidentComponent {
  /** Component id, as in `groups[].monitors[].componentId`. */
  id: string
  name: string
  impact: ComponentImpact
}

export interface PublicIncidentUpdate {
  id: string
  status: IncidentStatus
  /** Markdown. */
  message: string
  postedAt: string
  /** Set when the text was edited after posting. */
  editedAt: string | null
  /** Impacts this update set (components it left out keep their previous impact). */
  components: PublicIncidentComponent[]
}

export interface PublicIncident {
  id: string
  /** Short id of the permalink (`<page>/events/incident/<publicId>`). */
  publicId: string
  title: string
  /** Status of the latest update. */
  status: IncidentStatus
  /** Worst current impact (the incident's indicator). */
  impact: ComponentImpact
  /** Current impact per affected component. */
  components: PublicIncidentComponent[]
  /** Timeline, newest first. */
  updates: PublicIncidentUpdate[]
  /** Latest update's message (kept for clients of the pre-timeline payload). */
  content: string
  /** Card colour derived from `impact` (kept for clients of the pre-timeline payload). */
  style: LegacyIncidentStyle
  pinned: boolean
  active: boolean
  /** When the first update was posted (the start of the incident). */
  startedAt: string
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
}

export interface PublicConfig {
  slug: string
  title: string
  description: string | null
  /** Logo for light mode (and dark mode when `logoDark` is null). */
  logo: string | null
  /** Logo for dark mode. */
  logoDark: string | null
  /** Favicon URL; the page falls back to `logo`. */
  favicon: string | null
  /** Where the logo and title link to. */
  homepageUrl: string | null
  /** Header contact link (http(s) or mailto:). */
  contactUrl: string | null
  theme: StatusPageTheme
  /** Theme preset id (`src/lib/status-page-themes/presets`). */
  themePreset: string
  /** Custom headline that replaces the automatic overall-status text. */
  bannerText: string | null
  /** Language of the page's plain URL (#114). */
  defaultLocale: Locale
  /** Languages the page offers, default first; the others live under `/<locale>`. */
  locales: Locale[]
  /** `visitor`: times follow the visitor's browser zone; `page`: always `timeZone`. */
  timeZoneMode: StatusPageTimeZoneMode
  /** The page's own IANA time zone (its setting, else the organization's). */
  timeZone: string
  published: boolean
  showTags: boolean
  showCertificateExpiry: boolean
  showPoweredBy: boolean
  /** Page-wide switch for uptime percentages and response times. */
  showValues: boolean
  /** Daily bars per component (30, 45 or 90). */
  uptimeBarDays: UptimeBarDays
  /** How uptime percentages are calculated (`checks`, `duration` or `manual`). */
  uptimeCalculation: UptimeCalculationMode
  /** Show the uptime percentage next to the bars. */
  showUptimePercentage: boolean
  autoRefreshInterval: number
  customCSS: string | null
  footerText: string | null
  googleAnalyticsId: string | null
  /** Channels visitors may subscribe with (#104); empty when subscriptions are off. */
  subscriptionChannels: SubscriberChannel[]
}

export interface PublicStatusPageData {
  config: PublicConfig
  overall: OverallStatus
  groups: PublicGroup[]
  /** Active incidents, newest first (pinned ones first). */
  incidents: PublicIncident[]
  /**
   * Maintenance occurrences announced on this page with their update timelines: running first,
   * then upcoming, then those finished within `maintenanceVisibilityHours`.
   */
  maintenance: PublicMaintenance[]
  /** The page's `pastIncidentsDays` (0 when the list is off). */
  pastIncidentsDays: number
  /**
   * Incidents started in each of the last `pastIncidentsDays` days (in the organization's time
   * zone), newest day first; quiet days have no incidents.
   */
  pastIncidents: PublicIncidentDay[]
  /** ISO timestamp of when this payload was built. */
  generatedAt: string
}

const relId = (value: unknown): string | number | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

const mediaUrl = (media: StatusPage['logo']): string | null =>
  media && typeof media === 'object' ? ((media as Media).url ?? null) : null

/**
 * The published status page with `slug`, or null. An `audience` page (#151) comes back locked (no
 * groups) until `scopePageForVisitor` narrows it to the visitor's components.
 */
export async function findPublishedStatusPage(
  payload: Payload,
  slug: string,
): Promise<StatusPage | null> {
  const { docs } = await payload.find({
    collection: 'status-pages',
    where: { and: [{ slug: { equals: slug.toLowerCase() } }, { published: { equals: true } }] },
    depth: 1,
    limit: 1,
    pagination: false,
    overrideAccess: true,
  })
  return docs[0] ? lockAudiencePage(docs[0]) : null
}

/** The public subset of a status page's configuration. */
export function toPublicConfig(page: StatusPage): PublicConfig {
  return {
    slug: page.slug,
    title: page.title,
    description: page.description ?? null,
    logo: mediaUrl(page.logo),
    logoDark: mediaUrl(page.logoDark),
    favicon: mediaUrl(page.favicon),
    homepageUrl: page.homepageUrl ?? null,
    contactUrl: page.contactUrl ?? null,
    theme: page.theme ?? 'auto',
    themePreset: getThemePreset(page.themePreset).id,
    bannerText: page.bannerText?.trim() || null,
    defaultLocale: pageDefaultLocale(page),
    locales: offeredLocales(page),
    timeZoneMode: followsVisitorTimeZone(page) ? 'visitor' : 'page',
    timeZone: statusPageTimeZone(page),
    published: Boolean(page.published),
    showTags: Boolean(page.showTags),
    showCertificateExpiry: Boolean(page.showCertificateExpiry),
    showPoweredBy: page.showPoweredBy !== false,
    showValues: page.showValues !== false,
    uptimeBarDays: uptimeBarDaysOf(page.uptimeBarDays),
    uptimeCalculation: pageUptimeMode(page),
    showUptimePercentage: page.showUptimePercentage !== false,
    autoRefreshInterval: Math.max(0, page.autoRefreshInterval ?? 0),
    customCSS: page.customCSS ?? null,
    footerText: page.footerText ?? null,
    googleAnalyticsId: page.googleAnalyticsId ?? null,
    subscriptionChannels: offeredChannels(page.subscriptions),
  }
}

/**
 * Public view of an incident. `componentNames` maps component ids to the names shown on the page;
 * components that are not visible there (removed rows, paused monitors) are left out. With
 * `scoped` (audience pages, #151) the incident's impact is the worst of the visible components', so
 * it says nothing about components of other audiences.
 */
export function toPublicIncident(
  incident: Incident,
  componentNames: ReadonlyMap<string, string> = new Map(),
  { scoped = false }: { scoped?: boolean } = {},
): PublicIncident {
  const { updates, state } = incidentTimeline(incident)
  const visible = (rows: readonly { component: string; impact: ComponentImpact }[]) =>
    rows.flatMap((row) => {
      const name = componentNames.get(row.component)
      return name === undefined ? [] : [{ id: row.component, name, impact: row.impact }]
    })
  const newestFirst = updates.slice().reverse()
  const components = visible(state.components)
  const impact =
    scoped && state.components.length > 0
      ? (worstImpact(components.map((c) => c.impact)) ?? 'operational')
      : state.impact
  return {
    id: String(incident.id),
    publicId: publicIdOf('incidents', incident),
    title: incident.title,
    status: state.status,
    impact,
    components,
    updates: newestFirst.map((update, index) => ({
      id: update.id ? String(update.id) : `${incident.id}-${index}`,
      status: update.status,
      message: update.message ?? '',
      postedAt: update.postedAt,
      editedAt: update.editedAt ?? null,
      components: visible(update.components ?? []),
    })),
    content: newestFirst[0]?.message ?? '',
    style: legacyStyleFromImpact(impact),
    pinned: Boolean(incident.pinned),
    active: state.active,
    startedAt: updates[0]?.postedAt || incident.createdAt,
    createdAt: incident.createdAt,
    updatedAt: incident.updatedAt,
    resolvedAt: state.resolvedAt ?? incident.resolvedAt ?? null,
  }
}

/** Component id → public name of every component visible in `groups`. */
export const componentNamesOf = (groups: readonly PublicGroup[]): Map<string, string> =>
  new Map(
    groups.flatMap((group) =>
      group.monitors.flatMap((m) => (m.componentId ? [[m.componentId, m.name] as const] : [])),
    ),
  )

const OVERALL_RANK: Record<OverallStatus, number> = {
  unknown: 0,
  up: 1,
  maintenance: 2,
  degraded: 3,
  partial: 4,
  down: 5,
}

/**
 * Overall page state from component statuses *and* active incident impacts: a component with a
 * `major_outage` counts as down, one with a partial outage as not fully up and one with degraded
 * performance (an incident or its degraded monitor) as degraded (then `overallStatus` applies);
 * active incidents that name no component raise the page to `degraded`, `partial` or `down`.
 */
export function pageOverallStatus(
  groups: readonly PublicGroup[],
  incidents: readonly PublicIncident[],
): OverallStatus {
  const statuses = groups.flatMap((group) =>
    group.monitors.map((row): MonitorPublicStatus => {
      if (row.impact === 'major_outage') return 'down'
      const working = row.status === 'up' || row.status === 'degraded'
      if (row.impact === 'partial_outage' && working) return 'pending'
      if (effectiveImpact(row.status, row.impact) === 'degraded_performance' && working) {
        return 'degraded'
      }
      return row.status
    }),
  )
  let overall = overallStatus(statuses)
  for (const incident of incidents) {
    if (!incident.active || incident.impact === 'operational') continue
    if (incident.components.length > 0) continue
    const fromIncident: OverallStatus =
      incident.impact === 'major_outage'
        ? 'down'
        : incident.impact === 'degraded_performance'
          ? 'degraded'
          : 'partial'
    if (OVERALL_RANK[fromIncident] > OVERALL_RANK[overall]) overall = fromIncident
  }
  return overall
}

/**
 * Overall page state from the monitors' last statuses (Uptime Kuma `StatusPage.overallStatus`):
 * any monitor in maintenance → `maintenance`; all up → `up`; some up → `partial`; none up → `down`.
 * Degraded monitors (#93) count as up for that rule, and all up with at least one degraded is
 * `degraded` ("Degraded performance"). Monitors that were never checked are ignored; no checked
 * monitors → `unknown`.
 */
export function overallStatus(statuses: readonly MonitorPublicStatus[]): OverallStatus {
  const known = statuses.filter((s) => s !== 'unknown')
  if (known.length === 0) return 'unknown'
  if (known.includes('maintenance')) return 'maintenance'
  const ups = known.filter((s) => s === 'up' || s === 'degraded').length
  if (ups === known.length) return known.includes('degraded') ? 'degraded' : 'up'
  if (ups === 0) return 'down'
  return 'partial'
}

async function lastBeats(
  payload: Payload,
  monitorId: string | number,
  showValues: boolean,
): Promise<PublicBeat[]> {
  const { docs } = await payload.find({
    collection: 'heartbeats',
    where: { monitor: { equals: monitorId } },
    sort: '-time',
    limit: BEATS_PER_MONITOR,
    pagination: false,
    depth: 0,
    overrideAccess: true,
  })
  return docs
    .map((beat) =>
      showValues
        ? { status: beat.status, time: beat.time, ping: beat.ping ?? null }
        : { status: beat.status, time: beat.time },
    )
    .reverse()
}

type GroupRow = NonNullable<StatusPage['groups']>[number]
type MonitorRow = NonNullable<GroupRow['monitors']>[number]

const rowShowsValues = (page: StatusPage, row: MonitorRow): boolean =>
  page.showValues !== false && row.showValues !== false

/** Public bars and window uptime of a component (`uptime` only when the page shows it). */
function publicUptime(
  page: StatusPage,
  row: MonitorRow,
  type: ComponentType,
  uptime: ComponentUptime | undefined,
): Pick<PublicMonitor, 'days' | 'uptime'> {
  if (!uptime) return { days: [] }
  const showValues = rowShowsValues(page, row)
  const showPercentage = showValues && page.showUptimePercentage !== false
  const mode = componentMode(pageUptimeMode(page), type)
  const days = uptime.days.map((day): PublicUptimeDay => ({
    date: dayLabel(day.day),
    state: day.state,
    ...(showPercentage ? { uptime: day.hasData ? uptimeOf(mode, day.figures) : null } : {}),
    ...(showValues ? { downtimeSeconds: day.hasData ? downtimeOf(mode, day.figures) : null } : {}),
    incidents: day.incidents.map((incident) => ({
      id: incident.publicId,
      title: incident.title,
      impact: incident.impact,
    })),
    maintenance: day.maintenance.map((m) => ({ id: m.publicId, title: m.title })),
  }))
  return showPercentage ? { days, uptime: uptimeOf(mode, uptime.totals) } : { days }
}

async function toPublicMonitor(
  payload: Payload,
  page: StatusPage,
  row: MonitorRow,
  monitor: Monitor,
  impact: ComponentImpact | null,
  uptime: ComponentUptime | undefined,
): Promise<PublicMonitor> {
  const showValues = rowShowsValues(page, row)
  const showTags = Boolean(page.showTags)
  const [uptime24h, uptime30d, beats] = await Promise.all([
    showValues ? getUptime(payload, monitor.id, '24h') : undefined,
    showValues ? getUptime(payload, monitor.id, '30d') : undefined,
    lastBeats(payload, monitor.id, showValues),
  ])

  const url = row.customUrl?.trim() || (row.sendUrl ? monitor.url?.trim() : undefined) || undefined
  const description = row.description?.trim()
  // Public: name, colour and value only (no tag ids).
  const tags = showTags
    ? toRealtimeTags(monitor.tags).map(({ name, color, value }) => ({ name, color, value }))
    : []

  return {
    id: String(monitor.id),
    componentId: row.id ? String(row.id) : null,
    type: 'monitor',
    name: componentDisplayName(row.name, monitor),
    ...(description ? { description } : {}),
    ...(url ? { url } : {}),
    status: monitor.status?.lastStatus ?? 'unknown',
    impact,
    showValues,
    ...(showValues ? { uptime24h, uptime30d } : {}),
    beats,
    ...publicUptime(page, row, 'monitor', uptime),
    ...(showTags ? { tags } : {}),
    ...(monitor.type === 'status-page' ? { vendor: true } : {}),
  }
}

function toPublicStaticComponent(
  page: StatusPage,
  row: MonitorRow,
  fallbackId: string,
  impact: ComponentImpact | null,
  underMaintenance: boolean,
  uptime: ComponentUptime | undefined,
): PublicMonitor {
  const id = row.id ? String(row.id) : fallbackId
  const url = row.customUrl?.trim() || undefined
  const description = row.description?.trim()
  return {
    id,
    componentId: row.id ? String(row.id) : null,
    type: 'static',
    name: componentDisplayName(row.name),
    ...(description ? { description } : {}),
    ...(url ? { url } : {}),
    status: staticComponentStatus(impact, underMaintenance),
    impact,
    showValues: rowShowsValues(page, row),
    beats: [],
    ...publicUptime(page, row, 'static', uptime),
  }
}

/** Worst impact per component id over the active incidents. */
export function impactsByComponent(
  incidents: readonly Pick<Incident, 'active' | 'affectedComponents'>[],
): Map<string, ComponentImpact> {
  const out = new Map<string, ComponentImpact>()
  for (const incident of incidents) {
    if (incident.active === false) continue
    for (const row of incident.affectedComponents ?? []) {
      if (!row?.component) continue
      const key = String(row.component)
      const worst = worstImpact([out.get(key), row.impact])
      if (worst) out.set(key, worst)
    }
  }
  return out
}

export interface PublicGroupsContext {
  /** Active incidents of the page (fetched when omitted). */
  incidents?: Incident[]
  /** Maintenance of the page (fetched when omitted). */
  maintenance?: PublicMaintenance[]
  /** Build the daily uptime bars (#112); off for callers that only need statuses. */
  uptimeBars?: boolean
  /** Reference time of the bars (default now). */
  now?: Date
}

/**
 * Resolves every monitor referenced by the page in one query (active monitors only; paused or
 * deleted monitors are dropped from the public view) and builds the public groups. Static
 * components take their status from the active incidents' impacts and running maintenance.
 */
export async function buildPublicGroups(
  payload: Payload,
  page: StatusPage,
  context: PublicGroupsContext = {},
): Promise<PublicGroup[]> {
  const ids = new Set<string>()
  let hasStatic = false
  for (const group of page.groups ?? []) {
    for (const row of group.monitors ?? []) {
      if (row.type === 'static') {
        hasStatic = true
        continue
      }
      const id = relId(row.monitor)
      if (id !== null) ids.add(String(id))
    }
  }

  const [docs, incidents, maintenance] = await Promise.all([
    ids.size === 0
      ? Promise.resolve([] as Monitor[])
      : payload
          .find({
            collection: 'monitors',
            where: {
              and: [
                { id: { in: [...ids] } },
                { organization: { equals: relId(page.organization) } },
                { active: { equals: true } },
              ],
            },
            depth: 0,
            limit: ids.size,
            pagination: false,
            overrideAccess: true,
          })
          .then((result) => result.docs),
    context.incidents ?? findActiveIncidents(payload, page),
    context.maintenance ??
      (hasStatic ? getActiveMaintenanceForStatusPage(payload, page) : Promise.resolve([])),
  ])
  const monitors =
    page.showTags && docs.length > 0 ? await populateMonitorTags(payload, docs) : docs
  const byId = new Map(monitors.map((m) => [String(m.id), m]))
  const impacts = impactsByComponent(incidents)
  const underMaintenance = maintenance.some((m) => m.status === 'under-maintenance')
  const uptime = context.uptimeBars
    ? await loadPageUptime(payload, page, uptimeComponentsOf(page, byId), {
        now: context.now,
        days: windowDays(uptimeBarDaysOf(page.uptimeBarDays), context.now ?? new Date()),
      })
    : new Map<string, ComponentUptime>()

  const groups: PublicGroup[] = []
  for (const [groupIndex, group] of (page.groups ?? []).entries()) {
    const rows = await Promise.all(
      (group.monitors ?? []).flatMap((row, rowIndex): Promise<PublicMonitor>[] => {
        const impact = row.id ? (impacts.get(String(row.id)) ?? null) : null
        if (row.type === 'static') {
          return [
            Promise.resolve(
              toPublicStaticComponent(
                page,
                row,
                `static-${groupIndex}-${rowIndex}`,
                impact,
                underMaintenance,
                row.id ? uptime.get(String(row.id)) : undefined,
              ),
            ),
          ]
        }
        const monitor = byId.get(String(relId(row.monitor)))
        return monitor
          ? [
              toPublicMonitor(
                payload,
                page,
                row,
                monitor,
                impact,
                row.id ? uptime.get(String(row.id)) : undefined,
              ),
            ]
          : []
      }),
    )
    groups.push({
      name: group.name,
      defaultOpen: group.defaultOpen !== false,
      status: worstStatus(rows.map((row) => row.status)),
      monitors: rows,
    })
  }
  return groups
}

/** The page's components with a row id whose daily bars are built (visible ones only). */
function uptimeComponentsOf(
  page: StatusPage,
  monitors: ReadonlyMap<string, Monitor>,
): UptimeComponent[] {
  return (page.groups ?? []).flatMap((group) =>
    (group.monitors ?? []).flatMap((row): UptimeComponent[] => {
      if (!row.id) return []
      if (row.type === 'static') return [{ id: String(row.id), type: 'static', monitorId: null }]
      const monitor = monitors.get(String(relId(row.monitor)))
      return monitor
        ? [
            {
              id: String(row.id),
              type: 'monitor',
              monitorId: monitor.id,
              lastStatus: monitor.status?.lastStatus ?? null,
            },
          ]
        : []
    }),
  )
}

/**
 * Incidents of a page: active ones, pinned first, newest first. On an `audience` page only those
 * visible to the scoped page (#151).
 */
export async function findActiveIncidents(
  payload: Payload,
  page: AudienceScopedPage,
): Promise<Incident[]> {
  const { docs } = await payload.find({
    collection: 'incidents',
    where: { and: [{ statusPage: { equals: page.id } }, { active: { equals: true } }] },
    sort: ['-pinned', '-createdAt'],
    limit: 50,
    pagination: false,
    depth: 0,
    overrideAccess: true,
  })
  return visibleIncidents(page, docs)
}

/** Everything the public page shows, or null when the slug is unknown or unpublished. */
export async function getPublicStatusPageData(
  payload: Payload,
  slug: string,
): Promise<PublicStatusPageData | null> {
  const page = await findPublishedStatusPage(payload, slug)
  if (!page) return null
  return buildPublicStatusPageData(payload, page)
}

export async function buildPublicStatusPageData(
  payload: Payload,
  page: StatusPage,
): Promise<PublicStatusPageData> {
  const now = new Date()
  const timeZone = statusPageTimeZone(page)
  const pastDays = pastIncidentsDaysOf(page)
  const [incidents, maintenance, recent] = await Promise.all([
    findActiveIncidents(payload, page),
    getActiveMaintenanceForStatusPage(payload, page, {
      now,
      visibilityHours: page.maintenanceVisibilityHours,
    }),
    findRecentIncidents(payload, page, pastDays, now),
  ])
  const groups = await buildPublicGroups(payload, page, {
    incidents,
    maintenance,
    uptimeBars: true,
    now,
  })

  const names = componentNamesOf(groups)
  const scoped = { scoped: isAudiencePage(page) }
  const publicIncidents = incidents.map((incident) => toPublicIncident(incident, names, scoped))

  return {
    config: toPublicConfig(page),
    overall: pageOverallStatus(groups, publicIncidents),
    groups,
    incidents: publicIncidents,
    maintenance,
    pastIncidentsDays: pastDays,
    pastIncidents:
      pastDays > 0
        ? pastIncidentDays(
            recent.map((incident) => toPublicIncident(incident, names, scoped)),
            pastDays,
            timeZone,
            now,
          )
        : [],
    generatedAt: now.toISOString(),
  }
}

/** The page's `pastIncidentsDays`, clamped (default 7). */
export const pastIncidentsDaysOf = (page: Pick<StatusPage, 'pastIncidentsDays'>): number =>
  Math.min(
    MAX_PAST_INCIDENTS_DAYS,
    Math.max(0, Math.floor(page.pastIncidentsDays ?? DEFAULT_PAST_INCIDENTS_DAYS)),
  )

/** Most incidents the main page lists over its past days. */
export const MAX_PAST_INCIDENTS = 200

/**
 * Incidents of a page created within the last `days` days (plus one, so the oldest day is
 * complete in every time zone), newest first. The caller groups them by the day they started.
 */
export async function findRecentIncidents(
  payload: Payload,
  page: AudienceScopedPage,
  days: number,
  now = new Date(),
): Promise<Incident[]> {
  if (days <= 0) return []
  const since = new Date(now.getTime() - (days + 1) * 24 * 60 * 60_000).toISOString()
  const { docs } = await payload.find({
    collection: 'incidents',
    where: { and: [{ statusPage: { equals: page.id } }, { createdAt: { greater_than: since } }] },
    sort: '-createdAt',
    limit: MAX_PAST_INCIDENTS,
    depth: 0,
    overrideAccess: true,
  })
  return visibleIncidents(page, docs)
}
