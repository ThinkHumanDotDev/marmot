/**
 * "Is this monitor under maintenance right now?" for the polling engine.
 *
 * Port of `Monitor.isUnderMaintenance` from Uptime Kuma 2.x `server/model/monitor.js` (MIT License,
 * Copyright (c) 2021 Louis Lam, https://github.com/louislam/uptime-kuma): a monitor is under
 * maintenance when one of its active maintenances is, or when its parent group is (recursively).
 * See THIRD_PARTY_NOTICES.md.
 */
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import type { Maintenance, Monitor } from '@/payload-types'
import type { MaintenanceResolver } from '@/server/engine/hooks'
import { relationId } from './serialize'
import { getMaintenanceStatus } from './status'
import { getOrganizationTimezone } from './timezone'

const log = childLogger('maintenance:resolver')

/** Groups nested deeper than this are ignored (guards against parent cycles). */
export const MAX_GROUP_DEPTH = 10

export interface ResolverOptions {
  now?: Date
  /** The monitor document when the caller already has it (saves the first lookup). */
  monitor?: Pick<Monitor, 'id' | 'parent'> | null
}

/** Active maintenances that list `monitorId`; evaluated against `now`. */
export async function hasRunningMaintenance(
  payload: Payload,
  monitorId: string | number,
  now: Date,
): Promise<boolean> {
  const { docs } = await payload.find({
    collection: 'maintenance',
    where: { and: [{ active: { equals: true } }, { monitors: { equals: monitorId } }] },
    depth: 0,
    limit: 100,
    pagination: false,
    overrideAccess: true,
  })
  for (const doc of docs as Maintenance[]) {
    const serverTimezone = await getOrganizationTimezone(payload, relationId(doc.organization))
    if (getMaintenanceStatus(doc, now, { serverTimezone }) === 'under-maintenance') return true
  }
  return false
}

async function loadMonitorRef(
  payload: Payload,
  id: string | number,
): Promise<Pick<Monitor, 'id' | 'parent'> | null> {
  try {
    return await payload.findByID({
      collection: 'monitors',
      id,
      depth: 0,
      overrideAccess: true,
      select: { parent: true },
    })
  } catch {
    return null
  }
}

/**
 * True when the monitor, or any group above it, is inside a running maintenance window.
 */
export async function isMonitorUnderMaintenance(
  payload: Payload,
  monitorId: string | number,
  options: ResolverOptions = {},
): Promise<boolean> {
  const now = options.now ?? new Date()
  const visited = new Set<string>()
  let current: Pick<Monitor, 'id' | 'parent'> | null =
    options.monitor && String(options.monitor.id) === String(monitorId)
      ? options.monitor
      : await loadMonitorRef(payload, monitorId)

  for (let depth = 0; current && depth <= MAX_GROUP_DEPTH; depth += 1) {
    const key = String(current.id)
    if (visited.has(key)) break
    visited.add(key)
    if (await hasRunningMaintenance(payload, current.id, now)) return true
    const parentId = relationId(current.parent)
    if (parentId === null) break
    current = await loadMonitorRef(payload, parentId)
  }
  return false
}

/** Engine hook: `setMaintenanceResolver(createMaintenanceResolver())` in the worker. */
export function createMaintenanceResolver(): MaintenanceResolver {
  return async (monitor, payload) => {
    try {
      return await isMonitorUnderMaintenance(payload, monitor.id, { monitor })
    } catch (err) {
      log.error({ err, monitorId: monitor.id }, 'maintenance lookup failed; assuming none')
      return false
    }
  }
}
