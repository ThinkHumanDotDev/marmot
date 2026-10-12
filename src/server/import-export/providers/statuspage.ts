/**
 * Atlassian Statuspage → import plan (#120), read through the Manage API v1
 * (https://developer.statuspage.io, `https://api.statuspage.io/v1`, `Authorization: OAuth <key>`):
 *
 * - `GET /pages/{page_id}` → the status page (name, subdomain, custom domain, URLs)
 * - `GET /pages/{page_id}/components` → groups (`group: true`) and their components
 * - `GET /pages/{page_id}/incidents` → incidents with `incident_updates` and the per-update
 *   `affected_components` impacts; scheduled maintenances are incidents with `scheduled_for`
 * - `GET /pages/{page_id}/subscribers` → active subscribers (email, SMS, webhook)
 *
 * Lists are paginated with `page` / `per_page` (100 at most). Components become static
 * components (Statuspage has no monitors); impacts keep Statuspage's vocabulary, which Marmot's
 * component impacts are modelled on.
 */
import type { ImportResource } from '@/lib/import-export'
import { maskTarget } from '@/lib/status-page-subscribers'
import {
  isComponentImpact,
  isIncidentStatus,
  type ComponentImpact,
  type IncidentStatus,
} from '@/lib/incident-timeline'

import type { ImportText } from '../text'
import {
  asText,
  emptyPlan,
  isRecord,
  type ImportPlan,
  type PlannedIncident,
  type PlannedIncidentUpdate,
  type PlannedStatusPage,
  type PlannedStatusPageGroup,
} from '../types'
import {
  MAX_PAGES,
  ProviderError,
  providerClient,
  type FetchLike,
  type ProviderClient,
} from './fetch'
import {
  addSubscriber,
  hostnameOf,
  isoTime,
  notAfter,
  providerPageFields,
  type Credentials,
  type ImportProvider,
} from './shared'

export const STATUSPAGE_API = 'https://api.statuspage.io/v1'
const PER_PAGE = 100
const PAGE_ID = /^[a-z0-9]{1,64}$/i

type Json = Record<string, unknown>

export interface StatuspageSnapshot {
  page: Json
  components: Json[]
  incidents: Json[]
  subscribers: Json[]
}

async function list(client: ProviderClient, path: string): Promise<Json[]> {
  const items: Json[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const sep = path.includes('?') ? '&' : '?'
    const body = await client.get(`${path}${sep}page=${page}&per_page=${PER_PAGE}`)
    const batch = Array.isArray(body) ? body.filter(isRecord) : []
    items.push(...batch)
    if (!Array.isArray(body) || body.length < PER_PAGE) break
  }
  return items
}

const MAINTENANCE_STATUSES = new Set(['scheduled', 'in_progress', 'verifying', 'completed'])

const isMaintenance = (incident: Json): boolean =>
  incident.scheduled_for != null ||
  incident.impact === 'maintenance' ||
  MAINTENANCE_STATUSES.has(String(incident.status))

/** Statuspage's incident impact → the declared impact of a Marmot incident. */
const INCIDENT_IMPACT: Record<string, ComponentImpact> = {
  none: 'operational',
  minor: 'degraded_performance',
  major: 'partial_outage',
  critical: 'major_outage',
}

/** Component status → impact; `under_maintenance` is not an incident impact. */
const componentImpact = (status: unknown): ComponentImpact | null =>
  isComponentImpact(status) ? status : null

const updateStatus = (status: unknown): IncidentStatus =>
  status === 'postmortem' ? 'resolved' : isIncidentStatus(status) ? status : 'investigating'

