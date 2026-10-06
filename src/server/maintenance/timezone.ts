import type { Payload, PayloadRequest } from 'payload'

import type { OrgId } from '@/access/permissions'
import { isValidTimezone, SAME_AS_SERVER } from '@/lib/validation/maintenance'
import { processTimezone } from './status'

const TTL_MS = 60_000
const cache = new Map<string, { value: string; expires: number }>()

/**
 * Zone a maintenance with `timezone: SAME_AS_SERVER` runs in: the organization's
 * `settings.timezone` (Uptime Kuma uses the instance timezone; Marmot's equivalent lives on the
 * organization), falling back to the process timezone. Cached for a minute: the engine asks on
 * every check.
 */
export async function getOrganizationTimezone(
  payload: Payload,
  orgId: OrgId | null | undefined,
  req?: PayloadRequest,
): Promise<string> {
  if (orgId === null || orgId === undefined) return processTimezone()
  const key = String(orgId)
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.value

  let value = processTimezone()
  try {
    const org = await payload.findByID({
      collection: 'organizations',
      id: orgId,
      depth: 0,
      overrideAccess: true,
      req,
      disableErrors: true,
    })
    const configured = org?.settings?.timezone?.trim()
    if (configured && configured !== SAME_AS_SERVER && isValidTimezone(configured)) {
      value = configured
    }
  } catch {
    // keep the process timezone
  }
  cache.set(key, { value, expires: Date.now() + TTL_MS })
  return value
}

/** Forget cached organization timezones (tests, organization settings updates). */
export function resetOrganizationTimezoneCache(orgId?: OrgId): void {
  if (orgId === undefined) cache.clear()
  else cache.delete(String(orgId))
}
