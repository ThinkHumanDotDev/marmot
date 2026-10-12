/**
 * Better Stack (Uptime) → import plan (#120), read through the Uptime API v2
 * (https://betterstack.com/docs/uptime/api/, `https://uptime.betterstack.com/api/v2`,
 * `Authorization: Bearer <token>`). Responses are JSON:API documents (`{ data, pagination }`);
 * lists follow `pagination.next`.
 *
 * - `GET /monitors` → monitors (HTTP status / expected status code / keyword / ping / TCP)
 * - `GET /status-pages[/{id}]` → status pages; per page `/sections` (groups), `/resources`
 *   (components, linked to monitors), `/status-reports` and per report `/status-updates`
 *   (incidents; reports of type `maintenance` become maintenance windows)
 *
 * Heartbeats, monitor groups, escalation policies and on-call settings are not imported.
 */
import type { ImportResource } from '@/lib/import-export'
import type { ComponentImpact } from '@/lib/incident-timeline'
import {
  defaultMonitorValues,
  HTTP_METHODS,
  isValidStatusCodeRange,
  MIN_INTERVAL_SECONDS,
  type MonitorFormInput,
  type MonitorTypeName,
} from '@/lib/validation/monitor'
import { monitorFormSchema } from '@/lib/validation/monitor-schema'

import type { ImportText } from '../text'
import {
  asBool,
  asInt,
  asKey,
  asNumber,
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
  hostnameOf,
  isoTime,
  issueList,
  notAfter,
  providerPageFields,
  type Credentials,
  type ImportProvider,
} from './shared'

export const BETTERSTACK_API = 'https://uptime.betterstack.com/api/v2'
const ID = /^[0-9a-z_-]{1,64}$/i

type Json = Record<string, unknown>

/** A JSON:API resource flattened to `{ id, ...attributes }`. */
type Item = Json & { id: string }

export interface BetterStackReport {
  report: Item
  updates: Item[]
}

export interface BetterStackPage {
  page: Item
  sections: Item[]
  resources: Item[]
  reports: BetterStackReport[]
}

export interface BetterStackSnapshot {
  monitors: Item[]
  statusPages: BetterStackPage[]
}

const flatten = (value: unknown): Item | null => {
  if (!isRecord(value)) return null
  const id = asKey(value.id)
  if (id === null) return null
  return { ...(isRecord(value.attributes) ? value.attributes : {}), id }
}

async function list(client: ProviderClient, path: string): Promise<Item[]> {
  const items: Item[] = []
  let next: string | null = path
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const body = await client.get(next)
    if (!isRecord(body)) throw new ProviderError('invalidResponse')
    const data = Array.isArray(body.data) ? body.data : []
    items.push(...data.map(flatten).filter((item): item is Item => item !== null))
    next = isRecord(body.pagination) ? asText(body.pagination.next) : null
  }
  return items
}

async function one(client: ProviderClient, path: string): Promise<Item> {
  const body = await client.get(path)
  const item = isRecord(body) ? flatten(body.data) : null
  if (!item) throw new ProviderError('invalidResponse')
  return item
}

// ---- Monitors -----------------------------------------------------------------------------------

/** Better Stack monitor types Marmot has an equivalent for. */
const MONITOR_TYPES: Record<string, MonitorTypeName> = {
  status: 'http',
  expected_status_code: 'http',
  keyword: 'keyword',
  keyword_absence: 'keyword',
  ping: 'ping',
  tcp: 'port',
}

const UNSUPPORTED_LABELS: Record<string, string> = {
  udp: 'UDP',
  smtp: 'SMTP',
  pop: 'POP3',
  imap: 'IMAP',
  dns: 'DNS',
  playwright: 'Playwright',
}

function headersJson(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const entries = value.filter(isRecord).flatMap((row) => {
    const name = asText(row.name)
    return name ? [[name, asText(row.value) ?? ''] as const] : []
  })
  return entries.length > 0 ? JSON.stringify(Object.fromEntries(entries)) : null
}

