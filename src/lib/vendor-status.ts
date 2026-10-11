/**
 * Parsers for hosted status pages (#125): Atlassian Statuspage (and every page that serves its
 * `/api/v2/summary.json`, Marmot's own status pages included), Instatus, Better Stack, incident.io
 * and a generic RSS / Atom fallback. Pure functions over already-fetched documents, so they are
 * unit tested against fixtures; fetching and detection live in `./fetch.ts`.
 */

export const VENDOR_PROVIDERS = [
  'atlassian',
  'instatus',
  'betterstack',
  'incidentio',
  'feed',
] as const
export type VendorProvider = (typeof VENDOR_PROVIDERS)[number]

/** Atlassian's page indicator vocabulary, plus maintenance. */
export type VendorIndicator = 'none' | 'minor' | 'major' | 'critical' | 'maintenance'

export interface VendorComponent {
  /** The vendor's component id: stable across renames, what the monitor's filter stores. */
  id: string
  name: string
  indicator: VendorIndicator
}

export interface VendorIncident {
  title: string
  url: string | null
  indicator: VendorIndicator
  /** Ids of the components the incident names; empty when the vendor does not say. */
  componentIds: string[]
}

export interface VendorStatus {
  provider: VendorProvider
  pageName: string | null
  /** The page's overall indicator. */
  indicator: VendorIndicator
  components: VendorComponent[]
  /** Unresolved incidents and maintenances in progress, most recent first. */
  incidents: VendorIncident[]
}

export class VendorFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VendorFormatError'
  }
}

const RANK: Record<VendorIndicator, number> = {
  none: 0,
  maintenance: 1,
  minor: 2,
  major: 3,
  critical: 4,
}

/** The most severe indicator; `none` for an empty list. */
export function worstIndicator(indicators: readonly VendorIndicator[]): VendorIndicator {
  let worst: VendorIndicator = 'none'
  for (const indicator of indicators) if (RANK[indicator] > RANK[worst]) worst = indicator
  return worst
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const objects = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : [])
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null
const idOf = (value: unknown): string | null =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : null

// ---- Atlassian Statuspage (`/api/v2/summary.json`) ------------------------------------------------

const ATLASSIAN_COMPONENT: Record<string, VendorIndicator> = {
  operational: 'none',
  degraded_performance: 'minor',
  partial_outage: 'minor',
  major_outage: 'major',
  under_maintenance: 'maintenance',
}

const ATLASSIAN_INDICATOR: Record<string, VendorIndicator> = {
  none: 'none',
  minor: 'minor',
  major: 'major',
  critical: 'critical',
  maintenance: 'maintenance',
}

export const isAtlassianSummary = (doc: unknown): boolean =>
  isObject(doc) &&
  isObject(doc.status) &&
  typeof doc.status.indicator === 'string' &&
  Array.isArray(doc.components)

export function parseAtlassian(doc: unknown): VendorStatus {
  if (!isAtlassianSummary(doc)) {
    throw new VendorFormatError('Not a Statuspage summary (status.indicator missing)')
  }
  const summary = doc as Json & { status: Json }
  const components = objects(summary.components)
    // Groups are containers; their own status mirrors the worst child.
    .filter((c) => c.group !== true)
    .map((c) => ({
      id: idOf(c.id) ?? '',
      name: text(c.name) ?? '',
      indicator: ATLASSIAN_COMPONENT[String(c.status)] ?? 'none',
    }))
    .filter((c) => c.id)
  const incidentOf = (i: Json, maintenance: boolean): VendorIncident => ({
    title: text(i.name) ?? '',
    url: text(i.shortlink) ?? null,
    indicator: maintenance ? 'maintenance' : (ATLASSIAN_INDICATOR[String(i.impact)] ?? 'minor'),
    componentIds: objects(i.components)
      .map((c) => idOf(c.id))
      .filter((id): id is string => id !== null),
  })
  const incidents = [
    ...objects(summary.incidents)
      .filter((i) => i.status !== 'resolved' && i.status !== 'postmortem')
      .map((i) => incidentOf(i, false)),
    ...objects(summary.scheduled_maintenances)
      .filter((m) => m.status === 'in_progress' || m.status === 'verifying')
      .map((m) => incidentOf(m, true)),
  ]
  const page = isObject(summary.page) ? summary.page : {}
  return {
    provider: 'atlassian',
    pageName: text(page.name),
    indicator: ATLASSIAN_INDICATOR[String(summary.status.indicator)] ?? 'none',
    components,
    incidents,
  }
}

