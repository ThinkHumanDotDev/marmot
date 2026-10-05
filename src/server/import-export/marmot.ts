/**
 * Marmot's own export format and its importer.
 *
 *   { format: 'marmot', version: 1, exportedAt, organization: { name, slug },
 *     notifications: [{ id, name, type, config, isDefault, active }],
 *     monitors:      [{ id, ...MonitorFormValues, parent: id | null, notifications: [id], pushToken }],
 *     statusPages:   [{ id, ...fields, domains: [hostname], groups: [{ name, monitors: [{ monitor: id, sendUrl, customUrl }] }],
 *                      incidents: [{ title, content, style, pinned, active, resolvedAt, createdAt }] }] }
 *
 * Ids are the plain document ids of the exporting instance and are only used to link documents
 * inside the file; the importer remaps them. THE FILE CONTAINS SECRETS: notification configs are
 * exported as stored (webhook URLs, tokens, SMTP passwords) and monitors carry their auth
 * credentials, so the export is only offered to `organization:update` holders.
 */
import type { Payload } from 'payload'
import { z } from 'zod'

import type { OrgId } from '@/access/permissions'
import { MARMOT_EXPORT_FORMAT, MARMOT_EXPORT_VERSION } from '@/lib/import-export'
import {
  defaultMonitorValues,
  monitorFormSchema,
  monitorToFormValues,
  type MonitorFormValues,
} from '@/lib/validation/monitor'
import type { Incident, Monitor, Notification, Organization, StatusPage } from '@/payload-types'
import { NotificationConfigError, validateNotificationConfig } from '@/server/notifications/send'
import { relationId } from '@/server/monitors/http'

import {
  asBool,
  asKey,
  asText,
  emptyPlan,
  ImportFormatError,
  isRecord,
  type ImportPlan,
  type PlannedIncident,
  type PlannedStatusPage,
} from './types'

// ---- Export --------------------------------------------------------------------------------------

export type ExportedMonitor = MonitorFormValues & {
  id: OrgId
  notifications: OrgId[]
  pushToken: string | null
}

export interface ExportedNotification {
  id: OrgId
  name: string
  type: string
  config: Record<string, unknown>
  isDefault: boolean
  active: boolean
}

export interface ExportedIncident {
  title: string
  content: string | null
  style: Incident['style']
  pinned: boolean
  active: boolean
  resolvedAt: string | null
  createdAt: string
}

export interface ExportedStatusPage {
  id: OrgId
  title: string
  slug: string
  description: string | null
  theme: StatusPage['theme']
  published: boolean
  searchEngineIndex: boolean
  showTags: boolean
  showCertificateExpiry: boolean
  showPoweredBy: boolean
  autoRefreshInterval: number | null
  footerText: string | null
  customCSS: string | null
  googleAnalyticsId: string | null
  domains: string[]
  groups: { name: string; monitors: { monitor: OrgId; sendUrl: boolean; customUrl: string | null }[] }[]
  incidents: ExportedIncident[]
}

export interface MarmotExport {
  format: typeof MARMOT_EXPORT_FORMAT
  version: typeof MARMOT_EXPORT_VERSION
  exportedAt: string
  organization: { name: string; slug: string }
  notifications: ExportedNotification[]
  monitors: ExportedMonitor[]
  statusPages: ExportedStatusPage[]
}

const MONITOR_FIELDS = Object.keys(defaultMonitorValues()) as (keyof MonitorFormValues)[]

const toExportedMonitor = (doc: Monitor): ExportedMonitor => {
  const values = monitorToFormValues(doc)
  const out: Record<string, unknown> = { id: doc.id }
  for (const key of MONITOR_FIELDS) out[key] = values[key]
  out.notifications = (doc.notifications ?? [])
    .map((n) => relationId(n))
    .filter((id): id is OrgId => id !== null)
  out.pushToken = doc.type === 'push' ? (doc.pushToken ?? null) : null
  return out as ExportedMonitor
}