function mapMonitor(
  raw: Item,
  warnings: string[],
  t: ImportText,
): { input: MonitorFormInput } | { skip: string } {
  const sourceType = asText(raw.monitor_type) ?? 'status'
  const type = MONITOR_TYPES[sourceType]
  if (!type) {
    return {
      skip: t('monitorTypeUnsupported', { type: UNSUPPORTED_LABELS[sourceType] ?? sourceType }),
    }
  }
  const defaults = defaultMonitorValues(type)
  const name = asText(raw.pronounceable_name) ?? asText(raw.url) ?? raw.id
  const target = asText(raw.url)

  let interval = asInt(raw.check_frequency) ?? defaults.interval
  if (interval < MIN_INTERVAL_SECONDS) {
    warnings.push(
      t('intervalRaised', { name, field: 'interval', value: interval, min: MIN_INTERVAL_SECONDS }),
    )
    interval = MIN_INTERVAL_SECONDS
  }
  // `request_timeout` is in seconds, except for ping and TCP monitors (milliseconds).
  const rawTimeout = asNumber(raw.request_timeout)
  const timeout =
    rawTimeout === null
      ? defaults.timeout
      : type === 'ping' || type === 'port'
        ? Math.max(1, Math.round(rawTimeout / 1000))
        : rawTimeout

  let acceptedStatusCodes = defaults.acceptedStatusCodes
  if (sourceType === 'expected_status_code' && Array.isArray(raw.expected_status_codes)) {
    const codes = raw.expected_status_codes
      .map((code) => String(code))
      .filter(isValidStatusCodeRange)
    if (codes.length > 0) acceptedStatusCodes = codes
  }
  const method = asText(raw.http_method)?.toUpperCase()

  return {
    input: {
      ...defaults,
      name,
      type,
      active: !(asBool(raw.paused) ?? false),
      url: type === 'http' || type === 'keyword' ? target : null,
      hostname: type === 'ping' || type === 'port' ? target : null,
      port: type === 'port' ? (asInt(raw.port) ?? defaults.port) : defaults.port,
      interval,
      retryInterval: interval,
      timeout: Math.min(timeout, interval),
      method: (HTTP_METHODS as readonly string[]).includes(method ?? '')
        ? (method as MonitorFormInput['method'])
        : defaults.method,
      body: asText(raw.request_body),
      headers: headersJson(raw.request_headers),
      acceptedStatusCodes,
      maxRedirects: asBool(raw.follow_redirects) === false ? 0 : defaults.maxRedirects,
      ignoreTls: asBool(raw.verify_ssl) === false,
      expiryNotification: raw.ssl_expiration != null,
      domainExpiryNotification: raw.domain_expiration != null,
      keyword: type === 'keyword' ? asText(raw.required_keyword) : null,
      invertKeyword: sourceType === 'keyword_absence',
    },
  }
}

// ---- Status reports -----------------------------------------------------------------------------

/** Status of an affected resource → component impact (`maintenance` is not an impact). */
const RESOURCE_IMPACT: Record<string, ComponentImpact> = {
  resolved: 'operational',
  operational: 'operational',
  degraded: 'degraded_performance',
  downtime: 'major_outage',
}

const impacts = (value: unknown, rowKeys: Set<string>) =>
  (Array.isArray(value) ? value : []).filter(isRecord).flatMap((row) => {
    const componentKey = `resource:${asKey(row.status_page_resource_id)}`
    const impact = RESOURCE_IMPACT[String(row.status)]
    return rowKeys.has(componentKey) && impact ? [{ componentKey, impact }] : []
  })

/**
 * Better Stack updates carry no incident status: every update is `investigating` until the
 * report has ended, whose last update then resolves it.
 */
