/**
 * Instatus → import plan (#283), read through the public API (https://instatus.com/help/api,
 * `https://api.instatus.com`, `Authorization: Bearer <key>`):
 *
 * - `GET /v2/pages` → the status pages of the key's workspace (name, subdomain, custom domain,
 *   website URL, public email, Google Analytics ID, global CSS)
 * - `GET /v2/{page_id}/components` → components; a component's `group` (or `groupId`) names its
 *   group, and groups themselves are listed with `isParent: true`
 * - `GET /v1/{page_id}/incidents` → incidents with their `updates` and affected `components`
 * - `GET /v2/{page_id}/maintenances` → maintenances (`start`, `end` or `duration` in minutes)
 * - `GET /v2/{page_id}/subscribers` → subscribers (email, phone, webhook; `all` or `components`)
 *
 * Lists are paginated with `page` / `per_page` (100 at most). Instatus has no monitors: components
 * become static components. Statuses are upper-case (`MAJOROUTAGE`); they map onto Marmot's
 * Statuspage-style impacts.
 */
import type { ImportResource } from '@/lib/import-export'
import type { ComponentImpact, IncidentStatus } from '@/lib/incident-timeline'
import { isHttpUrl } from '@/lib/status-page-components'
import { maskTarget } from '@/lib/status-page-subscribers'

import type { ImportText } from '../text'
import {
  asBool,
  asInt,
  asKey,
  asText,
  emptyPlan,
  isRecord,
  type ImportPlan,
  type PlannedIncident,
  type PlannedIncidentUpdate,
  type PlannedStatusPage,
  type PlannedStatusPageComponent,
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

export const INSTATUS_API = 'https://api.instatus.com'
const PER_PAGE = 100
/** Page IDs are cuids; a subdomain is accepted as well. */
const PAGE_ID = /^[a-z0-9-]{1,64}$/i

type Json = Record<string, unknown>

export interface InstatusPage {
  page: Json
  components: Json[]
  incidents: Json[]
  maintenances: Json[]
  subscribers: Json[]
}

export interface InstatusSnapshot {
  pages: InstatusPage[]
}

/** The list in a response: a bare array, or the first array of a wrapper object. */
function itemsOf(body: unknown): Json[] {
  if (Array.isArray(body)) return body.filter(isRecord)
  if (isRecord(body)) {
    const list = Array.isArray(body.data) ? body.data : Object.values(body).find(Array.isArray)
    if (list) return list.filter(isRecord)
    return []
  }
  throw new ProviderError('invalidResponse')
}

async function list(client: ProviderClient, path: string): Promise<Json[]> {
  const items: Json[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = itemsOf(await client.get(`${path}?page=${page}&per_page=${PER_PAGE}`))
    items.push(...batch)
    if (batch.length < PER_PAGE) break
  }
  return items
}

/** Names may come translated (`{ en: "API" }`); the first non-empty text wins. */
function textOf(value: unknown): string | null {
  if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      const text = asText(entry)
      if (text) return text
    }
    return null
  }
  return asText(value)
}

/** Component status → impact; `UNDERMAINTENANCE` is not an incident impact. */
const IMPACTS: Record<string, ComponentImpact> = {
  OPERATIONAL: 'operational',
  DEGRADEDPERFORMANCE: 'degraded_performance',
  PARTIALOUTAGE: 'partial_outage',
  MINOROUTAGE: 'partial_outage',
  MAJOROUTAGE: 'major_outage',
}
const IMPACT_ORDER: ComponentImpact[] = [
  'operational',
  'degraded_performance',
  'partial_outage',
  'major_outage',
]

const impactOf = (status: unknown): ComponentImpact | null =>
  IMPACTS[String(status ?? '').toUpperCase()] ?? null

const STATUSES: Record<string, IncidentStatus> = {
  INVESTIGATING: 'investigating',
  IDENTIFIED: 'identified',
  MONITORING: 'monitoring',
  RESOLVED: 'resolved',
}

const statusOf = (status: unknown): IncidentStatus =>
  STATUSES[String(status ?? '').toUpperCase()] ?? 'investigating'

