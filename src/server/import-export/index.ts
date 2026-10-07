/**
 * Import / export of monitors, notification channels and status pages.
 *
 * - `parseUptimeKumaBackup(json)` / `parseMarmotExport(json)` → `ImportPlan` (pure)
 * - `applyImportPlan(payload, { orgId, user, plan, dryRun })` → `ImportReport`
 * - `buildMarmotExport(payload, { orgId, user })` → JSON document for download
 *
 * Routes: `POST /api/orgs/:orgId/import[?dryRun=1]` (auto-detects the format),
 * `POST /api/orgs/:orgId/import/uptime-kuma[?dryRun=1]`, `GET /api/orgs/:orgId/export`.
 */
import { detectImportFormat, type ImportFormat } from '@/lib/import-export'

import { parseMarmotExport } from './marmot'
import { ImportFormatError, type ImportPlan } from './types'
import { parseUptimeKumaBackup } from './uptime-kuma'

export { applyImportPlan, type ApplyImportOptions } from './apply'
export {
  KUMA_NOTIFICATION_MAPPINGS,
  mapKumaNotificationConfig,
  SUPPORTED_KUMA_NOTIFICATION_TYPES,
} from './kuma-notifications'
export {
  buildMarmotExport,
  exportedOrganizationName,
  parseMarmotExport,
  type ExportedMonitor,
  type ExportedNotification,
  type ExportedStatusPage,
  type MarmotExport,
} from './marmot'
export {
  ImportFormatError,
  type ImportPlan,
  type PlannedMonitor,
  type PlannedNotification,
  type PlannedStatusPage,
} from './types'
import { importText, type ImportText } from './text'
export { parseUptimeKumaBackup } from './uptime-kuma'

/**
 * Parses `json` in the given format, or auto-detects it when `format` is omitted. Skip reasons and
 * warnings are written with `t` (English by default).
 */
export function parseImportFile(
  json: unknown,
  format?: ImportFormat,
  t: ImportText = importText(),
): ImportPlan {
  const detected = format ?? detectImportFormat(json)
  switch (detected) {
    case 'uptime-kuma':
      return parseUptimeKumaBackup(json, t)
    case 'marmot':
      return parseMarmotExport(json, t)
    default:
      throw new ImportFormatError(t('unrecognisedFile'))
  }
}