// ---- Instatus (`/summary.json` + `/v2/components.json`) -------------------------------------------

const INSTATUS_STATUS: Record<string, VendorIndicator> = {
  OPERATIONAL: 'none',
  UP: 'none',
  DEGRADEDPERFORMANCE: 'minor',
  PARTIALOUTAGE: 'minor',
  HASISSUES: 'minor',
  MINOROUTAGE: 'minor',
  MAJOROUTAGE: 'major',
  UNDERMAINTENANCE: 'maintenance',
}

export const isInstatusSummary = (doc: unknown): boolean =>
  isObject(doc) &&
  isObject(doc.page) &&
  typeof doc.page.status === 'string' &&
  ('activeIncidents' in doc || 'activeMaintenances' in doc || doc.page.status in INSTATUS_STATUS)

/** Flattens Instatus components (groups carry `children`). */
function instatusComponents(value: unknown): VendorComponent[] {
  const out: VendorComponent[] = []
  for (const c of objects(value)) {
    const children = objects(c.children)
    if (children.length > 0) {
      out.push(...instatusComponents(children))
      continue
    }
    const id = idOf(c.id)
    if (!id) continue
    out.push({
      id,
      name: text(c.name) ?? id,
      indicator: INSTATUS_STATUS[String(c.status).toUpperCase()] ?? 'none',
    })
  }
  return out
}

export function parseInstatus(summary: unknown, components?: unknown): VendorStatus {
  if (!isInstatusSummary(summary)) {
    throw new VendorFormatError('Not an Instatus summary (page.status missing)')
  }
  const doc = summary as Json & { page: Json }
  const incidents: VendorIncident[] = [
    ...objects(doc.activeIncidents)
      .filter((i) => String(i.status).toUpperCase() !== 'RESOLVED')
      .map((i) => ({
        title: text(i.name) ?? '',
        url: text(i.url),
        indicator: INSTATUS_STATUS[String(i.impact).toUpperCase()] ?? 'minor',
        componentIds: objects(i.components)
          .map((c) => idOf(c.id))
          .filter((id): id is string => id !== null),
      })),
    ...objects(doc.activeMaintenances)
      .filter((m) => String(m.status).toUpperCase() === 'INPROGRESS')
      .map((m) => ({
        title: text(m.name) ?? '',
        url: text(m.url),
        indicator: 'maintenance' as const,
        componentIds: objects(m.components)
          .map((c) => idOf(c.id))
          .filter((id): id is string => id !== null),
      })),
  ]
  const list = isObject(components) ? components.components : components
  return {
    provider: 'instatus',
    pageName: text(doc.page.name),
    indicator: INSTATUS_STATUS[String(doc.page.status).toUpperCase()] ?? 'none',
    components: instatusComponents(list),
    incidents,
  }
}

// ---- Better Stack (`/index.json`, JSON:API) -------------------------------------------------------

const BETTERSTACK_STATE: Record<string, VendorIndicator> = {
  operational: 'none',
  degraded: 'minor',
  downtime: 'major',
  maintenance: 'maintenance',
}

export const isBetterStackIndex = (doc: unknown): boolean =>
  isObject(doc) &&
  isObject(doc.data) &&
  isObject(doc.data.attributes) &&
  typeof doc.data.attributes.aggregate_state === 'string'