function planIncident(
  { report, updates }: BetterStackReport,
  rowKeys: Set<string>,
  now: Date,
): PlannedIncident {
  const startsAt = isoTime(report.starts_at) ?? now.toISOString()
  const endsAt = isoTime(report.ends_at)
  const resolved = endsAt !== null && new Date(endsAt) <= now
  const timeline: PlannedIncidentUpdate[] = updates
    .map((update) => ({
      status: 'investigating' as const,
      message: asText(update.message) ?? '',
      postedAt: notAfter(isoTime(update.published_at) ?? startsAt, now),
      components: impacts(update.affected_resources, rowKeys),
    }))
    .sort((a, b) => a.postedAt.localeCompare(b.postedAt))
  if (timeline.length === 0) {
    timeline.push({
      status: 'investigating',
      message: '',
      postedAt: notAfter(startsAt, now),
      components: impacts(report.affected_resources, rowKeys),
    })
  }
  if (resolved) {
    const last = timeline[timeline.length - 1]
    if (timeline.length > 1 || last.postedAt === endsAt) {
      timeline[timeline.length - 1] = { ...last, status: 'resolved' }
    } else {
      timeline.push({
        status: 'resolved',
        message: '',
        postedAt: endsAt,
        components: last.components.map((row) => ({ ...row, impact: 'operational' })),
      })
    }
  }
  return {
    title: asText(report.title) ?? report.id,
    content: null,
    style: 'info',
    pinned: !resolved,
    active: !resolved,
    resolvedAt: null,
    impact: 'partial_outage',
    createdAt: startsAt,
    updates: timeline,
  }
}

