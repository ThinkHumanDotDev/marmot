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
import type { Monitor } from '@/payload-types'
import type { MaintenanceResolver } from '@/server/engine/hooks'
import { relationId } from './serialize'

const log = childLogger('maintenance:resolver')

/** Groups nested deeper than this are ignored (guards against parent cycles). */
export const MAX_GROUP_DEPTH = 10

export interface ResolverOptions {
  /** The monitor document when the caller already has it (saves the first lookup). */
  monitor?: Pick<Monitor, 'id' | 'parent'> | null
}

/**
 * True when an active maintenance listing `monitorId` is running. Reads the persisted effective
 * status (`under-maintenance` exactly while one of its occurrences is in progress or verifying,
 * see `occurrences.ts`), so alert suppression follows the actual state: a window that was not
 * started yet does not suppress, one running past its end until completed does.
 */
export async function hasRunningMaintenance(
  payload: Payload,
  monitorId: string | number,
): Promise<boolean> {
  const { docs } = await payload.find({
    collection: 'maintenance',
    where: {
      and: [
        { active: { equals: true } },
        { status: { equals: 'under-maintenance' } },
        { monitors: { equals: monitorId } },
      ],
    },
    depth: 0,
    limit: 1,
    pagination: false,
    overrideAccess: true,
    select: { status: true },
  })
  return docs.length > 0
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
  const visited = new Set<string>()
  let current: Pick<Monitor, 'id' | 'parent'> | null =
    options.monitor && String(options.monitor.id) === String(monitorId)
      ? options.monitor
      : await loadMonitorRef(payload, monitorId)

  for (let depth = 0; current && depth <= MAX_GROUP_DEPTH; depth += 1) {
    const key = String(current.id)
    if (visited.has(key)) break
    visited.add(key)
    if (await hasRunningMaintenance(payload, current.id)) return true
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
