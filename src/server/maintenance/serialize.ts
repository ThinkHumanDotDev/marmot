import type { Payload } from 'payload'

import type { OrgId } from '@/access/permissions'
import type { MaintenanceStatus, MaintenanceStrategy } from '@/lib/validation/maintenance'
import type { Maintenance } from '@/payload-types'
import {
  computeMaintenanceTimeslots,
  type MaintenanceTimeslots,
  type MaintenanceWindow,
} from './status'
import { getOrganizationTimezone } from './timezone'

export type { MaintenanceWindow }

/**
 * A maintenance as the UI and the realtime `maintenanceList` event see it: ids are strings, the
 * status and the current/next window are computed for "now".
 */
export interface MaintenanceSummary {
  id: string
  organizationId: string | null
  title: string
  description: string | null
  strategy: MaintenanceStrategy
  active: boolean
  status: MaintenanceStatus
  dateRange: { start: string | null; end: string | null }
  timeRange: { start: string | null; end: string | null }
  intervalDay: number
  weekdays: string[]
  daysOfMonth: string[]
  cron: string | null
  /** Minutes (cron strategy). */
  duration: number
  /** The stored option (`SAME_AS_SERVER` or an IANA zone). */
  timezone: string
  /** The zone the windows were computed in. */
  resolvedTimezone: string
  monitors: string[]
  statusPages: string[]
  current: MaintenanceWindow | null
  next: MaintenanceWindow | null
  createdAt: string
  updatedAt: string
}

export const relationId = (value: unknown): OrgId | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

const relationIds = (values: unknown[] | null | undefined): string[] =>
  (values ?? [])
    .map(relationId)
    .filter((id): id is OrgId => id !== null)
    .map(String)

export function toMaintenanceSummary(
  doc: Maintenance,
  timeslots: MaintenanceTimeslots,
): MaintenanceSummary {
  const organizationId = relationId(doc.organization)
  return {
    id: String(doc.id),
    organizationId: organizationId === null ? null : String(organizationId),
    title: doc.title,
    description: doc.description ?? null,
    strategy: doc.strategy,
    active: doc.active !== false,
    status: timeslots.status,
    dateRange: { start: doc.dateRange?.start ?? null, end: doc.dateRange?.end ?? null },
    timeRange: { start: doc.timeRange?.start ?? null, end: doc.timeRange?.end ?? null },
    intervalDay: doc.intervalDay ?? 1,
    weekdays: (doc.weekdays ?? []).map(String),
    daysOfMonth: (doc.daysOfMonth ?? []).map(String),
    cron: doc.cron ?? null,
    duration: doc.duration ?? 60,
    timezone: doc.timezone || 'SAME_AS_SERVER',
    resolvedTimezone: timeslots.timezone,
    monitors: relationIds(doc.monitors),
    statusPages: relationIds(doc.statusPages),
    current: timeslots.current,
    next: timeslots.next,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

/** Compute the timeslots of a document, resolving `SAME_AS_SERVER` through its organization. */
export async function timeslotsFor(
  payload: Payload,
  doc: Maintenance,
  now: Date = new Date(),
): Promise<MaintenanceTimeslots> {
  const serverTimezone = await getOrganizationTimezone(payload, relationId(doc.organization))
  return computeMaintenanceTimeslots(doc, now, { serverTimezone })
}

export async function summarizeMaintenance(
  payload: Payload,
  doc: Maintenance,
  now: Date = new Date(),
): Promise<MaintenanceSummary> {
  return toMaintenanceSummary(doc, await timeslotsFor(payload, doc, now))
}

export interface ListOptions {
  /** Request user for `overrideAccess: false` reads (route handlers, pages). */
  user?: Parameters<Payload['find']>[0]['user']
  overrideAccess?: boolean
  now?: Date
}

/** Sort: running first, then scheduled by next start, then the rest by title. */
const ORDER: Record<MaintenanceStatus, number> = {
  'under-maintenance': 0,
  scheduled: 1,
  unknown: 2,
  inactive: 3,
  ended: 4,
}

export function sortSummaries(items: MaintenanceSummary[]): MaintenanceSummary[] {
  return [...items].sort((a, b) => {
    const byStatus = ORDER[a.status] - ORDER[b.status]
    if (byStatus !== 0) return byStatus
    const aStart = a.current?.start ?? a.next?.start ?? ''
    const bStart = b.current?.start ?? b.next?.start ?? ''
    if (aStart !== bStart) return aStart < bStart ? -1 : 1
    return a.title.localeCompare(b.title)
  })
}

/** Every maintenance of an organization, summarised and sorted. */
export async function listOrgMaintenance(
  payload: Payload,
  orgId: OrgId,
  options: ListOptions = {},
): Promise<MaintenanceSummary[]> {
  const now = options.now ?? new Date()
  const { docs } = await payload.find({
    collection: 'maintenance',
    where: { organization: { equals: orgId } },
    depth: 0,
    limit: 0,
    pagination: false,
    sort: 'title',
    user: options.user,
    overrideAccess: options.overrideAccess ?? true,
  })
  const items = await Promise.all(
    (docs as Maintenance[]).map((doc) => summarizeMaintenance(payload, doc, now)),
  )
  return sortSummaries(items)
}
