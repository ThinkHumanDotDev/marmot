/**
 * Bulk actions of the monitor list (#124), shared by the route handler
 * (`POST /api/orgs/:orgId/monitors/bulk`), the OpenAPI document and the list UI. Client-safe.
 */
import type { RealtimeMonitor } from '@/server/realtime/events'

export const MONITOR_BULK_ACTIONS = [
  'pause',
  'resume',
  'check',
  'delete',
  'addTags',
  'removeTags',
  'addNotifications',
  'removeNotifications',
] as const
export type MonitorBulkAction = (typeof MONITOR_BULK_ACTIONS)[number]

/** Most monitors one bulk request may name. */
export const MAX_BULK_MONITORS = 500

/** Actions that need `monitor:delete`; every other one needs `monitor:update`. */
export const bulkActionPermission = (action: MonitorBulkAction) =>
  action === 'delete' ? ('monitor:delete' as const) : ('monitor:update' as const)

/**
 * Why one monitor of a bulk request was not changed: not in the organization (or not visible to
 * the caller), not applicable to the action (`check` of a paused or push monitor), over the
 * organization's on-demand check budget, or a write that failed (validation, plan limit, …).
 */
export type BulkErrorCode = 'notFound' | 'notApplicable' | 'rateLimited' | 'failed'

export type BulkResult =
  | {
      id: string
      ok: true
      /** Nothing to do: the monitor was already in the requested state. */
      unchanged?: boolean
      /** The monitor after the change (absent for `delete` and `check`). */
      monitor?: RealtimeMonitor
    }
  | { id: string; ok: false; error: BulkErrorCode; message: string }

export interface BulkResponse {
  action: MonitorBulkAction
  results: BulkResult[]
  /** `changed`: monitors written (or checks queued); `unchanged`: already as requested. */
  summary: { changed: number; unchanged: number; failed: number }
}
