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
import { BANNER_TEXT_MAX_LENGTH } from '@/collections/status-page-theme'
import { MARMOT_EXPORT_FORMAT, MARMOT_EXPORT_VERSION } from '@/lib/import-export'
import {
  MAX_SMS_MAX_SEGMENTS,
  SMS_TEMPLATE_KEYS,
  SUBSCRIBER_CHANNELS,
  SUBSCRIBER_DELIVERY_MODES,
} from '@/lib/status-page-subscribers'
import { incidentTimeline } from '@/lib/incident-timeline'
import {
  DEFAULT_THEME_PRESET,
  isThemePresetId,
  parseThemeOverrides,
} from '@/lib/status-page-themes'
import {
  defaultMonitorValues,
  monitorToFormValues,
  type MonitorFormValues,
} from '@/lib/validation/monitor'
import { monitorFormSchema } from '@/lib/validation/monitor-schema'
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
import { importText, type ImportText } from './text'

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
  homepageUrl?: string | null
  contactUrl?: string | null
  theme: StatusPage['theme']
  themePreset: string | null
  themeOverrides: StatusPage['themeOverrides']
  bannerText: string | null
  published: boolean
  searchEngineIndex: boolean
  showTags: boolean
  showCertificateExpiry: boolean
  showPoweredBy: boolean
  showValues?: boolean
  autoRefreshInterval: number | null
  footerText: string | null
  customCSS: string | null
  googleAnalyticsId: string | null
  /** Subscription settings (#104); subscribers themselves are exported per page as CSV. */
  subscriptions?: {
    enabled: boolean
    channels: string[]
    deliveryMode: string
    /** Exported notification channel id (Twilio). */
    smsChannel: OrgId | null
    smsMaxSegments: number | null
    smsTemplates: Record<string, string | null>
  }
  domains: string[]
  groups: {
    name: string
    defaultOpen?: boolean
    /** Components; `monitor` is null for static ones. */
    monitors: ExportedComponent[]
  }[]
  incidents: ExportedIncident[]
}