function planIncident(
  incident: Json,
  componentKeys: Set<string>,
  t: ImportText,
  now: Date,
): PlannedIncident {
  const createdAt = isoTime(incident.created_at) ?? now.toISOString()
  const rows = (Array.isArray(incident.incident_updates) ? incident.incident_updates : [])
    .filter(isRecord)
    .map((update) => ({
      update,
      postedAt: isoTime(update.display_at) ?? isoTime(update.created_at) ?? createdAt,
    }))
    .sort((a, b) => a.postedAt.localeCompare(b.postedAt))
  const updates: PlannedIncidentUpdate[] = rows.map(({ update, postedAt }) => ({
    status: updateStatus(update.status),
    message: asText(update.body) ?? '',
    postedAt: notAfter(postedAt, now),
    components: (Array.isArray(update.affected_components) ? update.affected_components : [])
      .filter(isRecord)
      .flatMap((row) => {
        const key = `component:${asText(row.code)}`
        const impact = componentImpact(row.new_status)
        return componentKeys.has(key) && impact ? [{ componentKey: key, impact }] : []
      }),
  }))
  const status = updateStatus(incident.status)
  if (updates.length === 0) {
    updates.push({ status, message: '', postedAt: notAfter(createdAt, now), components: [] })
  }
  const active = status !== 'resolved'
  return {
    title: asText(incident.name) ?? t('unnamed', { kind: 'incident', id: String(incident.id) }),
    content: null,
    style: 'info',
    pinned: active,
    active,
    resolvedAt: null,
    impact: INCIDENT_IMPACT[String(incident.impact)] ?? 'operational',
    createdAt,
    updates,
  }
}

