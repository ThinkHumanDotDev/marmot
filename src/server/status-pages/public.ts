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
import type { StatusPageTheme } from '@/collections/StatusPages'
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
}

export interface PublicGroup {
  name: string
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
  logo: string | null
  theme: StatusPageTheme
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
  /** Reserved for the maintenance issue (#13); always empty for now. */
  maintenance: never[]
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

export const STATUS_DESCRIPTIONS: Record<OverallStatus, string> = {
  up: 'All systems operational',
  partial: 'Partially degraded service',
  down: 'Major outage',
  maintenance: 'Under maintenance',
  unknown: 'No data yet',
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
  const [groups, incidents] = await Promise.all([
    buildPublicGroups(payload, page),
    findActiveIncidents(payload, page.id),
  ])

  return {
    config: toPublicConfig(page),
    overall: overallStatus(groups.flatMap((g) => g.monitors.map((m) => m.status))),
    groups,
    incidents: incidents.map(toPublicIncident),
    maintenance: [],
    generatedAt: new Date().toISOString(),
  }
}
