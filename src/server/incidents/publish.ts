/**
 * "Publish to status page": turns a monitor incident into a public status-page incident in one step.
 *
 * The status-page incident is created as the member (Local API, `overrideAccess: false`), so the
 * `incidents` collection's own access (`status-page:update`) and hooks apply exactly as when it is
 * written in the status page editor. Its first update names every component of the page that shows
 * the monitor; on a page without such a component it carries a declared impact instead. The monitor
 * incident keeps a link (`statusPageIncident`) and a `published` timeline entry. Public
 * communication stays deliberate: resolving the monitor incident does not post to the status page.
 */
import type { Payload } from 'payload'

import type { IncidentStatus } from '@/lib/incident-timeline'
import type { ComponentImpact } from '@/lib/status-page-components'
import type { Incident, Monitor, MonitorIncident, StatusPage } from '@/payload-types'
import { apiKeyOf, principalUserId } from '@/server/auth/request-auth'
import { apiError } from '@/server/errors'
import type { RequestUser } from '@/server/monitors/http'

import { publishIncident } from './realtime'
import { linkStatusPageIncident, relId, serializeIncident, type Id } from './store'

export interface PublishInput {
  statusPageId: Id
  title?: string
  message?: string
  status?: IncidentStatus
  impact?: ComponentImpact
}

/** Row ids of the page's components that mirror `monitorId`. */
export function monitorComponentIds(page: Pick<StatusPage, 'groups'>, monitorId: Id): string[] {
  const ids: string[] = []
  for (const group of page.groups ?? []) {
    for (const row of group.monitors ?? []) {
      if (row.type === 'static') continue
      const monitor = relId(row.monitor)
      if (row.id && monitor !== null && String(monitor) === String(monitorId)) ids.push(row.id)
    }
  }
  return ids
}

export async function publishToStatusPage(
  payload: Payload,
  user: RequestUser,
  incident: MonitorIncident,
  input: PublishInput,
) {
  if (relId(incident.statusPageIncident) !== null) throw apiError('incidentAlreadyPublished', 409)

  let page: StatusPage | null = null
  try {
    page = (await payload.findByID({
      collection: 'status-pages',
      id: input.statusPageId,
      depth: 0,
      user,
      overrideAccess: false,
    })) as StatusPage
  } catch {
    page = null
  }
  if (!page || String(relId(page.organization)) !== String(relId(incident.organization))) {
    throw apiError('statusPageNotFound', 404)
  }

  const monitorId = relId(incident.monitor)
  const monitor =
    monitorId === null
      ? null
      : ((await payload
          .findByID({ collection: 'monitors', id: monitorId, depth: 0, overrideAccess: true })
          .catch(() => null)) as Monitor | null)
  const impact: ComponentImpact = input.impact ?? 'major_outage'
  const components =
    monitorId === null
      ? []
      : monitorComponentIds(page, monitorId).map((component) => ({ component, impact }))
  const title =
    input.title?.trim() || monitor?.publicName?.trim() || monitor?.name?.trim() || page.title

  const created = (await payload.create({
    collection: 'incidents',
    depth: 0,
    user,
    overrideAccess: false,
    data: {
      title: title.slice(0, 200),
      statusPage: page.id,
      organization: relId(page.organization) as Incident['organization'],
      ...(components.length === 0 ? { impact } : {}),
      updates: [
        {
          status: input.status ?? 'investigating',
          message: input.message?.trim() ?? '',
          components,
        },
      ] as Incident['updates'],
    },
  })) as Incident

  const updated = await linkStatusPageIncident(payload, incident, created, {
    userId: principalUserId(user),
    via: apiKeyOf(user) ? 'api' : 'dashboard',
  })
  const summary =
    (await publishIncident(payload, updated)) ?? (await serializeIncident(payload, updated))
  return { incident: summary, statusPageIncident: created }
}
