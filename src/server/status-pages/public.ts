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
import type { IncidentStyle } from '@/collections/Incidents'
import type { StatusPageLanguage, StatusPageTheme } from '@/collections/StatusPages'
import { defaultLocale } from '@/i18n/locales'
import { getThemePreset } from '@/lib/status-page-themes'
import {
  componentDisplayName,
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
  tags?: { name: string; color?: string | null; value?: string | null }[]
}

export type PublicComponent = PublicMonitor

export interface PublicGroup {
  name: string
  /** Expanded on load; collapsed groups show `status` in their header. */
  defaultOpen: boolean
  /** Worst status of the group's components. */
  status: MonitorPublicStatus
  monitors: PublicMonitor[]
}

export interface PublicIncident {
  id: string
  title: string
  content: string
  style: IncidentStyle
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
  /** Fixed locale, or `auto` to follow the visitor's browser. */
  language: StatusPageLanguage
  published: boolean
  showTags: boolean
  showCertificateExpiry: boolean
  showPoweredBy: boolean
  /** Page-wide switch for uptime percentages and response times. */
  showValues: boolean
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

const mediaUrl = (media: StatusPage['logo']): string | null =>
  media && typeof media === 'object' ? ((media as Media).url ?? null) : null

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
    logoDark: mediaUrl(page.logoDark),
    favicon: mediaUrl(page.favicon),
    homepageUrl: page.homepageUrl ?? null,
    contactUrl: page.contactUrl ?? null,
    theme: page.theme ?? 'auto',
    themePreset: getThemePreset(page.themePreset).id,
    bannerText: page.bannerText?.trim() || null,
    language: page.language ?? defaultLocale,
    published: Boolean(page.published),
    showTags: Boolean(page.showTags),
    showCertificateExpiry: Boolean(page.showCertificateExpiry),
    showPoweredBy: page.showPoweredBy !== false,
    showValues: page.showValues !== false,
    autoRefreshInterval: Math.max(0, page.autoRefreshInterval ?? 0),
    customCSS: page.customCSS ?? null,
    footerText: page.footerText ?? null,
    googleAnalyticsId: page.googleAnalyticsId ?? null,
  }
}

export function toPublicIncident(incident: Incident): PublicIncident {
  return {
    id: String(incident.id),
    title: incident.title,
    content: incident.content ?? '',
    style: incident.style ?? 'info',
    pinned: Boolean(incident.pinned),
    active: incident.active !== false,
    createdAt: incident.createdAt,
    updatedAt: incident.updatedAt,
    resolvedAt: incident.resolvedAt ?? null,
  }
}

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

async function toPublicMonitor(
  payload: Payload,
  page: StatusPage,
  row: MonitorRow,
  monitor: Monitor,
  impact: ComponentImpact | null,
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
    ...(showTags ? { tags } : {}),
  }
}

function toPublicStaticComponent(
  page: StatusPage,
  row: MonitorRow,
  fallbackId: string,
  impact: ComponentImpact | null,
  underMaintenance: boolean,
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
    context.incidents ?? findActiveIncidents(payload, page.id),
    context.maintenance ??
      (hasStatic ? getActiveMaintenanceForStatusPage(payload, page.id) : Promise.resolve([])),
  ])
  const monitors =
    page.showTags && docs.length > 0 ? await populateMonitorTags(payload, docs) : docs
  const byId = new Map(monitors.map((m) => [String(m.id), m]))
  const impacts = impactsByComponent(incidents)
  const underMaintenance = maintenance.some((m) => m.status === 'under-maintenance')

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
              ),
            ),
          ]
        }
        const monitor = byId.get(String(relId(row.monitor)))
        return monitor ? [toPublicMonitor(payload, page, row, monitor, impact)] : []
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
  const [incidents, maintenance] = await Promise.all([
    findActiveIncidents(payload, page.id),
    getActiveMaintenanceForStatusPage(payload, page.id),
  ])
  const groups = await buildPublicGroups(payload, page, { incidents, maintenance })

  return {
    config: toPublicConfig(page),
    overall: overallStatus(groups.flatMap((g) => g.monitors.map((m) => m.status))),
    groups,
    incidents: incidents.map(toPublicIncident),
    maintenance,
    generatedAt: new Date().toISOString(),
  }
}