export function parseBetterStack(doc: unknown, pageUrl?: string): VendorStatus {
  if (!isBetterStackIndex(doc)) {
    throw new VendorFormatError('Not a Better Stack status page (aggregate_state missing)')
  }
  const index = doc as Json & { data: Json & { attributes: Json } }
  const included = objects(index.included)
  const components = included
    .filter((item) => item.type === 'status_page_resource' && isObject(item.attributes))
    .map((item) => {
      const attributes = item.attributes as Json
      return {
        id: idOf(item.id) ?? '',
        name: text(attributes.public_name) ?? text(attributes.name) ?? String(item.id),
        indicator: BETTERSTACK_STATE[String(attributes.status)] ?? 'none',
      }
    })
    .filter((c) => c.id)
  const base = pageUrl?.replace(/\/+$/, '')
  const incidents = included
    .filter((item) => item.type === 'status_report' && isObject(item.attributes))
    .filter((item) => {
      const attributes = item.attributes as Json
      return !attributes.ends_at && attributes.aggregate_state !== 'resolved'
    })
    .map((item) => {
      const attributes = item.attributes as Json
      const affected = objects(attributes.affected_resources)
      return {
        title: text(attributes.title) ?? '',
        url: base && item.id !== undefined ? `${base}/incident/${String(item.id)}` : null,
        indicator:
          attributes.report_type === 'maintenance'
            ? ('maintenance' as const)
            : (BETTERSTACK_STATE[String(attributes.aggregate_state)] ?? 'minor'),
        componentIds: affected
          .map((r) => idOf(r.status_page_resource_id))
          .filter((id): id is string => id !== null),
      }
    })
  return {
    provider: 'betterstack',
    pageName: text(index.data.attributes.company_name),
    indicator: BETTERSTACK_STATE[String(index.data.attributes.aggregate_state)] ?? 'none',
    components,
    incidents,
  }
}

// ---- incident.io (widget API `/proxy/<host>`) -----------------------------------------------------

const INCIDENTIO_STATUS: Record<string, VendorIndicator> = {
  operational: 'none',
  degraded_performance: 'minor',
  partial_outage: 'minor',
  full_outage: 'major',
  under_maintenance: 'maintenance',
}

export const isIncidentIoWidget = (doc: unknown): boolean =>
  isObject(doc) &&
  isObject(doc.summary) &&
  Array.isArray(doc.summary.ongoing_incidents) &&
  Array.isArray(doc.summary.affected_components)

export function parseIncidentIo(doc: unknown): VendorStatus {
  if (!isIncidentIoWidget(doc)) {
    throw new VendorFormatError('Not an incident.io status page (summary missing)')
  }
  const summary = (doc as { summary: Json }).summary
  const affected = new Map<string, VendorIndicator>()
  for (const c of objects(summary.affected_components)) {
    const id = idOf(c.component_id)
    if (id) affected.set(id, INCIDENTIO_STATUS[String(c.status)] ?? 'minor')
  }
  const maintained = new Set<string>()
  for (const m of objects(summary.in_progress_maintenances)) {
    for (const c of objects(m.affected_components)) {
      const id = idOf(c.id) ?? idOf(c.component_id)
      if (id) maintained.add(id)
    }
  }
  const components: VendorComponent[] = []
  const add = (c: Json) => {
    const id = idOf(c.component_id) ?? idOf(c.id)
    if (!id) return
    components.push({
      id,
      name: text(c.name) ?? id,
      indicator: affected.get(id) ?? (maintained.has(id) ? 'maintenance' : 'none'),
    })
  }
  const structure = isObject(summary.structure) ? objects(summary.structure.items) : []
  for (const item of structure) {
    if (isObject(item.component)) add(item.component)
    if (isObject(item.group)) for (const c of objects(item.group.components)) add(c)
  }
  const incidentOf = (i: Json, maintenance: boolean): VendorIncident => ({
    title: text(i.name) ?? '',
    url: text(i.url),
    indicator: maintenance
      ? 'maintenance'
      : (INCIDENTIO_STATUS[String(i.current_worst_impact)] ?? 'minor'),
    componentIds: objects(i.affected_components)
      .map((c) => idOf(c.id) ?? idOf(c.component_id))
      .filter((id): id is string => id !== null),
  })
  const incidents = [
    ...objects(summary.ongoing_incidents).map((i) => incidentOf(i, false)),
    ...objects(summary.in_progress_maintenances).map((m) => incidentOf(m, true)),
  ]
  return {
    provider: 'incidentio',
    pageName: text(summary.name),
    indicator: worstIndicator([...[...affected.values()], ...incidents.map((i) => i.indicator)]),
    components,
    incidents,
  }
}

