/**
 * Import/export types shared by the route handlers, the server-side mappers and the settings UI.
 * Keep this module free of server-only imports: it is bundled into client components.
 */

export type ImportFormat = 'uptime-kuma' | 'marmot' | ImportProviderId

/**
 * Hosted services Marmot imports from through their API (#120). The credentials a user pastes are
 * sent with one request and never stored (`src/server/import-export/providers`).
 */
export const IMPORT_PROVIDERS = ['statuspage', 'betterstack'] as const
export type ImportProviderId = (typeof IMPORT_PROVIDERS)[number]

export const isImportProvider = (value: unknown): value is ImportProviderId =>
  typeof value === 'string' && (IMPORT_PROVIDERS as readonly string[]).includes(value)

/** What a provider import can bring over, in the order it is written. */
export const IMPORT_RESOURCES = [
  'monitors',
  'components',
  'incidents',
  'maintenance',
  'subscribers',
] as const
export type ImportResource = (typeof IMPORT_RESOURCES)[number]

export const isImportResource = (value: unknown): value is ImportResource =>
  typeof value === 'string' && (IMPORT_RESOURCES as readonly string[]).includes(value)

export interface ImportProviderInfo {
  id: ImportProviderId
  /** Credential fields of the connect form; `secret` fields are rendered as password inputs. */
  credentials: { name: string; secret: boolean; required: boolean }[]
  resources: ImportResource[]
}

export const IMPORT_PROVIDER_INFO: Record<ImportProviderId, ImportProviderInfo> = {
  statuspage: {
    id: 'statuspage',
    credentials: [
      { name: 'apiKey', secret: true, required: true },
      { name: 'pageId', secret: false, required: true },
    ],
    resources: ['components', 'incidents', 'maintenance', 'subscribers'],
  },
  betterstack: {
    id: 'betterstack',
    credentials: [
      { name: 'apiToken', secret: true, required: true },
      { name: 'statusPageId', secret: false, required: false },
    ],
    resources: ['monitors', 'components', 'incidents', 'maintenance'],
  },
}

export const MARMOT_EXPORT_FORMAT = 'marmot'
export const MARMOT_EXPORT_VERSION = 1

/** Upper bound for an uploaded backup file (bytes of JSON text). */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024

export interface SkippedItem {
  name: string
  reason: string
}

export interface ImportSectionReport {
  /** Documents that will be / were created. */
  create: number
  /** Ids of the created documents (only after a committed import). */
  created?: (string | number)[]
  skipped: SkippedItem[]
}

export interface ImportReport {
  format: ImportFormat
  dryRun: boolean
  monitors: ImportSectionReport
  notifications: ImportSectionReport
  statusPages: ImportSectionReport
  /** Incident and maintenance templates (Marmot exports only). */
  templates: ImportSectionReport
  /** Uptime Kuma tags are reported but not imported until the tags collection exists. */
  tags: ImportSectionReport
  /** Incidents of the imported status pages (Marmot exports and provider imports). */
  incidents: ImportSectionReport
  /** Maintenance windows (provider imports). */
  maintenance: ImportSectionReport
  /** Status page subscribers (provider imports). */
  subscribers: ImportSectionReport
  /** Custom metrics with their status page links (Marmot exports, #280). */
  metrics: ImportSectionReport
  warnings: string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * Recognises the two supported file formats from the parsed JSON:
 * - Marmot export: `{ format: 'marmot', version: 1, ... }`
 * - Uptime Kuma backup (`Uptime_Kuma_Backup_*.json`): `{ version, monitorList, notificationList }`
 */
export function detectImportFormat(json: unknown): ImportFormat | null {
  if (!isRecord(json)) return null
  if (json.format === MARMOT_EXPORT_FORMAT) return 'marmot'
  if (Array.isArray(json.monitorList) || Array.isArray(json.notificationList)) return 'uptime-kuma'
  return null
}

/** Total number of documents an import will create. */
export const totalCreates = (report: ImportReport): number =>
  report.monitors.create +
  report.notifications.create +
  report.statusPages.create +
  report.templates.create +
  report.incidents.create +
  report.maintenance.create +
  report.subscribers.create +
  report.metrics.create