const toExportedStatusPage = (doc: StatusPage, incidents: Incident[]): ExportedStatusPage => ({
  id: doc.id,
  title: doc.title,
  slug: doc.slug,
  description: doc.description ?? null,
  theme: doc.theme ?? 'auto',
  published: doc.published ?? false,
  searchEngineIndex: doc.searchEngineIndex ?? false,
  showTags: doc.showTags ?? false,
  showCertificateExpiry: doc.showCertificateExpiry ?? false,
  showPoweredBy: doc.showPoweredBy ?? true,
  autoRefreshInterval: doc.autoRefreshInterval ?? null,
  footerText: doc.footerText ?? null,
  customCSS: doc.customCSS ?? null,
  googleAnalyticsId: doc.googleAnalyticsId ?? null,
  domains: (doc.domains ?? []).map((row) => row.hostname),
  groups: (doc.groups ?? []).map((group) => ({
    name: group.name,
    monitors: (group.monitors ?? [])
      .map((row) => ({
        monitor: relationId(row.monitor),
        sendUrl: row.sendUrl ?? false,
        customUrl: row.customUrl ?? null,
      }))
      .filter((row): row is { monitor: OrgId; sendUrl: boolean; customUrl: string | null } =>
        row.monitor !== null,
      ),
  })),
  incidents: incidents.map((incident) => ({
    title: incident.title,
    content: incident.content ?? null,
    style: incident.style ?? 'info',
    pinned: incident.pinned ?? true,
    active: incident.active ?? true,
    resolvedAt: incident.resolvedAt ?? null,
    createdAt: incident.createdAt,
  })),
})

/**
 * Builds the export of one organization with the caller's access (`overrideAccess: false`), so the
 * collections' read rules apply on top of the route's `organization:update` check.
 */
export async function buildMarmotExport(
  payload: Payload,
  { orgId, user }: { orgId: OrgId; user: NonNullable<Parameters<Payload['find']>[0]['user']> },
): Promise<MarmotExport> {
  const common = { depth: 0, limit: 0, pagination: false, user, overrideAccess: false } as const
  const organization = (await payload.findByID({
    collection: 'organizations',
    id: orgId,
    depth: 0,
    user,
    overrideAccess: false,
  })) as Organization

  const [monitors, notifications, statusPages, incidents] = await Promise.all([
    payload.find({ collection: 'monitors', where: { organization: { equals: orgId } }, sort: 'createdAt', ...common }),
    payload.find({ collection: 'notifications', where: { organization: { equals: orgId } }, sort: 'name', ...common }),
    payload.find({ collection: 'status-pages', where: { organization: { equals: orgId } }, sort: 'title', ...common }),
    payload.find({ collection: 'incidents', where: { organization: { equals: orgId } }, sort: 'createdAt', ...common }),
  ])

  const incidentsByPage = new Map<string, Incident[]>()
  for (const incident of incidents.docs as Incident[]) {
    const pageId = relationId(incident.statusPage)
    if (pageId === null) continue
    const list = incidentsByPage.get(String(pageId)) ?? []
    list.push(incident)
    incidentsByPage.set(String(pageId), list)
  }

  return {
    format: MARMOT_EXPORT_FORMAT,
    version: MARMOT_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    organization: { name: organization.name, slug: organization.slug },
    notifications: (notifications.docs as Notification[]).map((doc) => ({
      id: doc.id,
      name: doc.name,
      type: doc.type,
      config: isRecord(doc.config) ? doc.config : {},
      isDefault: doc.isDefault ?? false,
      active: doc.active ?? true,
    })),
    monitors: (monitors.docs as Monitor[]).map(toExportedMonitor),
    statusPages: (statusPages.docs as StatusPage[]).map((doc) =>
      toExportedStatusPage(doc, incidentsByPage.get(String(doc.id)) ?? []),
    ),
  }
}

// ---- Import --------------------------------------------------------------------------------------

const idSchema = z.union([z.string().min(1), z.number()])
const idList = z.array(idSchema).default([])

/** Envelope only; the documents inside are validated one by one so a bad one is skipped, not fatal. */
const envelopeSchema = z.object({
  format: z.literal(MARMOT_EXPORT_FORMAT),
  version: z.literal(MARMOT_EXPORT_VERSION),
  exportedAt: z.string().optional(),
  notifications: z.array(z.unknown()).default([]),
  monitors: z.array(z.unknown()).default([]),
  statusPages: z.array(z.unknown()).default([]),
})

const notificationSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(150),
  type: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
  isDefault: z.boolean().default(false),
  active: z.boolean().default(true),
})

const monitorEnvelopeSchema = z.object({
  id: idSchema,
  notifications: idList,
  pushToken: z.string().nullish(),
  parent: idSchema.nullish(),
})

const statusPageSchema = z.object({
  id: idSchema,
  title: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(100),
  description: z.string().nullish(),
  theme: z.enum(['auto', 'light', 'dark']).nullish(),
  published: z.boolean().nullish(),
  searchEngineIndex: z.boolean().nullish(),
  showTags: z.boolean().nullish(),
  showCertificateExpiry: z.boolean().nullish(),
  showPoweredBy: z.boolean().nullish(),
  autoRefreshInterval: z.number().int().min(0).nullish(),
  footerText: z.string().nullish(),
  customCSS: z.string().nullish(),
  googleAnalyticsId: z.string().nullish(),
  domains: z.array(z.string()).default([]),
  groups: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        monitors: z
          .array(
            z.object({
              monitor: idSchema,
              sendUrl: z.boolean().nullish(),
              customUrl: z.string().nullish(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
  incidents: z
    .array(
      z.object({
        title: z.string().trim().min(1),
        content: z.string().nullish(),
        style: z.enum(['info', 'warning', 'danger', 'primary']).nullish(),
        pinned: z.boolean().nullish(),
        active: z.boolean().nullish(),
        resolvedAt: z.string().nullish(),
      }),
    )
    .default([]),
})

const issueList = (issues: { path: PropertyKey[]; message: string }[]): string =>
  issues
    .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ')

/** Parses a Marmot export into an import plan. Pure: no database access. */
export function parseMarmotExport(json: unknown): ImportPlan {
  const envelope = envelopeSchema.safeParse(json)
  if (!envelope.success) {
    throw new ImportFormatError(
      `Not a Marmot export (format "${MARMOT_EXPORT_FORMAT}" version ${MARMOT_EXPORT_VERSION}): ${issueList(envelope.error.issues)}`,
    )
  }
  const plan = emptyPlan('marmot')
  const file = envelope.data

  const seenNames = new Set<string>()
  file.notifications.forEach((entry, index) => {
    const parsed = notificationSchema.safeParse(entry)
    const name = isRecord(entry) ? (asText(entry.name) ?? `notification #${index + 1}`) : `notification #${index + 1}`
    if (!parsed.success) {
      plan.skipped.notifications.push({ name, reason: `Invalid notification: ${issueList(parsed.error.issues)}` })
      return
    }
    let config: Record<string, unknown>
    try {
      config = validateNotificationConfig(parsed.data.type, parsed.data.config)
    } catch (error) {
      plan.skipped.notifications.push({
        name,
        reason:
          error instanceof NotificationConfigError
            ? error.message
            : `Unknown notification type "${parsed.data.type}"`,
      })
      return
    }
    if (seenNames.has(parsed.data.name)) {
      plan.skipped.notifications.push({ name, reason: 'Another notification in the file has the same name' })
      return
    }
    seenNames.add(parsed.data.name)
    plan.notifications.push({
      key: String(parsed.data.id),
      name: parsed.data.name,
      type: parsed.data.type,
      config,
      isDefault: parsed.data.isDefault,
      active: parsed.data.active,
    })
  })

  file.monitors.forEach((entry, index) => {
    const name = isRecord(entry) ? (asText(entry.name) ?? `monitor #${index + 1}`) : `monitor #${index + 1}`
    const envelope = monitorEnvelopeSchema.safeParse(entry)
    if (!envelope.success || !isRecord(entry)) {
      plan.skipped.monitors.push({
        name,
        reason: `Invalid monitor: ${envelope.success ? 'not an object' : issueList(envelope.error.issues)}`,
      })
      return
    }
    const { id: _id, notifications: _n, pushToken: _p, parent: _parent, ...fields } = entry
    const parsed = monitorFormSchema.safeParse({ ...fields, parent: null })
    if (!parsed.success) {
      plan.skipped.monitors.push({ name, reason: `Invalid monitor: ${issueList(parsed.error.issues)}` })
      return
    }
    plan.monitors.push({
      key: String(envelope.data.id),
      data: parsed.data,
      parentKey: envelope.data.parent === null || envelope.data.parent === undefined ? null : String(envelope.data.parent),
      notificationKeys: envelope.data.notifications.map(String),
      pushToken: parsed.data.type === 'push' ? (envelope.data.pushToken ?? null) : null,
    })
  })

  const groupKeys = new Set(plan.monitors.filter((m) => m.data.type === 'group').map((m) => m.key))
  for (const monitor of plan.monitors) {
    if (monitor.parentKey !== null && !groupKeys.has(monitor.parentKey)) {
      plan.warnings.push(
        `"${monitor.data.name}": parent group #${monitor.parentKey} was not imported; the monitor is placed at the top level`,
      )
      monitor.parentKey = null
    }
  }
  const notificationKeys = new Set(plan.notifications.map((n) => n.key))
  let droppedLinks = 0
  for (const monitor of plan.monitors) {
    const kept = monitor.notificationKeys.filter((k) => notificationKeys.has(k))
    droppedLinks += monitor.notificationKeys.length - kept.length
    monitor.notificationKeys = kept
  }
  if (droppedLinks > 0) {
    plan.warnings.push(
      `${droppedLinks} monitor → notification link${droppedLinks === 1 ? '' : 's'} dropped because the notification was not imported`,
    )
  }

  const monitorKeys = new Set(plan.monitors.map((m) => m.key))
  file.statusPages.forEach((entry, index) => {
    const name = isRecord(entry) ? (asText(entry.title) ?? `status page #${index + 1}`) : `status page #${index + 1}`
    const parsed = statusPageSchema.safeParse(entry)
    if (!parsed.success) {
      plan.skipped.statusPages.push({ name, reason: `Invalid status page: ${issueList(parsed.error.issues)}` })
      return
    }
    const page = parsed.data
    let droppedRows = 0
    const planned: PlannedStatusPage = {
      key: String(page.id),
      data: {
        title: page.title,
        slug: page.slug.toLowerCase(),
        description: page.description ?? null,
        theme: page.theme ?? 'auto',
        published: page.published ?? false,
        searchEngineIndex: page.searchEngineIndex ?? false,
        showTags: page.showTags ?? false,
        showCertificateExpiry: page.showCertificateExpiry ?? false,
        showPoweredBy: page.showPoweredBy ?? true,
        autoRefreshInterval: page.autoRefreshInterval ?? 300,
        footerText: page.footerText ?? null,
        customCSS: page.customCSS ?? null,
        googleAnalyticsId: page.googleAnalyticsId ?? null,
      },
      domains: page.domains.map((d) => d.trim().toLowerCase()).filter(Boolean),
      groups: page.groups.map((group) => ({
        name: group.name,
        monitors: group.monitors
          .filter((row) => {
            const keep = monitorKeys.has(String(row.monitor))
            if (!keep) droppedRows += 1
            return keep
          })
          .map((row) => ({
            monitorKey: String(row.monitor),
            sendUrl: asBool(row.sendUrl) ?? false,
            customUrl: asText(row.customUrl),
          })),
      })),
      incidents: page.incidents.map(
        (incident): PlannedIncident => ({
          title: incident.title,
          content: incident.content ?? null,
          style: incident.style ?? 'info',
          pinned: incident.pinned ?? true,
          active: incident.active ?? true,
          resolvedAt: incident.resolvedAt ?? null,
        }),
      ),
    }
    if (droppedRows > 0) {
      plan.warnings.push(
        `"${page.title}": ${droppedRows} monitor row${droppedRows === 1 ? '' : 's'} dropped because the monitor was not imported`,
      )
    }
    plan.statusPages.push(planned)
  })

  return plan
}

/** Convenience for the UI's format badge: the organization named in the file, if any. */
export function exportedOrganizationName(json: unknown): string | null {
  if (!isRecord(json) || !isRecord(json.organization)) return null
  return asText(json.organization.name) ?? asKey(json.organization.slug)
}