// ---- RSS / Atom fallback --------------------------------------------------------------------------

/** Words a vendor uses in the newest entry once the incident is over. */
const CLOSED = /\b(resolved|completed|recovered|restored|fixed|postmortem)\b/i
const MAINTENANCE = /\b(maintenance|scheduled)\b/i
/** Entries older than this are history, whatever they say. */
export const FEED_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000

const decodeEntities = (value: string): string =>
  value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')

const stripTags = (value: string): string =>
  decodeEntities(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

function tag(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml)
  return match ? match[1] : null
}

function atomLink(entry: string): string | null {
  const links = [...entry.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1])
  const preferred = links.find((attrs) => !/rel=["'](?!alternate)/i.test(attrs)) ?? links[0]
  const href = preferred ? /href=["']([^"']+)["']/i.exec(preferred) : null
  return href ? decodeEntities(href[1]) : null
}

export const isFeed = (body: string): boolean => /<(rss|feed)\b/i.test(body.slice(0, 2000))

/**
 * An RSS or Atom incident feed. Only the newest entry counts: published within the last 24 hours
 * and not saying it is resolved (or completed) means an incident is open. Feeds carry no component
 * ids, so a component filter cannot apply.
 */
export function parseFeed(xml: string, now: Date = new Date()): VendorStatus {
  if (!isFeed(xml)) throw new VendorFormatError('Not an RSS or Atom feed')
  const atom = /<feed\b/i.test(xml)
  const channel = atom ? xml : (tag(xml, 'channel') ?? xml)
  const head = channel.split(/<(?:item|entry)\b/i)[0]
  const pageName = (() => {
    const title = tag(head, 'title')
    return title ? stripTags(title) || null : null
  })()
  const entries = [
    ...xml.matchAll(atom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi),
  ]
    .map((m) => m[0])
    .map((entry) => {
      const title = stripTags(tag(entry, 'title') ?? '')
      const body = stripTags(
        tag(entry, atom ? 'content' : 'description') ?? tag(entry, 'summary') ?? '',
      )
      const date =
        tag(entry, atom ? 'updated' : 'pubDate') ?? tag(entry, 'published') ?? tag(entry, 'dc:date')
      const at = date ? new Date(stripTags(date)) : null
      const link = atom ? atomLink(entry) : stripTags(tag(entry, 'link') ?? '') || null
      return { title, body, at: at && !Number.isNaN(at.getTime()) ? at : null, link }
    })
    .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0))
  const latest = entries[0]
  const open =
    latest !== undefined &&
    latest.at !== null &&
    now.getTime() - latest.at.getTime() <= FEED_ACTIVE_WINDOW_MS &&
    // Statuspage-style feeds put the latest update first in the body: "<b>Resolved</b> - …".
    !CLOSED.test(`${latest.title} ${latest.body.slice(0, 200)}`)
  const indicator: VendorIndicator = !open
    ? 'none'
    : MAINTENANCE.test(latest.title)
      ? 'maintenance'
      : 'minor'
  return {
    provider: 'feed',
    pageName,
    indicator,
    components: [],
    incidents: open ? [{ title: latest.title, url: latest.link, indicator, componentIds: [] }] : [],
  }
}