/** Id of a related component given as an id or an object with `id`. */
const idOf = (value: unknown): string | null => (isRecord(value) ? asKey(value.id) : asKey(value))

/** Impacts of `rows` (`[{ id, status }]`) on the imported components. */
const impactsOf = (rows: unknown, componentKeys: Set<string>) =>
  (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const id = isRecord(row) ? asKey(row.id) : null
    const componentKey = `component:${id}`
    const impact = isRecord(row) ? impactOf(row.status) : null
    return id && componentKeys.has(componentKey) && impact ? [{ componentKey, impact }] : []
  })

function planIncident(
  incident: Json,
  componentKeys: Set<string>,
  t: ImportText,
  now: Date,
): PlannedIncident {
  const createdAt = isoTime(incident.started) ?? isoTime(incident.createdAt) ?? now.toISOString()
  const status = statusOf(incident.status)
  const affected = impactsOf(incident.components, componentKeys)
  const timeline: PlannedIncidentUpdate[] = (
    Array.isArray(incident.updates) ? incident.updates : []
  )
    .filter(isRecord)
    .map((update) => ({
      status: statusOf(update.status),
      message: asText(update.markdown) ?? asText(update.message) ?? '',
      postedAt: notAfter(isoTime(update.started) ?? isoTime(update.createdAt) ?? createdAt, now),
      // Updates may carry the component statuses they set (`statuses`, as they are posted).
      components: impactsOf(update.statuses ?? update.components, componentKeys),
    }))
    .sort((a, b) => a.postedAt.localeCompare(b.postedAt))
  if (timeline.length === 0) {
    timeline.push({
      status,
      message: '',
      postedAt: notAfter(createdAt, now),
      components: [],
    })
  }
  // Without per-update statuses, the incident's affected components belong to its first update.
  if (timeline.every((update) => update.components.length === 0)) {
    timeline[0] = { ...timeline[0], components: affected }
  }
  const resolvedAt = isoTime(incident.resolved)
  if (status === 'resolved' && timeline[timeline.length - 1].status !== 'resolved') {
    const last = timeline[timeline.length - 1]
    // The resolution puts every component the incident touched back to operational.
    const touched = [
      ...new Set(timeline.flatMap((update) => update.components.map((row) => row.componentKey))),
    ]
    timeline.push({
      status: 'resolved',
      message: '',
      postedAt: notAfter(
        resolvedAt && resolvedAt >= last.postedAt ? resolvedAt : last.postedAt,
        now,
      ),
      components: touched.map((componentKey) => ({ componentKey, impact: 'operational' })),
    })
  }
  const worst = timeline
    .flatMap((update) => update.components.map((row) => row.impact))
    .reduce<ComponentImpact | null>(
      (max, impact) =>
        max === null || IMPACT_ORDER.indexOf(impact) > IMPACT_ORDER.indexOf(max) ? impact : max,
      null,
    )
  const active = status !== 'resolved'
  return {
    title: textOf(incident.name) ?? t('unnamed', { kind: 'incident', id: String(incident.id) }),
    content: null,
    style: 'info',
    pinned: active,
    active,
    resolvedAt: null,
    impact: worst && worst !== 'operational' ? worst : 'partial_outage',
    createdAt,
    updates: timeline,
  }
}

/** End of a maintenance: `end`, or `start` plus `duration` minutes. */
function maintenanceEnd(maintenance: Json, start: string | null): string | null {
  const end = isoTime(maintenance.end) ?? isoTime(maintenance.ended)
  if (end) return end
  const minutes = asInt(maintenance.duration)
  if (!start || minutes === null || minutes <= 0) return null
  return new Date(new Date(start).getTime() + minutes * 60_000).toISOString()
}

const GOOGLE_ANALYTICS_ID = /^(G|UA|AW|DC)-[A-Z0-9-]+$/i

/** Subscription channels Marmot has no equivalent for, by the field Instatus fills. */
const OTHER_CHANNELS = ['slack', 'discord', 'teams', 'googlechat', 'mattermost'] as const

