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
import type { StatusPageLanguage, StatusPageTheme } from '@/collections/StatusPages'
import { defaultLocale } from '@/i18n/locales'
import {
  incidentTimeline,
  legacyStyleFromImpact,
  worstImpact,
  type ComponentImpact,
  type IncidentStatus,
  type LegacyIncidentStyle,
} from '@/lib/incident-timeline'
import {
  getActiveMaintenanceForStatusPage,
  type PublicMaintenance,
} from '@/server/maintenance/status-page'
import { populateMonitorTags, toRealtimeTags } from '@/server/realtime/serialize'
import { getUptime } from '@/server/stats/uptime-calculator'

import type { Incident, Media, Monitor, StatusPage } from '@/payload-types'

export type BeatStatus = (typeof HEARTBEAT_STATUSES)[number]
export type MonitorPublicStatus = BeatStatus | 'unknown'
export type OverallStatus = 'up' | 'partial' | 'down' | 'maintenance' | 'unknown'

export const BEATS_PER_MONITOR = 50

export interface PublicBeat {
  status: BeatStatus
  /** ISO timestamp. */
  time: string
  ping: number | null
}

export interface PublicMonitor {
  id: string
  name: string
  /** Link shown to visitors (custom URL, or the monitor's URL when `sendUrl` is on). */
  url?: string
  status: MonitorPublicStatus
  /** 0..1 */
  uptime24h: number
  /** 0..1 */
  uptime30d: number
  /** Oldest first, at most `BEATS_PER_MONITOR`. */
  beats: PublicBeat[]
  tags?: { name: string; color?: string | null; value?: string | null }[]
  /** Worst impact declared by active incidents; omitted while the component is operational. */
  impact?: ComponentImpact
}

export interface PublicGroup {
  name: string
  monitors: PublicMonitor[]
}

/** A status page component named by an incident (only components visible on the page). */
export interface PublicIncidentComponent {
  /** Monitor id, as in `groups[].monitors[].id`. */
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
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
}

export interface PublicConfig {
  slug: string
  title: string
  description: string | null
  logo: string | null
  theme: StatusPageTheme
  /** Fixed locale, or `auto` to follow the visitor's browser. */
  language: StatusPageLanguage
  published: boolean
  showTags: boolean
  showCertificateExpiry: boolean
  showPoweredBy: boolean
  autoRefreshInterval: number
  customCSS: string | null
  footerText: string | null
  googleAnalyticsId: string | null
}

export interface PublicStatusPageData {
  config: PublicConfig
  overall: OverallStatus
  groups: PublicGroup[]
  /** Active incidents, newest first (pinned ones first). */
  incidents: PublicIncident[]
  /** Running and upcoming maintenance windows attached to this page, running ones first. */
  maintenance: PublicMaintenance[]
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

const mediaUrl = (logo: StatusPage['logo']): string | null =>
  logo && typeof logo === 'object' ? ((logo as Media).url ?? null) : null

/** The published status page with `slug`, or null. */
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
  return docs[0] ?? null
}

/** The public subset of a status page's configuration. */
export function toPublicConfig(page: StatusPage): PublicConfig {
  return {
    slug: page.slug,
    title: page.title,
    description: page.description ?? null,
    logo: mediaUrl(page.logo),
    theme: page.theme ?? 'auto',
    language: page.language ?? defaultLocale,
    published: Boolean(page.published),
    showTags: Boolean(page.showTags),
    showCertificateExpiry: Boolean(page.showCertificateExpiry),
    showPoweredBy: page.showPoweredBy !== false,
    autoRefreshInterval: Math.max(0, page.autoRefreshInterval ?? 0),
    customCSS: page.customCSS ?? null,
    footerText: page.footerText ?? null,
    googleAnalyticsId: page.googleAnalyticsId ?? null,
  }
}

/**
 * Public view of an incident. `componentNames` maps monitor ids to the names shown on the page;
 * components that are not visible there (removed, paused, other pages) are left out.
 */
