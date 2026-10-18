/**
 * The organization's time zone and first day of the week (`organizations.settings`), which cut SLA
 * periods, schedules and business hours (#274). Never throws: an unknown organization or zone falls
 * back to UTC weeks starting on Monday, the behaviour before #274.
 */
import type { Payload, PayloadRequest } from 'payload'

import { timeZoneOrDefault } from '@/i18n/formats'
import { UTC_ZONE, type SlaZone } from '@/lib/sla'
import type { Organization } from '@/payload-types'

type Id = string | number

export const slaZoneOf = (org: Pick<Organization, 'settings'> | null | undefined): SlaZone => ({
  timeZone: timeZoneOrDefault(org?.settings?.timezone),
  weekStart: org?.settings?.weekStart === 'sunday' ? 'sunday' : 'monday',
})

export async function loadSlaZone(
  payload: Payload,
  organization: Id | null | undefined,
  req?: PayloadRequest,
): Promise<SlaZone> {
  if (organization === null || organization === undefined || organization === '') return UTC_ZONE
  const doc = await payload
    .findByID({
      collection: 'organizations',
      id: organization,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
      select: { settings: true },
      ...(req ? { req } : {}),
    })
    .catch(() => null)
  return slaZoneOf(doc as Pick<Organization, 'settings'> | null)
}

/** Zones of several organizations, one lookup each. */
export async function loadSlaZones(
  payload: Payload,
  organizations: readonly (Id | null)[],
): Promise<Map<string, SlaZone>> {
  const ids = [...new Set(organizations.filter((id) => id !== null).map(String))]
  const entries = await Promise.all(
    ids.map(async (id) => {
      const original = organizations.find((org) => org !== null && String(org) === id) as Id
      return [id, await loadSlaZone(payload, original)] as const
    }),
  )
  return new Map(entries)
}