export const betterStackProvider: ImportProvider<BetterStackSnapshot> = {
  label: 'Better Stack',

  async fetch(
    credentials: Credentials,
    resources: ReadonlySet<ImportResource>,
    fetchImpl: FetchLike,
  ) {
    const token = credentials.apiToken?.trim()
    const statusPageId = credentials.statusPageId?.trim() || null
    if (!token || (statusPageId !== null && !ID.test(statusPageId))) {
      throw new ProviderError('credentials')
    }
    const client = providerClient(fetchImpl, BETTERSTACK_API, { authorization: `Bearer ${token}` })
    const monitors = resources.has('monitors') ? await list(client, '/monitors') : []
    const wantsPages =
      resources.has('components') || resources.has('incidents') || resources.has('maintenance')
    if (!wantsPages) return { monitors, statusPages: [] }

    const pages = statusPageId
      ? [await one(client, `/status-pages/${statusPageId}`)]
      : await list(client, '/status-pages')
    const statusPages: BetterStackPage[] = []
    for (const page of pages) {
      const base = `/status-pages/${encodeURIComponent(page.id)}`
      const reports: BetterStackReport[] = []
      if (resources.has('incidents') || resources.has('maintenance')) {
        for (const report of await list(client, `${base}/status-reports`)) {
          const isMaintenance = report.report_type === 'maintenance'
          if (!resources.has(isMaintenance ? 'maintenance' : 'incidents')) continue
          const updates = isMaintenance
            ? []
            : await list(
                client,
                `${base}/status-reports/${encodeURIComponent(report.id)}/status-updates`,
              )
          reports.push({ report, updates })
        }
      }
      statusPages.push({
        page,
        sections: await list(client, `${base}/sections`),
        resources: await list(client, `${base}/resources`),
        reports,
      })
    }
    return { monitors, statusPages }
  },

  plan(snapshot, resources, t, now = new Date()) {
    const plan: ImportPlan = emptyPlan('betterstack')

    if (resources.has('monitors')) {
      for (const raw of snapshot.monitors) {
        const name = asText(raw.pronounceable_name) ?? asText(raw.url) ?? raw.id
        const mapped = mapMonitor(raw, plan.warnings, t)
        if ('skip' in mapped) {
          plan.skipped.monitors.push({ name, reason: mapped.skip })
          continue
        }
        const parsed = monitorFormSchema.safeParse(mapped.input)
        if (!parsed.success) {
          plan.skipped.monitors.push({
            name,
            reason: t('invalidMonitor', { issues: issueList(parsed.error.issues) }),
          })
          continue
        }
        plan.monitors.push({
          key: `monitor:${raw.id}`,
          data: parsed.data,
          parentKey: null,
          notificationKeys: [],
          pushToken: null,
        })
      }
    }
    const monitorKeys = new Set(plan.monitors.map((monitor) => monitor.key))
    const pageImported = resources.has('components')

    for (const source of snapshot.statusPages) {
      const title = asText(source.page.company_name) ?? asText(source.page.subdomain) ?? 'Status'
      const page: PlannedStatusPage = {
        key: `page:${source.page.id}`,
        data: providerPageFields({
          title,
          slug: asText(source.page.subdomain) ?? title,
          homepageUrl: asText(source.page.company_url),
          contactUrl: asText(source.page.contact_url),
          customCSS: asText(source.page.custom_css),
          googleAnalyticsId: asText(source.page.google_analytics_id),
          bannerText: asText(source.page.announcement),
          theme:
            source.page.theme === 'light' || source.page.theme === 'dark'
              ? source.page.theme
              : 'auto',
        }),
        domains: [hostnameOf(asText(source.page.custom_domain))].filter((d): d is string =>
          Boolean(d),
        ),
        groups: [],
        incidents: [],
      }

      // Sections in position order; resources without a section go first, in a group of their own.
      const byPosition = (a: Json, b: Json) => Number(a.position ?? 0) - Number(b.position ?? 0)
      const groups = new Map<string, PlannedStatusPageGroup>()
      for (const section of [...source.sections].sort(byPosition)) {
        groups.set(section.id, {
          name: asText(section.name) ?? title,
          defaultOpen: true,
          monitors: [],
        })
      }
      let ungrouped: PlannedStatusPageGroup | null = null
      const rowKeys = new Set<string>()
      const monitorOfRow = new Map<string, string>()
      for (const resource of [...source.resources].sort(byPosition)) {
        const key = `resource:${resource.id}`
        const monitorKey =
          resource.resource_type === 'Monitor' ? `monitor:${asKey(resource.resource_id)}` : null
        const linked = monitorKey !== null && monitorKeys.has(monitorKey)
        const row: PlannedStatusPageComponent = {
          key,
          monitorKey: linked ? monitorKey : null,
          type: linked ? 'monitor' : 'static',
          name: asText(resource.public_name),
          description: asText(resource.explanation),
          showValues: true,
          showChart: linked && resource.widget_type === 'response_times',
          sendUrl: false,
          customUrl: null,
        }
        if (row.type === 'static' && !row.name) row.name = key
        if (linked) monitorOfRow.set(key, monitorKey)
        const sectionId = asKey(resource.status_page_section_id)
        const group = sectionId !== null ? groups.get(sectionId) : undefined
        if (group) {
          group.monitors.push(row)
        } else {
          ungrouped ??= { name: t('ungroupedComponents'), defaultOpen: true, monitors: [] }
          ungrouped.monitors.push(row)
        }
        rowKeys.add(key)
      }
      page.groups = [...(ungrouped ? [ungrouped] : []), ...groups.values()].filter(
        (group) => group.monitors.length > 0,
      )
      if (pageImported) {
        plan.statusPages.push(page)
        plan.warnings.push(t('pageUnpublished', { title: page.data.title }))
      }

      for (const entry of source.reports) {
        const name = asText(entry.report.title) ?? entry.report.id
        if (entry.report.report_type === 'maintenance') {
          const start = isoTime(entry.report.starts_at)
          const end = isoTime(entry.report.ends_at)
          const affected = impactsRows(entry.report.affected_resources)
          const linkedMonitors = affected.flatMap((rowKey) => {
            const monitorKey = monitorOfRow.get(rowKey)
            return monitorKey ? [monitorKey] : []
          })
          if (!start || !end || end <= start) {
            plan.skipped.maintenance.push({ name, reason: t('maintenanceNoSchedule') })
          } else if (new Date(end) <= now) {
            plan.skipped.maintenance.push({ name, reason: t('maintenanceFinished') })
          } else if (!pageImported && linkedMonitors.length === 0) {
            plan.skipped.maintenance.push({ name, reason: t('requiresStatusPage') })
          } else {
            plan.maintenance.push({
              key: `maintenance:${entry.report.id}`,
              title: name,
              description: null,
              start,
              end,
              statusPageKeys: pageImported ? [page.key] : [],
              monitorKeys: linkedMonitors,
            })
          }
          continue
        }
        if (!pageImported) {
          plan.skipped.incidents.push({ name, reason: t('requiresStatusPage') })
          continue
        }
        page.incidents.push(planIncident(entry, rowKeys, now))
      }
    }
    return plan
  },
}

/** Row keys of a report's `affected_resources`. */
const impactsRows = (value: unknown): string[] =>
  (Array.isArray(value) ? value : []).filter(isRecord).flatMap((row) => {
    const id = asKey(row.status_page_resource_id)
    return id ? [`resource:${id}`] : []
  })