export function toPublicIncident(
  incident: Incident,
  componentNames: ReadonlyMap<string, string> = new Map(),
): PublicIncident {
  const { updates, state } = incidentTimeline(incident)
  const visible = (rows: readonly { monitor: string | number; impact: ComponentImpact }[]) =>
    rows.flatMap((row) => {
      const name = componentNames.get(String(row.monitor))
      return name === undefined ? [] : [{ id: String(row.monitor), name, impact: row.impact }]
    })
  const newestFirst = updates.slice().reverse()
  return {
    id: String(incident.id),
    title: incident.title,
    status: state.status,
    impact: state.impact,
    components: visible(state.components),
    updates: newestFirst.map((update, index) => ({
      id: update.id ? String(update.id) : `${incident.id}-${index}`,
      status: update.status,
      message: update.message ?? '',
      postedAt: update.postedAt,
      editedAt: update.editedAt ?? null,
      components: visible(update.components ?? []),
    })),
    content: newestFirst[0]?.message ?? '',
    style: legacyStyleFromImpact(state.impact),
    pinned: Boolean(incident.pinned),
    active: state.active,
    createdAt: incident.createdAt,
    updatedAt: incident.updatedAt,
    resolvedAt: state.resolvedAt ?? incident.resolvedAt ?? null,
  }
}

/** Worst impact per component across the active incidents (operational components omitted). */
export function componentImpacts(
  incidents: readonly PublicIncident[],
): Map<string, ComponentImpact> {
  const impacts = new Map<string, ComponentImpact>()
  for (const incident of incidents) {
    if (!incident.active) continue
    for (const row of incident.components) {
      const worst = worstImpact([impacts.get(row.id) ?? 'operational', row.impact])
      if (worst !== 'operational') impacts.set(row.id, worst)
    }
  }
  return impacts
}

const OVERALL_RANK: Record<OverallStatus, number> = {
  unknown: 0,
  up: 1,
  maintenance: 2,
  partial: 3,
  down: 4,
}

/**
 * Overall page state from monitor statuses *and* active incidents: a component with a
 * `major_outage` counts as down and one with a degraded or partial impact as not fully up (Uptime
 * Kuma's rule then applies); incidents that name no component raise the page to `partial`
 * (degraded / partial outage) or `down` (major outage).
 */
export function pageOverallStatus(
  groups: readonly PublicGroup[],
  incidents: readonly PublicIncident[],
): OverallStatus {
  const impacts = componentImpacts(incidents)
  const statuses = groups.flatMap((group) =>
    group.monitors.map((monitor): MonitorPublicStatus => {
      const impact = impacts.get(monitor.id)
      if (impact === 'major_outage') return 'down'
      if (impact && monitor.status === 'up') return 'pending'
      return monitor.status
    }),
  )
  let overall = overallStatus(statuses)
  for (const incident of incidents) {
    if (!incident.active || incident.components.length > 0) continue
    if (incident.impact === 'operational') continue
    const fromIncident: OverallStatus = incident.impact === 'major_outage' ? 'down' : 'partial'
    if (OVERALL_RANK[fromIncident] > OVERALL_RANK[overall]) overall = fromIncident
  }
  return overall
}

/** Monitor id → public name of every component visible in `groups`. */
export const componentNamesOf = (groups: readonly PublicGroup[]): Map<string, string> =>
  new Map(groups.flatMap((group) => group.monitors.map((m) => [m.id, m.name] as const)))

/**
 * Overall page state from the monitors' last statuses (Uptime Kuma `StatusPage.overallStatus`):
 * any monitor in maintenance → `maintenance`; all up → `up`; some up → `partial`; none up → `down`.
 * Monitors that were never checked are ignored; no checked monitors → `unknown`.
 */
export function overallStatus(statuses: readonly MonitorPublicStatus[]): OverallStatus {
  const known = statuses.filter((s) => s !== 'unknown')
  if (known.length === 0) return 'unknown'
  if (known.includes('maintenance')) return 'maintenance'
  const ups = known.filter((s) => s === 'up').length
  if (ups === known.length) return 'up'
  if (ups === 0) return 'down'
  return 'partial'
}

