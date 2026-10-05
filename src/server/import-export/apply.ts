/**
 * Writes an import plan into one organization — or, on a dry run, only computes the report.
 *
 * Order: notifications → monitors (groups before their children) → status pages → incidents, so
 * every relationship can be resolved to a freshly created id. Everything runs in one database
 * transaction (same pattern as `runSetup`); on adapters without transactions the writes are
 * sequential and a failure leaves the documents created so far.
 *
 * Permissions: the caller must hold `monitor:create` (checked by the route). Notifications and
 * status pages are only imported when the caller also holds `notification:create` /
 * `status-page:create`; otherwise those parts are skipped with a warning.
 */
import { createLocalReq, type Payload, type PayloadRequest } from 'payload'

import { can, type OrgId } from '@/access/permissions'
import type { ImportReport, SkippedItem } from '@/lib/import-export'
import { childLogger } from '@/lib/logger'
import { validateOrganizationSlug } from '@/lib/reserved-slugs'
import type { Incident, Monitor, Notification, StatusPage } from '@/payload-types'
import type { RequestUser } from '@/server/monitors/http'

import type { ImportPlan, PlannedMonitor } from './types'

const log = childLogger('import-export')

export interface ApplyImportOptions {
  orgId: OrgId
  user: RequestUser
  plan: ImportPlan
  dryRun: boolean
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
  { orgId, user, plan, dryRun }: ApplyImportOptions,
): Promise<ImportReport> {
  const report: ImportReport = {
    format: plan.format,
    dryRun,
    monitors: { create: 0, skipped: [...plan.skipped.monitors] },
    notifications: { create: 0, skipped: [...plan.skipped.notifications] },
    statusPages: { create: 0, skipped: [...plan.skipped.statusPages] },
    tags: { create: 0, skipped: [...plan.skipped.tags] },
    warnings: [...plan.warnings],
  }
  const created = {
    monitors: [] as OrgId[],
    notifications: [] as OrgId[],
    statusPages: [] as OrgId[],
  }

  const skipAll = (items: { name: string }[], target: SkippedItem[], reason: string) => {
    for (const item of items) target.push({ name: item.name, reason })
  }

  // ---- Permissions per part -----------------------------------------------------------------
  if (!can(user, orgId, 'monitor:create')) {
    skipAll(
      plan.monitors.map((m) => ({ name: m.data.name })),
      report.monitors.skipped,
      'You may not create monitors in this organization',
    )
    plan = { ...plan, monitors: [] }
  }
  const canNotifications = can(user, orgId, 'notification:create')
  if (!canNotifications && plan.notifications.length > 0) {
    report.warnings.push(
      'Notification channels were skipped: creating channels requires the admin role. Monitors are imported without their channel links.',
    )
    skipAll(
      plan.notifications,
      report.notifications.skipped,
      'You may not create notification channels in this organization',
    )
    plan = { ...plan, notifications: [] }
  }
  const canStatusPages = can(user, orgId, 'status-page:create')
  if (!canStatusPages && plan.statusPages.length > 0) {
    report.warnings.push(
      'Status pages were skipped: you may not create status pages in this organization.',
    )
    skipAll(
      plan.statusPages.map((p) => ({ name: p.data.title })),
      report.statusPages.skipped,
      'You may not create status pages in this organization',
    )
    plan = { ...plan, statusPages: [] }
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
          reason: 'A channel with this name already exists; monitors are linked to it',
        })
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
    const valid = validateOrganizationSlug(page.data.slug)
    if (valid !== true) {
      report.statusPages.skipped.push({
        name: page.data.title,
        reason: `Invalid slug "${page.data.slug}": ${valid}`,
      })
      return []
    }
    const slug = uniqueSlug(page.data.slug, takenSlugs)
    takenSlugs.add(slug)
    if (slug !== page.data.slug) {
      report.warnings.push(
        `"${page.data.title}": slug "${page.data.slug}" is already in use; imported as "${slug}"`,
      )
    }
    const domains = page.domains.filter((hostname) => {
      if (takenHostnames.has(hostname)) {
        report.warnings.push(
          `"${page.data.title}": custom domain ${hostname} is already used by another status page and was dropped`,
        )
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

  if (dryRun) return report

  // ---- Commit ---------------------------------------------------------------------------------
  const req: PayloadRequest = await createLocalReq({ user }, payload)
  const transactionID = await payload.db.beginTransaction()
  if (transactionID) req.transactionID = transactionID
  const createdMonitors: Monitor[] = []

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
          domains: planned.domains.map((hostname) => ({ hostname })),
          groups: planned.groups.map((group) => ({
            name: group.name,
            monitors: group.monitors
              .map((row) => ({
                monitor: monitorIds.get(row.monitorKey),
                sendUrl: row.sendUrl,
                customUrl: row.customUrl,
              }))
              .filter((row) => row.monitor !== undefined),
          })),
        } as never,
        depth: 0,
        req,
        user,
        overrideAccess: false,
      })
      created.statusPages.push(doc.id)
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

    if (transactionID) await payload.db.commitTransaction(transactionID)
  } catch (error) {
    if (transactionID) await payload.db.rollbackTransaction(transactionID)
    throw error
  }

  await scheduleImportedMonitors(createdMonitors, orgId)
  report.monitors.created = created.monitors
  report.notifications.created = created.notifications
  report.statusPages.created = created.statusPages
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
