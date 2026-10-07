/**
 * Writes an import plan into one organization — or, on a dry run, only computes the report.
 *
 * Order: notifications → monitors (groups before their children) → status pages → incidents →
 * templates, so
 * every relationship can be resolved to a freshly created id. Everything runs in one database
 * transaction (same pattern as `runSetup`); on adapters without transactions the writes are
 * sequential and a failure leaves the documents created so far.
 *
 * Permissions: the caller must hold `monitor:create` (checked by the route). Notifications and
 * status pages are only imported when the caller also holds `notification:create` /
 * `status-page:create` / `template:create`; otherwise those parts are skipped with a warning.
 */
import { createLocalReq, type Payload, type PayloadRequest } from 'payload'

import { can, type OrgId } from '@/access/permissions'
import type { ImportReport, SkippedItem } from '@/lib/import-export'
import { childLogger } from '@/lib/logger'
import { validateOrganizationSlug } from '@/lib/reserved-slugs'
import type { Incident, Monitor, Notification, StatusPage, Template } from '@/payload-types'
import type { RequestUser } from '@/server/monitors/http'
import { checkServerSmtpChange } from '@/server/notifications/server-smtp'

import type { ImportPlan, PlannedMonitor } from './types'
import { defaultLocale, type Locale } from '@/i18n/locales'
import { translateError } from '@/server/errors'
import { slugMessageIn } from '@/server/request-locale'
import { importText } from './text'

const log = childLogger('import-export')

export interface ApplyImportOptions {
  orgId: OrgId
  user: RequestUser
  plan: ImportPlan
  dryRun: boolean
  /** Language of the report's reasons and warnings (English by default). */
  locale?: Locale
}

/** Groups first, then their children, then grandchildren (groups can nest). */
function orderByDepth(monitors: PlannedMonitor[]): PlannedMonitor[] {
  const byKey = new Map(monitors.map((m) => [m.key, m]))
  const depth = (monitor: PlannedMonitor): number => {
    let d = 0
    let current: PlannedMonitor | undefined = monitor
    const seen = new Set<string>()
    while (current?.parentKey && !seen.has(current.key)) {
      seen.add(current.key)
      current = byKey.get(current.parentKey)
      d += 1
      if (d > 100) break
    }
    return d
  }
  return monitors
    .map((monitor, index) => ({ monitor, index, depth: depth(monitor) }))
    .sort((a, b) => a.depth - b.depth || a.index - b.index)
    .map(({ monitor }) => monitor)
}