async function lastBeats(payload: Payload, monitorId: string | number): Promise<PublicBeat[]> {
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
    .map((beat) => ({ status: beat.status, time: beat.time, ping: beat.ping ?? null }))
    .reverse()
}

type GroupRow = NonNullable<StatusPage['groups']>[number]
type MonitorRow = NonNullable<GroupRow['monitors']>[number]

async function toPublicMonitor(
  payload: Payload,
  row: MonitorRow,
  monitor: Monitor,
  showTags: boolean,
): Promise<PublicMonitor> {
  const [uptime24h, uptime30d, beats] = await Promise.all([
    getUptime(payload, monitor.id, '24h'),
    getUptime(payload, monitor.id, '30d'),
    lastBeats(payload, monitor.id),
  ])

  const url = row.customUrl?.trim() || (row.sendUrl ? monitor.url?.trim() : undefined) || undefined
  // Public: name, colour and value only (no tag ids).
  const tags = showTags
    ? toRealtimeTags(monitor.tags).map(({ name, color, value }) => ({ name, color, value }))
    : []

  return {
    id: String(monitor.id),
    name: monitor.name,
    ...(url ? { url } : {}),
    status: monitor.status?.lastStatus ?? 'unknown',
    uptime24h,
    uptime30d,
    beats,
    ...(showTags ? { tags } : {}),
  }
}

/**
 * Resolves every monitor referenced by the page in one query (active monitors only; paused or
 * deleted monitors are dropped from the public view) and builds the public groups.
 */
export async function buildPublicGroups(
  payload: Payload,
  page: StatusPage,
): Promise<PublicGroup[]> {
  const ids = new Set<string>()
  for (const group of page.groups ?? []) {
    for (const row of group.monitors ?? []) {
      const id = relId(row.monitor)
      if (id !== null) ids.add(String(id))
    }
  }
  if (ids.size === 0) return (page.groups ?? []).map((g) => ({ name: g.name, monitors: [] }))

  const { docs } = await payload.find({
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
  const monitors = page.showTags ? await populateMonitorTags(payload, docs) : docs
  const byId = new Map(monitors.map((m) => [String(m.id), m]))

  const groups: PublicGroup[] = []
  for (const group of page.groups ?? []) {
    const monitors = await Promise.all(
      (group.monitors ?? []).flatMap((row) => {
        const monitor = byId.get(String(relId(row.monitor)))
        return monitor ? [toPublicMonitor(payload, row, monitor, Boolean(page.showTags))] : []
      }),
    )
    groups.push({ name: group.name, monitors })
  }
  return groups
}

/** Incidents of a page: active ones, pinned first, newest first. */
export async function findActiveIncidents(
  payload: Payload,
  pageId: string | number,
): Promise<Incident[]> {
  const { docs } = await payload.find({
    collection: 'incidents',
    where: { and: [{ statusPage: { equals: pageId } }, { active: { equals: true } }] },
    sort: ['-pinned', '-createdAt'],
    limit: 50,
    pagination: false,
    depth: 0,
    overrideAccess: true,
  })
  return docs
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
  const [groups, incidents, maintenance] = await Promise.all([
    buildPublicGroups(payload, page),
    findActiveIncidents(payload, page.id),
    getActiveMaintenanceForStatusPage(payload, page.id),
  ])

  const names = componentNamesOf(groups)
  const publicIncidents = incidents.map((incident) => toPublicIncident(incident, names))
  const impacts = componentImpacts(publicIncidents)
  const groupsWithImpact = groups.map((group) => ({
    ...group,
    monitors: group.monitors.map((monitor) => {
      const impact = impacts.get(monitor.id)
      return impact ? { ...monitor, impact } : monitor
    }),
  }))

  return {
    config: toPublicConfig(page),
    overall: pageOverallStatus(groupsWithImpact, publicIncidents),
    groups: groupsWithImpact,
    incidents: publicIncidents,
    maintenance,
    generatedAt: new Date().toISOString(),
  }
}