export interface ExportedComponent {
  type?: 'monitor' | 'static'
  monitor: OrgId | null
  name?: string | null
  description?: string | null
  showValues?: boolean
  sendUrl: boolean
  customUrl: string | null
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
  homepageUrl: doc.homepageUrl ?? null,
  contactUrl: doc.contactUrl ?? null,
  theme: doc.theme ?? 'auto',
  themePreset: doc.themePreset ?? null,
  themeOverrides: doc.themeOverrides ?? null,
  bannerText: doc.bannerText ?? null,
  // The password never leaves the instance, so a protected page is exported as a draft: importing
  // it must not publish it without protection.
  published: doc.access === 'password' ? false : (doc.published ?? false),
  searchEngineIndex: doc.searchEngineIndex ?? false,
  showTags: doc.showTags ?? false,
  showCertificateExpiry: doc.showCertificateExpiry ?? false,
  showPoweredBy: doc.showPoweredBy ?? true,
  showValues: doc.showValues ?? true,
  autoRefreshInterval: doc.autoRefreshInterval ?? null,
  footerText: doc.footerText ?? null,
  customCSS: doc.customCSS ?? null,
  googleAnalyticsId: doc.googleAnalyticsId ?? null,
  subscriptions: {
    enabled: doc.subscriptions?.enabled ?? false,
    channels: doc.subscriptions?.channels ?? ['email'],
    deliveryMode: doc.subscriptions?.deliveryMode ?? 'review',
    smsChannel: relationId(doc.subscriptions?.smsChannel),
    smsMaxSegments: doc.subscriptions?.smsMaxSegments ?? null,
    smsTemplates: Object.fromEntries(
      SMS_TEMPLATE_KEYS.map((key) => [key, doc.subscriptions?.smsTemplates?.[key] ?? null]),
    ),
  },
  domains: (doc.domains ?? []).map((row) => row.hostname),
  groups: (doc.groups ?? []).map((group) => ({
    name: group.name,
    defaultOpen: group.defaultOpen ?? true,
    monitors: (group.monitors ?? [])
      .map((row): ExportedComponent => ({
        type: row.type === 'static' ? 'static' : 'monitor',
        monitor: row.type === 'static' ? null : relationId(row.monitor),
        name: row.name ?? null,
        description: row.description ?? null,
        showValues: row.showValues ?? true,
        sendUrl: row.sendUrl ?? false,
        customUrl: row.customUrl ?? null,
      }))
      .filter((row) => row.type === 'static' || row.monitor !== null),
  })),
  // The update timeline is not exported yet: an incident travels as its latest message and its
  // impact as the legacy style, which the importer turns back into a single update.
  incidents: incidents.map((incident) => ({
    title: incident.title,
    content:
      incidentTimeline(incident)
        .updates.map((update) => update.message)
        .filter(Boolean)
        .at(-1) ??
      incident.content ??
      null,
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
    payload.find({
      collection: 'monitors',
      where: { organization: { equals: orgId } },
      sort: 'createdAt',
      ...common,
    }),
    payload.find({
      collection: 'notifications',
      where: { organization: { equals: orgId } },
      sort: 'name',
      ...common,
    }),
    payload.find({
      collection: 'status-pages',
      where: { organization: { equals: orgId } },
      sort: 'title',
      ...common,
    }),
    payload.find({
      collection: 'incidents',
      where: { organization: { equals: orgId } },
      sort: 'createdAt',
      ...common,
    }),
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

const importedThemeOverrides = (value: unknown): StatusPage['themeOverrides'] => {
  const parsed = parseThemeOverrides(value)
  return parsed.ok ? (parsed.value as StatusPage['themeOverrides']) : null
}

const statusPageSchema = z.object({
  id: idSchema,
  title: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(100),
  description: z.string().nullish(),
  homepageUrl: z.string().nullish(),
  contactUrl: z.string().nullish(),
  theme: z.enum(['auto', 'light', 'dark']).nullish(),
  themePreset: z.string().nullish(),
  themeOverrides: z.unknown().optional(),
  bannerText: z.string().nullish(),
  published: z.boolean().nullish(),
  searchEngineIndex: z.boolean().nullish(),
  showTags: z.boolean().nullish(),
  showCertificateExpiry: z.boolean().nullish(),
  showPoweredBy: z.boolean().nullish(),
  showValues: z.boolean().nullish(),
  autoRefreshInterval: z.number().int().min(0).nullish(),
  footerText: z.string().nullish(),
  customCSS: z.string().nullish(),
  googleAnalyticsId: z.string().nullish(),
  subscriptions: z
    .object({
      enabled: z.boolean().nullish(),
      channels: z.array(z.enum(SUBSCRIBER_CHANNELS)).nullish(),
      deliveryMode: z.enum(SUBSCRIBER_DELIVERY_MODES).nullish(),
      smsChannel: idSchema.nullish(),
      smsMaxSegments: z.number().int().min(1).max(MAX_SMS_MAX_SEGMENTS).nullish(),
      smsTemplates: z.record(z.string(), z.string().nullable()).nullish(),
    })
    .nullish(),
  domains: z.array(z.string()).default([]),
  groups: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        defaultOpen: z.boolean().nullish(),
        monitors: z
          .array(
            z.union([
              z.object({
                type: z.literal('static'),
                monitor: z.null().optional(),
                name: z.string().trim().min(1),
                description: z.string().nullish(),
                showValues: z.boolean().nullish(),
                sendUrl: z.boolean().nullish(),
                customUrl: z.string().nullish(),
              }),
              z.object({
                type: z.literal('monitor').optional(),
                monitor: idSchema,
                name: z.string().nullish(),
                description: z.string().nullish(),
                showValues: z.boolean().nullish(),
                sendUrl: z.boolean().nullish(),
                customUrl: z.string().nullish(),
              }),
            ]),
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
    .map((issue) =>
      issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join('; ')

/** Parses a Marmot export into an import plan. Pure: no database access. */
export function parseMarmotExport(json: unknown, t: ImportText = importText()): ImportPlan {
  const envelope = envelopeSchema.safeParse(json)
  if (!envelope.success) {
    throw new ImportFormatError(
      t('notMarmotExport', {
        format: MARMOT_EXPORT_FORMAT,
        version: MARMOT_EXPORT_VERSION,
        issues: issueList(envelope.error.issues),
      }),
    )
  }
  const plan = emptyPlan('marmot')
  const file = envelope.data

  const seenNames = new Set<string>()
  file.notifications.forEach((entry, index) => {
    const parsed = notificationSchema.safeParse(entry)
    const fallback = t('unnamed', { kind: 'notification', id: index + 1 })
    const name = isRecord(entry) ? (asText(entry.name) ?? fallback) : fallback
    if (!parsed.success) {
      plan.skipped.notifications.push({
        name,
        reason: t('invalidNotification', { issues: issueList(parsed.error.issues) }),
      })
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
            : t('unknownNotificationType', { type: parsed.data.type }),
      })
      return
    }
    if (seenNames.has(parsed.data.name)) {
      plan.skipped.notifications.push({
        name,
        reason: t('duplicateNotification'),
      })
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
    const fallback = t('unnamed', { kind: 'monitor', id: index + 1 })
    const name = isRecord(entry) ? (asText(entry.name) ?? fallback) : fallback
    const envelope = monitorEnvelopeSchema.safeParse(entry)
    if (!envelope.success || !isRecord(entry)) {
      plan.skipped.monitors.push({
        name,
        reason: t('invalidMonitor', {
          issues: envelope.success ? t('notAnObject') : issueList(envelope.error.issues),
        }),
      })
      return
    }
    const { id: _id, notifications: _n, pushToken: _p, parent: _parent, ...fields } = entry
    // Tags, proxies and Docker hosts are organization resources the export does not carry; their ids
    // belong to the exporting organization, so references to them are not imported.
    if (fields.type === 'docker') {
      plan.skipped.monitors.push({
        name,
        reason: t('dockerMonitorSkipped'),
      })
      return
    }
    const hasTags = Array.isArray(fields.tags) && fields.tags.length > 0
    const hasProxy = fields.proxy !== null && fields.proxy !== undefined
    if (hasTags || hasProxy) {
      const resources = hasTags && hasProxy ? 'both' : hasTags ? 'tags' : 'proxy'
      plan.warnings.push(t('resourcesDropped', { name, resources }))
    }
    const parsed = monitorFormSchema.safeParse({
      ...fields,
      tags: [],
      proxy: null,
      dockerHost: null,
      parent: null,
    })
    if (!parsed.success) {
      plan.skipped.monitors.push({
        name,
        reason: t('invalidMonitor', { issues: issueList(parsed.error.issues) }),
      })
      return
    }
    plan.monitors.push({
      key: String(envelope.data.id),
      data: parsed.data,
      parentKey:
        envelope.data.parent === null || envelope.data.parent === undefined
          ? null
          : String(envelope.data.parent),
      notificationKeys: envelope.data.notifications.map(String),
      pushToken: parsed.data.type === 'push' ? (envelope.data.pushToken ?? null) : null,
    })
  })

  const groupKeys = new Set(plan.monitors.filter((m) => m.data.type === 'group').map((m) => m.key))
  for (const monitor of plan.monitors) {
    if (monitor.parentKey !== null && !groupKeys.has(monitor.parentKey)) {
      plan.warnings.push(
        t('parentNotImported', { name: monitor.data.name, parent: monitor.parentKey }),
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
    plan.warnings.push(t('linksDropped', { count: droppedLinks }))
  }

  const monitorKeys = new Set(plan.monitors.map((m) => m.key))
  file.statusPages.forEach((entry, index) => {
    const fallback = t('unnamed', { kind: 'statusPage', id: index + 1 })
    const name = isRecord(entry) ? (asText(entry.title) ?? fallback) : fallback
    const parsed = statusPageSchema.safeParse(entry)
    if (!parsed.success) {
      plan.skipped.statusPages.push({
        name,
        reason: t('invalidStatusPage', { issues: issueList(parsed.error.issues) }),
      })
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
        homepageUrl: page.homepageUrl ?? null,
        contactUrl: page.contactUrl ?? null,
        theme: page.theme ?? 'auto',
        // Unknown presets and invalid overrides fall back to the defaults instead of failing the page.
        themePreset: isThemePresetId(page.themePreset) ? page.themePreset : DEFAULT_THEME_PRESET,
        themeOverrides: importedThemeOverrides(page.themeOverrides),
        bannerText: page.bannerText?.trim().slice(0, BANNER_TEXT_MAX_LENGTH) || null,
        published: page.published ?? false,
        searchEngineIndex: page.searchEngineIndex ?? false,
        showTags: page.showTags ?? false,
        showCertificateExpiry: page.showCertificateExpiry ?? false,
        showPoweredBy: page.showPoweredBy ?? true,
        showValues: page.showValues ?? true,
        autoRefreshInterval: page.autoRefreshInterval ?? 300,
        footerText: page.footerText ?? null,
        customCSS: page.customCSS ?? null,
        googleAnalyticsId: page.googleAnalyticsId ?? null,
      },
      ...(page.subscriptions
        ? {
            subscriptions: {
              enabled: page.subscriptions.enabled ?? false,
              channels: page.subscriptions.channels ?? ['email'],
              deliveryMode: page.subscriptions.deliveryMode ?? 'review',
              smsChannelKey:
                page.subscriptions.smsChannel != null
                  ? String(page.subscriptions.smsChannel)
                  : null,
              smsMaxSegments: page.subscriptions.smsMaxSegments ?? null,
              smsTemplates: Object.fromEntries(
                SMS_TEMPLATE_KEYS.map((key) => [
                  key,
                  page.subscriptions?.smsTemplates?.[key] ?? null,
                ]),
              ),
            },
          }
        : {}),
      domains: page.domains.map((d) => d.trim().toLowerCase()).filter(Boolean),
      groups: page.groups.map((group) => ({
        name: group.name,
        defaultOpen: group.defaultOpen ?? true,
        monitors: group.monitors
          .filter((row) => {
            if (row.type === 'static') return true
            const keep = monitorKeys.has(String(row.monitor))
            if (!keep) droppedRows += 1
            return keep
          })
          .map((row) => ({
            monitorKey: row.type === 'static' ? null : String(row.monitor),
            type: row.type === 'static' ? ('static' as const) : ('monitor' as const),
            name: asText(row.name),
            description: asText(row.description),
            showValues: asBool(row.showValues) ?? true,
            sendUrl: asBool(row.sendUrl) ?? false,
            customUrl: asText(row.customUrl),
          })),
      })),
      incidents: page.incidents.map((incident): PlannedIncident => ({
        title: incident.title,
        content: incident.content ?? null,
        style: incident.style ?? 'info',
        pinned: incident.pinned ?? true,
        active: incident.active ?? true,
        resolvedAt: incident.resolvedAt ?? null,
      })),
    }
    if (droppedRows > 0) {
      plan.warnings.push(t('rowsDropped', { title: page.title, count: droppedRows }))
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
