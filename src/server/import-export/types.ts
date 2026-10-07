/**
 * The import plan is the format-independent intermediate between a parsed file (Uptime Kuma backup
 * or Marmot export) and the database. Parsers produce it without touching the database;
 * `applyImportPlan` resolves the string keys to real ids, checks permissions and conflicts and
 * writes it (or only reports, on a dry run).
 */
import type { ImportFormat, SkippedItem } from '@/lib/import-export'
import type { MonitorFormValues } from '@/lib/validation/monitor'
import type { TemplateKind } from '@/lib/templates'
import type { Incident, StatusPage, Template } from '@/payload-types'

export interface PlannedNotification {
  /** Source id as a string; monitors reference channels by this key. */
  key: string
  name: string
  /** Marmot provider slug (`src/server/notification-providers`). */
  type: string
  config: Record<string, unknown>
  isDefault: boolean
  active: boolean
}

export interface PlannedMonitor {
  key: string
  data: MonitorFormValues
  parentKey: string | null
  notificationKeys: string[]
  /** Kept so push URLs that worked before the migration keep working. */
  pushToken: string | null
}

export type PlannedStatusPageFields = Pick<
  StatusPage,
  | 'title'
  | 'slug'
  | 'description'
  | 'homepageUrl'
  | 'contactUrl'
  | 'theme'
  | 'themePreset'
  | 'themeOverrides'
  | 'bannerText'
  | 'published'
  | 'searchEngineIndex'
  | 'showTags'
  | 'showCertificateExpiry'
  | 'showPoweredBy'
  | 'showValues'
  | 'autoRefreshInterval'
  | 'footerText'
  | 'customCSS'
  | 'googleAnalyticsId'
>

/** A group row (component). Static components have no `monitorKey`. */
export interface PlannedStatusPageComponent {
  /** Row id in the file; templates reference components by it. */
  key?: string | null
  monitorKey: string | null
  type?: 'monitor' | 'static'
  name?: string | null
  description?: string | null
  showValues?: boolean
  sendUrl: boolean
  customUrl: string | null
}

export interface PlannedStatusPageGroup {
  name: string
  defaultOpen?: boolean
  monitors: PlannedStatusPageComponent[]
}

export type PlannedIncident = Pick<
  Incident,
  'title' | 'content' | 'style' | 'pinned' | 'active' | 'resolvedAt'
>

export interface PlannedStatusPage {
  key: string
  data: PlannedStatusPageFields
  domains: string[]
  groups: PlannedStatusPageGroup[]
  incidents: PlannedIncident[]
}

export interface PlannedTemplate {
  name: string
  kind: TemplateKind
  title: string | null
  body: string | null
  status: Template['status']
  impact: Template['impact']
  duration: number | null
  /** Key of a planned status page, or `null` for a template offered on every page. */
  statusPageKey: string | null
  /** Default components by their row key in the file (`PlannedStatusPageComponent.key`). */
  components: {
    componentKey: string
    impact: NonNullable<Template['components']>[number]['impact']
  }[]
}

export interface ImportPlan {
  format: ImportFormat
  monitors: PlannedMonitor[]
  notifications: PlannedNotification[]
  statusPages: PlannedStatusPage[]
  templates: PlannedTemplate[]
  skipped: {
    monitors: SkippedItem[]
    notifications: SkippedItem[]
    statusPages: SkippedItem[]
    templates: SkippedItem[]
    tags: SkippedItem[]
  }
  warnings: string[]
}

export const emptyPlan = (format: ImportFormat): ImportPlan => ({
  format,
  monitors: [],
  notifications: [],
  statusPages: [],
  templates: [],
  skipped: { monitors: [], notifications: [], statusPages: [], templates: [], tags: [] },
  warnings: [],
})

/** Error for files that are not of the expected format at all (→ HTTP 400). */
export class ImportFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportFormatError'
  }
}

// ---- Loose value coercion for hand-edited / version-drifted JSON --------------------------------

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export const asString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

/** Non-empty trimmed string or `null`. */
export const asText = (value: unknown): string | null => {
  const s = asString(value)
  return s && s.trim() ? s : null
}

export const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export const asInt = (value: unknown): number | null => {
  const n = asNumber(value)
  return n === null ? null : Math.round(n)
}

/** Uptime Kuma stores booleans as 0/1 in SQLite and as true/false in JSON. */
export const asBool = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true
    if (v === '0' || v === 'false' || v === 'no' || v === 'off' || v === '') return false
  }
  return null
}

export const asKey = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim()) return value.trim()
  return null
}