export const statuspageProvider: ImportProvider<StatuspageSnapshot> = {
  label: 'Atlassian Statuspage',

  async fetch(
    credentials: Credentials,
    resources: ReadonlySet<ImportResource>,
    fetchImpl: FetchLike,
  ) {
    const apiKey = credentials.apiKey?.trim()
    const pageId = credentials.pageId?.trim()
    if (!apiKey || !pageId || !PAGE_ID.test(pageId)) {
      throw new ProviderError('credentials')
    }
    const client = providerClient(fetchImpl, STATUSPAGE_API, { authorization: `OAuth ${apiKey}` })
    const base = `/pages/${encodeURIComponent(pageId)}`
    const page = await client.get(base)
    return {
      page: isRecord(page) ? page : {},
      components: await list(client, `${base}/components`),
      incidents:
        resources.has('incidents') || resources.has('maintenance')
          ? await list(client, `${base}/incidents`)
          : [],
      subscribers: resources.has('subscribers') ? await list(client, `${base}/subscribers`) : [],
    }
  },

  plan(snapshot, resources, t, now = new Date()) {
    const plan: ImportPlan = emptyPlan('statuspage')
    const title = asText(snapshot.page.name) ?? 'Statuspage'
    const page: PlannedStatusPage = {
      key: 'page',
      data: providerPageFields({
        title,
        slug: asText(snapshot.page.subdomain) ?? title,
        description: asText(snapshot.page.page_description),
        homepageUrl: asText(snapshot.page.url),
        contactUrl: asText(snapshot.page.support_url),
        bannerText: asText(snapshot.page.headline),
      }),
      domains: [hostnameOf(asText(snapshot.page.domain))].filter((d): d is string => Boolean(d)),
      groups: [],
      incidents: [],
    }

    // ---- Components: groups in position order, ungrouped components in a group of their own --
    const byPosition = (a: Json, b: Json) => Number(a.position ?? 0) - Number(b.position ?? 0)
    const components = [...snapshot.components].sort(byPosition)
    const groups = new Map<string, PlannedStatusPageGroup>()
    let ungrouped: PlannedStatusPageGroup | null = null
    for (const component of components) {
      if (component.group !== true) continue
      groups.set(String(component.id), {
        name: asText(component.name) ?? t('ungroupedComponents'),
        defaultOpen: true,
        monitors: [],
      })
    }
    const componentKeys = new Set<string>()
    for (const component of components) {
      if (component.group === true) continue
      const key = `component:${String(component.id)}`
      const row = {
        key,
        monitorKey: null,
        type: 'static' as const,
        name: asText(component.name) ?? key,
        description: asText(component.description),
        showValues: false,
        showChart: false,
        sendUrl: false,
        customUrl: null,
      }
      const group = component.group_id != null ? groups.get(String(component.group_id)) : undefined
      if (group) {
        group.monitors.push(row)
      } else {
        ungrouped ??= { name: t('ungroupedComponents'), defaultOpen: true, monitors: [] }
        ungrouped.monitors.push(row)
      }
      componentKeys.add(key)
    }
    page.groups = [...(ungrouped ? [ungrouped] : []), ...groups.values()].filter(
      (group) => group.monitors.length > 0,
    )

    const pageImported = resources.has('components')
    if (pageImported) {
      plan.statusPages.push(page)
      plan.warnings.push(t('pageUnpublished', { title: page.data.title }))
    }

    // ---- Incidents and scheduled maintenances --------------------------------------------------
    for (const incident of snapshot.incidents) {
      const name = asText(incident.name) ?? String(incident.id)
      if (isMaintenance(incident)) {
        if (!resources.has('maintenance')) continue
        const start = isoTime(incident.scheduled_for)
        const end = isoTime(incident.scheduled_until)
        if (!start || !end || end <= start) {
          plan.skipped.maintenance.push({ name, reason: t('maintenanceNoSchedule') })
        } else if (incident.status === 'completed' || new Date(end) <= now) {
          plan.skipped.maintenance.push({ name, reason: t('maintenanceFinished') })
        } else if (!pageImported) {
          plan.skipped.maintenance.push({ name, reason: t('requiresStatusPage') })
        } else {
          const updates = Array.isArray(incident.incident_updates)
            ? incident.incident_updates.filter(isRecord)
            : []
          plan.maintenance.push({
            key: `maintenance:${String(incident.id)}`,
            title: name,
            description: asText(updates[updates.length - 1]?.body) ?? asText(updates[0]?.body),
            start,
            end,
            statusPageKeys: [page.key],
            monitorKeys: [],
          })
        }
        continue
      }
      if (!resources.has('incidents')) continue
      if (!pageImported) {
        plan.skipped.incidents.push({ name, reason: t('requiresStatusPage') })
        continue
      }
      page.incidents.push(planIncident(incident, componentKeys, t, now))
    }

    // ---- Subscribers ---------------------------------------------------------------------------
    if (resources.has('subscribers')) {
      const seen = new Set<string>()
      for (const subscriber of snapshot.subscribers) {
        const mode = asText(subscriber.mode) ?? 'email'
        const email = asText(subscriber.email)
        const phone = asText(subscriber.display_phone_number) ?? asText(subscriber.phone_number)
        const label = email
          ? maskTarget('email', email)
          : phone
            ? maskTarget('sms', phone)
            : (asText(subscriber.id) ?? '?')
        if (!pageImported) {
          plan.skipped.subscribers.push({ name: label, reason: t('requiresStatusPage') })
          continue
        }
        if (subscriber.quarantined_at != null) {
          plan.skipped.subscribers.push({ name: label, reason: t('subscriberQuarantined') })
          continue
        }
        const ids = Array.isArray(subscriber.components) ? subscriber.components : []
        const keys = ids
          .map(
            (id) =>
              `component:${typeof id === 'object' && id ? String((id as Json).id) : String(id)}`,
          )
          .filter((key) => componentKeys.has(key))
        const componentKeysOf = keys.length > 0 ? keys : null
        if (mode === 'email') {
          addSubscriber(
            plan,
            page,
            seen,
            {
              channel: 'email',
              target: asText(subscriber.email) ?? '',
              componentKeys: componentKeysOf,
            },
            t,
          )
        } else if (mode === 'sms') {
          // Marmot stores E.164 numbers; Statuspage's `phone_number` is national, so the country
          // calling code comes from `display_phone_number` (or a number that already has it).
          const number = [asText(subscriber.phone_number), asText(subscriber.display_phone_number)]
            .map((value) => value?.replace(/[\s().-]/g, '') ?? '')
            .find((value) => value.startsWith('+'))
          addSubscriber(
            plan,
            page,
            seen,
            {
              channel: 'sms',
              target: number ?? '',
              componentKeys: componentKeysOf,
            },
            t,
          )
        } else if (mode === 'webhook') {
          addSubscriber(
            plan,
            page,
            seen,
            {
              channel: 'webhook',
              target: asText(subscriber.endpoint) ?? '',
              componentKeys: componentKeysOf,
            },
            t,
          )
        } else {
          plan.skipped.subscribers.push({
            name: label,
            reason: t('subscriberChannelUnsupported', { channel: mode }),
          })
        }
      }
    }
    return plan
  },
}