function planPage(
  plan: ImportPlan,
  source: InstatusPage,
  resources: ReadonlySet<ImportResource>,
  t: ImportText,
  now: Date,
): void {
  const title = textOf(source.page.name) ?? asText(source.page.subdomain) ?? 'Instatus'
  const website = asText(source.page.websiteUrl)
  const email = asText(source.page.publicEmail)
  const analytics = asText(source.page.googleAnalytics)
  const page: PlannedStatusPage = {
    key: `page:${String(source.page.id)}`,
    data: providerPageFields({
      title,
      slug: asText(source.page.subdomain) ?? title,
      homepageUrl: website && isHttpUrl(website) ? website : null,
      contactUrl: email && /^[^\s@]+@[^\s@]+$/.test(email) ? `mailto:${email}` : null,
      customCSS: asText(source.page.cssGlobal),
      googleAnalyticsId: analytics && GOOGLE_ANALYTICS_ID.test(analytics) ? analytics : null,
    }),
    domains: [hostnameOf(asText(source.page.customDomain))].filter((d): d is string => Boolean(d)),
    groups: [],
    incidents: [],
  }

  // ---- Components: groups in order, ungrouped components first in a group of their own --------
  const byOrder = (a: Json, b: Json) => Number(a.order ?? 0) - Number(b.order ?? 0)
  const components = [...source.components].sort(byOrder)
  const groups = new Map<string, PlannedStatusPageGroup>()
  const groupIdOf = (component: Json): string | null =>
    idOf(component.group) ?? asKey(component.groupId)
  for (const component of components) {
    const parent = component.isParent === true || component.grouped === true
    const id = asKey(component.id)
    if (parent && id && !groups.has(id)) {
      groups.set(id, { name: textOf(component.name) ?? title, defaultOpen: true, monitors: [] })
    }
  }
  // Groups only referenced from their components (no `isParent` row in the list).
  for (const component of components) {
    const groupId = groupIdOf(component)
    if (groupId && !groups.has(groupId)) {
      const name = isRecord(component.group) ? textOf(component.group.name) : null
      groups.set(groupId, { name: name ?? title, defaultOpen: true, monitors: [] })
    }
  }
  let ungrouped: PlannedStatusPageGroup | null = null
  const componentKeys = new Set<string>()
  for (const component of components) {
    const id = asKey(component.id)
    if (!id || groups.has(id)) continue
    const key = `component:${id}`
    const row: PlannedStatusPageComponent = {
      key,
      monitorKey: null,
      type: 'static',
      name: textOf(component.name) ?? key,
      description: textOf(component.description),
      showValues: false,
      showChart: false,
      sendUrl: false,
      customUrl: null,
    }
    const groupId = groupIdOf(component)
    const group = groupId ? groups.get(groupId) : undefined
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

  // ---- Incidents --------------------------------------------------------------------------------
  if (resources.has('incidents')) {
    for (const incident of source.incidents) {
      if (!pageImported) {
        const name = textOf(incident.name) ?? String(incident.id)
        plan.skipped.incidents.push({ name, reason: t('requiresStatusPage') })
        continue
      }
      page.incidents.push(planIncident(incident, componentKeys, t, now))
    }
  }

  // ---- Maintenances -----------------------------------------------------------------------------
  if (resources.has('maintenance')) {
    for (const maintenance of source.maintenances) {
      const name = textOf(maintenance.name) ?? String(maintenance.id)
      const start = isoTime(maintenance.start) ?? isoTime(maintenance.started)
      const end = maintenanceEnd(maintenance, start)
      const status = String(maintenance.status ?? '').toUpperCase()
      if (!start || !end || end <= start) {
        plan.skipped.maintenance.push({ name, reason: t('maintenanceNoSchedule') })
      } else if (status === 'COMPLETED' || new Date(end) <= now) {
        plan.skipped.maintenance.push({ name, reason: t('maintenanceFinished') })
      } else if (!pageImported) {
        plan.skipped.maintenance.push({ name, reason: t('requiresStatusPage') })
      } else {
        const updates = (Array.isArray(maintenance.updates) ? maintenance.updates : []).filter(
          isRecord,
        )
        const first = updates[0]
        plan.maintenance.push({
          key: `maintenance:${String(maintenance.id)}`,
          title: name,
          description:
            asText(maintenance.message) ??
            (first ? (asText(first.markdown) ?? asText(first.message)) : null),
          start,
          end,
          statusPageKeys: [page.key],
          monitorKeys: [],
        })
      }
    }
  }

  // ---- Subscribers ------------------------------------------------------------------------------
  if (resources.has('subscribers')) {
    const seen = new Set<string>()
    for (const subscriber of source.subscribers) {
      const email = asText(subscriber.email)
      const phone = asText(subscriber.phone)
      const webhook = asText(subscriber.webhook)
      const label = webhook
        ? maskTarget('webhook', webhook)
        : phone
          ? maskTarget('sms', phone)
          : email
            ? maskTarget('email', email)
            : (asKey(subscriber.id) ?? '?')
      if (!pageImported) {
        plan.skipped.subscribers.push({ name: label, reason: t('requiresStatusPage') })
        continue
      }
      if (asBool(subscriber.confirmed) === false) {
        plan.skipped.subscribers.push({ name: label, reason: t('subscriberUnconfirmed') })
        continue
      }
      const keys = (Array.isArray(subscriber.components) ? subscriber.components : [])
        .map((component) => `component:${idOf(component)}`)
        .filter((key) => componentKeys.has(key))
      const componentKeysOf = subscriber.all === false && keys.length > 0 ? keys : null
      if (webhook) {
        addSubscriber(
          plan,
          page,
          seen,
          { channel: 'webhook', target: webhook, componentKeys: componentKeysOf },
          t,
        )
      } else if (phone) {
        addSubscriber(
          plan,
          page,
          seen,
          {
            channel: 'sms',
            target: phone.replace(/[\s().-]/g, ''),
            componentKeys: componentKeysOf,
          },
          t,
        )
      } else if (email) {
        addSubscriber(
          plan,
          page,
          seen,
          { channel: 'email', target: email, componentKeys: componentKeysOf },
          t,
        )
      } else {
        const channel = OTHER_CHANNELS.find((name) => subscriber[name] != null) ?? 'unknown'
        plan.skipped.subscribers.push({
          name: label,
          reason: t('subscriberChannelUnsupported', { channel }),
        })
      }
    }
  }
}

export const instatusProvider: ImportProvider<InstatusSnapshot> = {
  label: 'Instatus',

  async fetch(
    credentials: Credentials,
    resources: ReadonlySet<ImportResource>,
    fetchImpl: FetchLike,
  ) {
    const apiKey = credentials.apiKey?.trim()
    const pageId = credentials.pageId?.trim() || null
    if (!apiKey || (pageId !== null && !PAGE_ID.test(pageId))) {
      throw new ProviderError('credentials')
    }
    const client = providerClient(fetchImpl, INSTATUS_API, { authorization: `Bearer ${apiKey}` })
    const all = await list(client, '/v2/pages')
    const chosen = pageId
      ? all.filter((page) => asKey(page.id) === pageId || asText(page.subdomain) === pageId)
      : all
    if (pageId && chosen.length === 0) throw new ProviderError('notFound', 404)

    const pages: InstatusPage[] = []
    for (const page of chosen) {
      const id = asKey(page.id)
      if (!id) continue
      const base = encodeURIComponent(id)
      pages.push({
        page,
        // Components are read for every import: incidents and subscribers refer to them.
        components: await list(client, `/v2/${base}/components`),
        incidents: resources.has('incidents') ? await list(client, `/v1/${base}/incidents`) : [],
        maintenances: resources.has('maintenance')
          ? await list(client, `/v2/${base}/maintenances`)
          : [],
        subscribers: resources.has('subscribers')
          ? await list(client, `/v2/${base}/subscribers`)
          : [],
      })
    }
    return { pages }
  },

  plan(snapshot, resources, t, now = new Date()) {
    const plan: ImportPlan = emptyPlan('instatus')
    for (const source of snapshot.pages) planPage(plan, source, resources, t, now)
    return plan
  },
}
