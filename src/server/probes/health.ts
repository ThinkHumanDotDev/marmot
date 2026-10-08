/**
 * Offline detection of probe locations (#91). The `probe-health` job (every 15 s on the worker's
 * `marmot:maintenance` queue, whose single concurrency-1 consumer makes it the only writer of
 * `locations.status`) derives each location's status from `lastSeenAt`:
 *
 *   never seen                          → unknown
 *   seen within PROBE_OFFLINE_AFTER     → online
 *   silent for longer                   → offline
 *
 * Each change to `offline`, and each return to `online` after being offline, emails the
 * organization's owners and admins (in the organization's language and time zone).
 */
import type { Payload } from 'payload'

import { env } from '@/env'
import { getStaticFormatter } from '@/i18n/translator'
import { childLogger } from '@/lib/logger'
import type { LocationStatus } from '@/lib/probe-locations'
import type { Location, Organization } from '@/payload-types'
import { getOrganizationI18n, serverTranslator } from '@/server/i18n'
import { listOrgMembers } from '@/server/members'
import { serverUrl } from '@/server/status-pages/urls'

const log = childLogger('probes:health')

export const PROBE_HEALTH_JOB_NAME = 'probe-health'
export const PROBE_HEALTH_INTERVAL_MS = 15_000

type Id = string | number

const relationId = (value: unknown): Id | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return (value as { id?: Id }).id ?? null
  return value as Id
}

/** Status of a location at `now` from its `lastSeenAt` (pure, for the job and the tests). */
export function locationStatusAt(
  location: Pick<Location, 'lastSeenAt'>,
  now: Date,
  offlineAfterSeconds: number = env.PROBE_OFFLINE_AFTER,
): LocationStatus {
  if (!location.lastSeenAt) return 'unknown'
  const age = now.getTime() - new Date(location.lastSeenAt).getTime()
  return age <= offlineAfterSeconds * 1000 ? 'online' : 'offline'
}

export interface LocationNotice {
  kind: 'offline' | 'online'
  location: Pick<Location, 'id' | 'name' | 'slug' | 'lastSeenAt'>
  /** When the status changed. */
  at: Date
  /** `online`: when the location went offline. */
  offlineSince?: string | null
}

export type LocationNoticeDeliverer = (payload: Payload, notice: LocationNotice) => Promise<void>

/** Subject and plain-text body of a notice. */
export function renderLocationNotice(
  notice: LocationNotice,
  {
    locale,
    timeZone,
    organizationName,
    settingsUrl,
  }: {
    locale: Parameters<typeof serverTranslator>[0]
    timeZone: string
    organizationName: string
    settingsUrl: string
  },
): { subject: string; text: string } {
  const t = serverTranslator(locale)
  const format = getStaticFormatter(locale, timeZone)
  const values = {
    location: notice.location.name,
    organization: organizationName,
    time: format.dateTime(notice.at, 'zoned'),
    lastSeen: notice.location.lastSeenAt
      ? format.dateTime(new Date(notice.location.lastSeenAt), 'zoned')
      : '—',
    minutes: notice.offlineSince
      ? Math.max(0, Math.round((notice.at.getTime() - Date.parse(notice.offlineSince)) / 60_000))
      : 0,
  }
  const prefix =
    notice.kind === 'offline' ? 'email.probeLocation.offline' : 'email.probeLocation.online'
  return {
    subject: t(`${prefix}Subject`, values),
    text: `${t(`${prefix}Text`, values)}\n\n${t('email.probeLocation.action')} ${settingsUrl}`,
  }
}

/** Default delivery: an email to every owner and admin of the location's organization. */
export const emailLocationAdmins =
  (organizationId: Id): LocationNoticeDeliverer =>
  async (payload, notice) => {
    const organization = (await payload.findByID({
      collection: 'organizations',
      id: organizationId,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
    })) as Organization | null
    if (!organization) return
    const { locale, timeZone } = await getOrganizationI18n(payload, organization)
    const members = await listOrgMembers(payload, organizationId, { overrideAccess: true })
    const settingsUrl = `${serverUrl()}/${organization.slug}/settings/locations`
    const { subject, text } = renderLocationNotice(notice, {
      locale,
      timeZone,
      organizationName: organization.name,
      settingsUrl,
    })
    for (const member of members.filter((m) => m.role === 'owner' || m.role === 'admin')) {
      try {
        await payload.sendEmail({ to: member.email, subject, text })
      } catch (err) {
        log.error({ err, locationId: notice.location.id }, 'cannot send the location notice')
      }
    }
  }

export interface RefreshLocationsResult {
  checked: number
  changed: { id: string; from: LocationStatus; to: LocationStatus }[]
}

/**
 * Re-derive every location's status at `now`, persist the changes and deliver a notice for each
 * `offline` change and each `offline → online` recovery.
 */
export async function refreshLocationStatuses(
  payload: Payload,
  now: Date = new Date(),
  options: {
    deliver?: (organizationId: Id) => LocationNoticeDeliverer
    offlineAfterSeconds?: number
  } = {},
): Promise<RefreshLocationsResult> {
  const { docs } = await payload.find({
    collection: 'locations',
    depth: 0,
    limit: 0,
    pagination: false,
    overrideAccess: true,
    select: {
      organization: true,
      name: true,
      slug: true,
      status: true,
      statusChangedAt: true,
      lastSeenAt: true,
    },
  })
  const deliver = options.deliver ?? emailLocationAdmins
  const changed: RefreshLocationsResult['changed'] = []

  for (const location of docs as Location[]) {
    const from = (location.status ?? 'unknown') as LocationStatus
    const to = locationStatusAt(location, now, options.offlineAfterSeconds)
    if (from === to) continue
    try {
      await payload.update({
        collection: 'locations',
        id: location.id,
        data: { status: to, statusChangedAt: now.toISOString() },
        depth: 0,
        overrideAccess: true,
      })
    } catch (err) {
      log.error({ err, locationId: location.id }, 'failed to update the location status')
      continue
    }
    changed.push({ id: String(location.id), from, to })
    log[to === 'offline' ? 'warn' : 'info'](
      { locationId: location.id, name: location.name, from, to },
      `probe location ${to}`,
    )

    const organizationId = relationId(location.organization)
    const notify = to === 'offline' || (to === 'online' && from === 'offline')
    if (!notify || organizationId === null) continue
    try {
      await deliver(organizationId)(payload, {
        kind: to === 'offline' ? 'offline' : 'online',
        location,
        at: now,
        offlineSince: from === 'offline' ? (location.statusChangedAt ?? null) : null,
      })
    } catch (err) {
      log.error({ err, locationId: location.id }, 'failed to deliver the location notice')
    }
  }
  return { checked: docs.length, changed }
}
