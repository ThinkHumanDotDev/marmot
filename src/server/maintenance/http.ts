/**
 * Shared plumbing for the `/api/orgs/[orgId]/maintenance/**` route handlers; authentication and
 * authorisation come from `src/server/monitors/http.ts`.
 */
import type { Payload } from 'payload'

import type { MaintenanceFormValues } from '@/lib/validation/maintenance'
import type { Maintenance } from '@/payload-types'
import { parseId, relationId, type RequestUser, type RouteId } from '@/server/monitors/http'

/** Fields that are never copied from a request body. */
export const PROTECTED_MAINTENANCE_FIELDS = [
  'id',
  'organization',
  'status',
  'createdAt',
  'updatedAt',
] as const

/**
 * Loads a maintenance as the user, and only when it belongs to `orgId`. Returns `null` for
 * missing, foreign and forbidden documents alike so callers answer 404 without leaking existence.
 */
export async function loadOrgMaintenance(
  payload: Payload,
  user: RequestUser,
  orgId: RouteId,
  id: RouteId,
): Promise<Maintenance | null> {
  try {
    const doc = await payload.findByID({
      collection: 'maintenance',
      id,
      user,
      overrideAccess: false,
      depth: 0,
    })
    const owner = relationId(doc.organization)
    return owner !== null && String(owner) === String(orgId) ? doc : null
  } catch {
    return null
  }
}

/**
 * Validated form values → Local API data. Relationship ids arrive as strings from the browser and
 * must be numbers on Postgres/SQLite.
 */
export function toMaintenanceData(payload: Payload, values: MaintenanceFormValues) {
  const ids = (list: (string | number)[]) => list.map((id) => parseId(payload, String(id)))
  return {
    title: values.title,
    description: values.description,
    strategy: values.strategy,
    active: values.active,
    dateRange: values.dateRange,
    timeRange: values.timeRange,
    intervalDay: values.intervalDay,
    weekdays: values.weekdays,
    daysOfMonth: values.daysOfMonth,
    cron: values.cron,
    duration: values.duration,
    timezone: values.timezone,
    monitors: ids(values.monitors),
    statusPages: ids(values.statusPages),
    autoStart: values.autoStart,
    autoComplete: values.autoComplete,
    reminders: values.reminders,
  }
}
