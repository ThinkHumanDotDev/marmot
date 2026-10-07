/**
 * Import/export types shared by the route handlers, the server-side mappers and the settings UI.
 * Keep this module free of server-only imports: it is bundled into client components.
 */

export type ImportFormat = 'uptime-kuma' | 'marmot'

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
  /** Uptime Kuma tags are reported but not imported until the tags collection exists. */
  tags: ImportSectionReport
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
  report.monitors.create + report.notifications.create + report.statusPages.create