/** `slug`, `slug-2`, `slug-3`, … until it is not in `taken`. */
function uniqueSlug(slug: string, taken: Set<string>): string {
  if (!taken.has(slug)) return slug
  for (let n = 2; n < 1000; n++) {
    const candidate = `${slug}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  return `${slug}-${Date.now().toString(36)}`
}

export async function applyImportPlan(
  payload: Payload,
  { orgId, user, plan, dryRun, locale = defaultLocale }: ApplyImportOptions,
): Promise<ImportReport> {
  const t = importText(locale)
  const report: ImportReport = {
    format: plan.format,
    dryRun,
    monitors: { create: 0, skipped: [...plan.skipped.monitors] },
    notifications: { create: 0, skipped: [...plan.skipped.notifications] },
    statusPages: { create: 0, skipped: [...plan.skipped.statusPages] },
    templates: { create: 0, skipped: [...plan.skipped.templates] },
    tags: { create: 0, skipped: [...plan.skipped.tags] },
    warnings: [...plan.warnings],
  }
  const created = {
    monitors: [] as OrgId[],
    notifications: [] as OrgId[],
    statusPages: [] as OrgId[],
    templates: [] as OrgId[],
  }

  const skipAll = (items: { name: string }[], target: SkippedItem[], reason: string) => {
    for (const item of items) target.push({ name: item.name, reason })
  }

  // ---- Permissions per part -----------------------------------------------------------------
  if (!can(user, orgId, 'monitor:create')) {
    skipAll(
      plan.monitors.map((m) => ({ name: m.data.name })),
      report.monitors.skipped,
      t('noMonitorPermission'),
    )
    plan = { ...plan, monitors: [] }
  }
  const canNotifications = can(user, orgId, 'notification:create')
  if (!canNotifications && plan.notifications.length > 0) {
    report.warnings.push(t('notificationsSkippedRole'))
    skipAll(plan.notifications, report.notifications.skipped, t('noNotificationPermission'))
    plan = { ...plan, notifications: [] }
  }
  // Channels that would send through the server SMTP settings follow NOTIFICATIONS_SERVER_SMTP;
  // skip them here instead of failing the whole import on save.
  if (plan.notifications.length > 0) {
    plan = {
      ...plan,
      notifications: plan.notifications.filter((planned) => {
        const refusal = checkServerSmtpChange({
          operation: 'create',
          type: planned.type,
          config: planned.config,
          user,
        })
        if (refusal)
          report.notifications.skipped.push({
            name: planned.name,
            reason: translateError(locale, refusal.key, refusal.values),
          })
        return !refusal
      }),
    }
  }
  const canStatusPages = can(user, orgId, 'status-page:create')
  if (!canStatusPages && plan.statusPages.length > 0) {
    report.warnings.push(t('statusPagesSkipped'))
    skipAll(
      plan.statusPages.map((p) => ({ name: p.data.title })),
      report.statusPages.skipped,
      t('noStatusPagePermission'),
    )
    plan = { ...plan, statusPages: [] }
  }

  const canTemplates = can(user, orgId, 'template:create')
  if (!canTemplates && plan.templates.length > 0) {
    report.warnings.push(t('templatesSkipped'))
    skipAll(plan.templates, report.templates.skipped, t('noTemplatePermission'))
    plan = { ...plan, templates: [] }
  }

  // ---- Conflict detection (reads only; also used by the dry run) -----------------------------
  const notificationIds = new Map<string, OrgId>()
  const monitorIds = new Map<string, OrgId>()

  if (plan.notifications.length > 0) {
    const { docs } = await payload.find({
      collection: 'notifications',
      where: {
        and: [
          { organization: { equals: orgId } },
          { name: { in: plan.notifications.map((n) => n.name) } },
        ],
      },
      depth: 0,
      limit: 0,
      pagination: false,
      overrideAccess: true,
    })
    const existingByName = new Map((docs as Notification[]).map((doc) => [doc.name, doc.id]))
    plan = {
      ...plan,
      notifications: plan.notifications.filter((planned) => {
        const existing = existingByName.get(planned.name)
        if (existing === undefined) return true
        notificationIds.set(planned.key, existing)
        report.notifications.skipped.push({
          name: planned.name,
          reason: t('channelExists'),
        })
        return false
      }),
    }
  }

  // Monitors-as-code keys are unique per organization: a key already in use (or repeated in the
  // file) is dropped, the monitor is imported without one.
  const plannedKeys = plan.monitors.flatMap((m) => (m.data.key ? [m.data.key] : []))
  if (plannedKeys.length > 0) {
    const { docs } = await payload.find({
      collection: 'monitors',
      where: { and: [{ organization: { equals: orgId } }, { key: { in: plannedKeys } }] },
      depth: 0,
      limit: 0,
      pagination: false,
      overrideAccess: true,
      select: { key: true },
    })
    const taken = new Set((docs as Pick<Monitor, 'key'>[]).map((doc) => doc.key))
    plan = {
      ...plan,
      monitors: plan.monitors.map((planned) => {
        const key = planned.data.key
        if (!key) return planned
        if (!taken.has(key)) {
          taken.add(key)
          return planned
        }
        report.warnings.push(t('monitorKeyDropped', { name: planned.data.name, key }))
        return { ...planned, data: { ...planned.data, key: null } }
      }),
    }
  }

  if (plan.templates.length > 0) {
    const { docs } = await payload.find({
      collection: 'templates',
      where: {
        and: [
          { organization: { equals: orgId } },
          { name: { in: plan.templates.map((template) => template.name) } },
        ],
      },
      depth: 0,
      limit: 0,
      pagination: false,
      overrideAccess: true,
      select: { name: true },
    })
    const existing = new Set((docs as Pick<Template, 'name'>[]).map((doc) => doc.name))
    plan = {
      ...plan,
      templates: plan.templates.filter((planned) => {
        if (!existing.has(planned.name)) return true
        report.templates.skipped.push({ name: planned.name, reason: t('templateExists') })
        return false
      }),
    }
  }

  // Slugs and custom hostnames are unique across ALL organizations, so the lookup bypasses access.
  const takenSlugs = new Set<string>()
  const takenHostnames = new Set<string>()
  if (plan.statusPages.length > 0) {
    const { docs } = await payload.find({
      collection: 'status-pages',
      depth: 0,
      limit: 0,
      pagination: false,
      overrideAccess: true,
      select: { slug: true, domains: true },
    })
    for (const doc of docs as StatusPage[]) {
      takenSlugs.add(doc.slug)
      for (const row of doc.domains ?? []) takenHostnames.add(row.hostname)
    }
  }

  // Resolve slugs and domains up front so the dry run reports the same outcome as the commit.
  const statusPages = plan.statusPages.flatMap((page) => {
    const valid = validateOrganizationSlug(page.data.slug, slugMessageIn(locale))
    if (valid !== true) {
      report.statusPages.skipped.push({
        name: page.data.title,
        reason: t('invalidSlug', { slug: page.data.slug, reason: valid }),
      })
      return []
    }
    const slug = uniqueSlug(page.data.slug, takenSlugs)
    takenSlugs.add(slug)
    if (slug !== page.data.slug) {
      report.warnings.push(
        t('slugInUse', { title: page.data.title, slug: page.data.slug, imported: slug }),
      )
    }
    const domains = page.domains.filter((hostname) => {
      if (takenHostnames.has(hostname)) {
        report.warnings.push(t('domainInUse', { title: page.data.title, hostname }))
        return false
      }
      takenHostnames.add(hostname)
      return true
    })
    return [{ ...page, data: { ...page.data, slug }, domains }]
  })

  const orderedMonitors = orderByDepth(plan.monitors)
  report.notifications.create = plan.notifications.length
  report.monitors.create = orderedMonitors.length
  report.statusPages.create = statusPages.length
  report.templates.create = plan.templates.length
  // Templates bound to a page that will not be created lose the page and its components.
  const importedPageKeys = new Set(statusPages.map((page) => page.key))
  const templates = plan.templates.map((planned) => {
    if (planned.statusPageKey === null || importedPageKeys.has(planned.statusPageKey)) {
      return planned
    }
    if (planned.components.length > 0) {
      report.warnings.push(
        t('templateComponentsDropped', { name: planned.name, count: planned.components.length }),
      )
    }
    return { ...planned, statusPageKey: null, components: [] }
  })

  if (dryRun) return report

  // ---- Commit ---------------------------------------------------------------------------------
  const req: PayloadRequest = await createLocalReq({ user }, payload)
  const transactionID = await payload.db.beginTransaction()
  if (transactionID) req.transactionID = transactionID
  const createdMonitors: Monitor[] = []
  /** Planned status page key → created page id and row key → created row id. */
  const createdPages = new Map<string, { id: OrgId; rows: Map<string, string> }>()

  try {
    for (const planned of plan.notifications) {
      const doc = await payload.create({
        collection: 'notifications',
        data: {
          name: planned.name,
          type: planned.type,
          config: planned.config,
          isDefault: planned.isDefault,
          active: planned.active,
          organization: orgId as Notification['organization'],
        },
        depth: 0,
        req,
        user,
        overrideAccess: false,
      })
      notificationIds.set(planned.key, doc.id)
      created.notifications.push(doc.id)
    }

    for (const planned of orderedMonitors) {
      const parent = planned.parentKey ? (monitorIds.get(planned.parentKey) ?? null) : null
      const notifications = planned.notificationKeys
        .map((key) => notificationIds.get(key))
        .filter((id): id is OrgId => id !== undefined)
      const doc = await payload.create({
        collection: 'monitors',
        data: {
          ...planned.data,
          parent,
          notifications,
          ...(planned.pushToken ? { pushToken: planned.pushToken } : {}),
          organization: orgId,
        } as never,
        depth: 0,
        req,
        user,
        overrideAccess: false,
        // Schedules are registered after the transaction commits (see below).
        context: { skipEngineSync: true },
      })
      monitorIds.set(planned.key, doc.id)
      createdMonitors.push(doc)
      created.monitors.push(doc.id)
    }

    for (const planned of statusPages) {
      const doc = await payload.create({
        collection: 'status-pages',
        data: {
          ...planned.data,
          organization: orgId,
          ...(planned.subscriptions
            ? {
                subscriptions: {
                  enabled: planned.subscriptions.enabled,
                  channels: planned.subscriptions.channels,
                  deliveryMode: planned.subscriptions.deliveryMode,
                  // Only a channel imported in the same file; otherwise SMS is left unconfigured.
                  smsChannel: planned.subscriptions.smsChannelKey
                    ? (notificationIds.get(planned.subscriptions.smsChannelKey) ?? null)
                    : null,
                  smsMaxSegments: planned.subscriptions.smsMaxSegments,
                  smsTemplates: planned.subscriptions.smsTemplates,
                },
              }
            : {}),
          domains: planned.domains.map((hostname) => ({ hostname })),
          groups: planned.groups.map((group) => ({
            name: group.name,
            defaultOpen: group.defaultOpen ?? true,
            monitors: group.monitors
              .map((row) => ({
                type: row.type ?? 'monitor',
                monitor:
                  row.type === 'static' || row.monitorKey === null
                    ? null
                    : monitorIds.get(row.monitorKey),
                name: row.name ?? null,
                description: row.description ?? null,
                showValues: row.showValues ?? true,
                sendUrl: row.sendUrl,
                customUrl: row.customUrl,
              }))
              .filter((row) => row.type === 'static' || row.monitor != null),
          })),
        } as never,
        depth: 0,
        req,
        user,
        overrideAccess: false,
      })
      created.statusPages.push(doc.id)
      // Rows are created in plan order (minus those whose monitor was not imported), so the saved
      // rows line up with the planned ones that were kept.
      const keptRows = planned.groups.map((group) =>
        group.monitors.filter(
          (row) =>
            row.type === 'static' ||
            (row.monitorKey !== null && monitorIds.get(row.monitorKey) != null),
        ),
      )
      const rows = new Map<string, string>()
      ;(doc as StatusPage).groups?.forEach((group, g) =>
        group.monitors?.forEach((row, r) => {
          const key = keptRows[g]?.[r]?.key
          if (key && row.id) rows.set(key, row.id)
        }),
      )
      createdPages.set(planned.key, { id: doc.id, rows })
      for (const incident of planned.incidents) {
        await payload.create({
          collection: 'incidents',
          data: {
            ...incident,
            statusPage: doc.id,
            organization: orgId,
          } as Omit<Incident, 'id' | 'createdAt' | 'updatedAt'>,
          depth: 0,
          req,
          user,
          overrideAccess: false,
        })
      }
    }

    for (const planned of templates) {
      const page = planned.statusPageKey ? createdPages.get(planned.statusPageKey) : undefined
      const doc = await payload.create({
        collection: 'templates',
        data: {
          organization: orgId,
          name: planned.name,
          kind: planned.kind,
          title: planned.title,
          body: planned.body,
          status: planned.status,
          impact: planned.impact,
          duration: planned.duration,
          statusPage: page?.id ?? null,
          components: page
            ? planned.components.flatMap((row) => {
                const component = page.rows.get(row.componentKey)
                return component ? [{ component, impact: row.impact }] : []
              })
            : [],
        } as Omit<Template, 'id' | 'createdAt' | 'updatedAt'>,
        depth: 0,
        req,
        user,
        overrideAccess: false,
      })
      created.templates.push(doc.id)
    }

    if (transactionID) await payload.db.commitTransaction(transactionID)
  } catch (error) {
    if (transactionID) await payload.db.rollbackTransaction(transactionID)
    throw error
  }

  await scheduleImportedMonitors(createdMonitors, orgId)
  report.monitors.created = created.monitors
  report.notifications.created = created.notifications
  report.statusPages.created = created.statusPages
  report.templates.created = created.templates
  return report
}

/**
 * Register the check schedulers of the imported monitors and tell live dashboards about them,
 * once the documents are durable. Failures are logged, not thrown: the import itself succeeded.
 */
async function scheduleImportedMonitors(monitors: Monitor[], orgId: OrgId): Promise<void> {
  if (monitors.length === 0) return
  try {
    const { syncMonitor, engineHooksEnabled } = await import('@/server/engine/scheduler')
    if (!engineHooksEnabled()) return
    const { emitMonitorUpdated } = await import('@/server/realtime/emitter')
    for (const monitor of monitors) {
      if (monitor.active) await syncMonitor(monitor)
      emitMonitorUpdated(orgId, monitor)
    }
  } catch (err) {
    log.warn({ err, orgId, count: monitors.length }, 'failed to schedule imported monitors')
  }
}