/** The feed a status page HTML advertises (`<link rel="alternate" type="application/rss+xml">`). */
export function feedLinkFromHtml(html: string, baseUrl: string): string | null {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = match[0]
    if (!/rel=["']?alternate/i.test(attrs)) continue
    if (!/type=["']?application\/(rss|atom)\+xml/i.test(attrs)) continue
    const href = /href=["']([^"']+)["']/i.exec(attrs)
    if (!href) continue
    try {
      return new URL(decodeEntities(href[1]), baseUrl).toString()
    } catch {
      continue
    }
  }
  return null
}

// ---- Verdict -------------------------------------------------------------------------------------

export type VendorMonitorStatus = 'up' | 'degraded' | 'down' | 'maintenance'

/** `none` → up, `minor` → degraded, `major` / `critical` → down, maintenance → maintenance. */
export function indicatorToStatus(indicator: VendorIndicator): VendorMonitorStatus {
  switch (indicator) {
    case 'minor':
      return 'degraded'
    case 'major':
    case 'critical':
      return 'down'
    case 'maintenance':
      return 'maintenance'
    default:
      return 'up'
  }
}

export interface ComponentFilter {
  id: string
  /** Display label from when the filter was saved; the id is what matches. */
  name?: string | null
}

export interface VendorVerdict {
  status: VendorMonitorStatus
  indicator: VendorIndicator
  msg: string
  /** Filter entries whose id the vendor no longer lists. */
  missing: ComponentFilter[]
}

const INDICATOR_LABEL: Record<VendorIndicator, string> = {
  none: 'All systems operational',
  minor: 'Degraded',
  major: 'Major outage',
  critical: 'Critical outage',
  maintenance: 'Under maintenance',
}

/**
 * The monitor's status for a parsed page: the page indicator without a filter, otherwise the worst
 * of the selected components (and of the incidents naming them). The message names the vendor's
 * current incident with its link, and every filtered component id that disappeared.
 */
export function vendorVerdict(
  status: VendorStatus,
  filter: readonly ComponentFilter[],
): VendorVerdict {
  const wanted = filter.filter((f) => f.id)
  let indicator: VendorIndicator
  let incidents = status.incidents
  const missing: ComponentFilter[] = []
  const parts: string[] = []

  if (wanted.length === 0) {
    indicator = worstIndicator([status.indicator, ...incidents.map((i) => i.indicator)])
  } else {
    const byId = new Map(status.components.map((c) => [c.id, c]))
    const found: VendorComponent[] = []
    for (const f of wanted) {
      const component = byId.get(f.id)
      if (component) found.push(component)
      else missing.push(f)
    }
    const ids = new Set(found.map((c) => c.id))
    incidents = incidents.filter((i) => i.componentIds.some((id) => ids.has(id)))
    indicator = worstIndicator([
      ...found.map((c) => c.indicator),
      ...incidents.map((i) => i.indicator),
    ])
    if (found.length === 1 && wanted.length === 1) parts.push(found[0].name)
  }

  const incident = incidents.find((i) => i.indicator === indicator) ?? incidents[0]
  parts.push(
    incident && indicator !== 'none'
      ? `${INDICATOR_LABEL[indicator]}: ${incident.title}${incident.url ? ` (${incident.url})` : ''}`
      : INDICATOR_LABEL[indicator],
  )
  if (missing.length > 0) {
    parts.push(
      `component${missing.length === 1 ? '' : 's'} no longer on the status page: ${missing
        .map((m) => (m.name ? `${m.name} (${m.id})` : m.id))
        .join(', ')}`,
    )
  }
  return { status: indicatorToStatus(indicator), indicator, msg: parts.join(' · '), missing }
}
