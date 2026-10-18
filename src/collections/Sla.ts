import {
  ValidationError,
  type CollectionBeforeChangeHook,
  type CollectionBeforeDeleteHook,
  type CollectionConfig,
  type FieldAccess,
  type PayloadRequest,
  type Where,
} from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { adminGroup, adminT } from '@/i18n/admin'
import {
  businessHoursOf,
  isSlaSchedule,
  normalizeThresholds,
  previousSchedulePeriod,
  SLA_CALCULATIONS,
  SLA_MAX_ALERT_THRESHOLDS,
  SLA_MAX_HOLIDAYS,
  SLA_MAX_RECIPIENTS,
  SLA_SCHEDULES,
  SLA_SUBJECTS,
  SLA_TARGET_MAX,
  SLA_TARGET_MIN,
  SLA_WEEKDAYS,
  SLA_WINDOWS,
} from '@/lib/sla'
import type { ErrorKey } from '@/server/errors'
import { userErrorText } from '@/server/request-locale'
import { loadSlaZone } from '@/server/sla/zone'
import type { SlaReport, SlaReportShare, SlaTarget } from '@/payload-types'

import { relId } from './shared'

/**
 * SLA targets, reports and report share links (#156). See `src/lib/sla.ts` for the maths and
 * `src/server/sla/` for report generation, scheduling and sharing.
 */

/** `req.context` flag the share route sets so `tokenHash` can be written on create. */
export const SLA_SHARE_SERVER_CONTEXT = 'slaShareServer'

const invalid = (req: PayloadRequest, collection: string, key: ErrorKey, path: string): never => {
  throw new ValidationError({
    collection,
    errors: [{ message: userErrorText(req, key), path }],
  })
}

const sameOrg = (a: unknown, b: unknown) => a !== null && String(a) === String(b)

const orgFilter = ({ data }: { data: unknown }): Where | true => {
  const organization = relId((data as { organization?: unknown })?.organization)
  return organization === null ? true : { organization: { equals: organization } }
}

const orgField = {
  name: 'organization',
  type: 'relationship',
  relationTo: 'organizations',
  required: true,
  index: true,
  admin: { position: 'sidebar' },
} as const

/** Server-owned bookkeeping: never written through the API (the worker uses `overrideAccess`). */
const serverOnly: FieldAccess = () => false

// ---- Targets ----------------------------------------------------------------------------------------

/**
 * What the target measures must belong to its organization (#274): a monitor, or a component or
 * group (array row ids) of one of its status pages. The fields of the other subjects are cleared;
 * the `manual` calculation needs a status page.
 */
const checkTargetSubject: CollectionBeforeChangeHook<SlaTarget> = async ({
  data,
  originalDoc,
  req,
}) => {
  const organization = relId(data.organization ?? originalDoc?.organization)
  const subject = data.subject ?? originalDoc?.subject ?? 'monitor'
  const calculation = data.calculation ?? originalDoc?.calculation ?? 'duration'
  if (subject === 'monitor') {
    data.statusPage = null
    data.component = null
    if (calculation === 'manual') invalid(req, 'sla-targets', 'slaManualNeedsPage', 'calculation')
    const monitorId = relId(data.monitor !== undefined ? data.monitor : originalDoc?.monitor)
    const monitor =
      monitorId === null
        ? null
        : await req.payload
            .findByID({
              collection: 'monitors',
              id: monitorId,
              depth: 0,
              req,
              overrideAccess: true,
              select: { organization: true },
            })
            .catch(() => null)
    if (!monitor || !sameOrg(relId(monitor.organization), organization)) {
      invalid(req, 'sla-targets', 'slaMonitorInvalid', 'monitor')
    }
    return data
  }

  data.monitor = null
  const pageId = relId(data.statusPage !== undefined ? data.statusPage : originalDoc?.statusPage)
  const component = String(
    (data.component !== undefined ? data.component : originalDoc?.component) ?? '',
  )
  const page =
    pageId === null
      ? null
      : await req.payload
          .findByID({
            collection: 'status-pages',
            id: pageId,
            depth: 0,
            req,
            overrideAccess: true,
            select: { organization: true, groups: true },
          })
          .catch(() => null)
  const groups = page?.groups ?? []
  const found =
    subject === 'group'
      ? groups.some((group) => group.id === component)
      : groups.some((group) => (group.monitors ?? []).some((row) => row.id === component))
  if (!page || !sameOrg(relId(page.organization), organization) || !component || !found) {
    invalid(req, 'sla-targets', 'slaComponentInvalid', 'component')
  }
  return data
}

/**
 * Error budget alerts (#274): thresholds within 0..100 (deduplicated, highest first) and channels
 * of the target's organization.
 */
const checkBudgetAlerts: CollectionBeforeChangeHook<SlaTarget> = async ({
  data,
  originalDoc,
  req,
}) => {
  if (!data.budgetAlerts) return data
  if (data.budgetAlerts.thresholds !== undefined) {
    data.budgetAlerts.thresholds = normalizeThresholds(data.budgetAlerts.thresholds)
  }
  const ids = [
    ...new Set(
      (data.budgetAlerts.notifications ?? []).map((n) => relId(n)).filter((n) => n !== null),
    ),
  ]
  if (data.budgetAlerts.notifications !== undefined) {
    data.budgetAlerts.notifications = ids as typeof data.budgetAlerts.notifications
  }
  if (ids.length > 0) {
    const organization = relId(data.organization ?? originalDoc?.organization)
    const { docs } = await req.payload.find({
      collection: 'notifications',
      where: { id: { in: ids } },
      depth: 0,
      limit: ids.length,
      pagination: false,
      req,
      overrideAccess: true,
      select: { organization: true },
    })
    if (
      docs.length !== ids.length ||
      docs.some((doc) => !sameOrg(relId(doc.organization), organization))
    ) {
      invalid(req, 'sla-targets', 'slaNotificationsInvalid', 'budgetAlerts')
    }
  }
  return data
}

/** An enabled business-hours calendar must be usable (#274); holidays are sorted and deduped. */
const checkBusinessHours: CollectionBeforeChangeHook<SlaTarget> = ({ data, originalDoc, req }) => {
  const merged = { ...originalDoc?.businessHours, ...data.businessHours }
  if (Array.isArray(data.businessHours?.holidays)) {
    const dates = [
      ...new Set(data.businessHours.holidays.map((row) => String(row?.date ?? '').trim())),
    ]
    data.businessHours.holidays = dates
      .filter(Boolean)
      .sort()
      .map((date) => ({ date }))
    merged.holidays = data.businessHours.holidays
  }
  if (merged.enabled && !businessHoursOf({ businessHours: merged })) {
    invalid(req, 'sla-targets', 'slaBusinessHoursInvalid', 'businessHours')
  }
  return data
}

/** Reports keep a list of targets; a deleted target leaves them (Mongo keeps no foreign keys). */
const detachTargetFromReports: CollectionBeforeDeleteHook = async ({ id, req }) => {
  const { docs } = await req.payload.find({
    collection: 'sla-reports',
    where: { targets: { in: [id] } },
    depth: 0,
    limit: 0,
    pagination: false,
    req,
    overrideAccess: true,
    select: { targets: true },
  })
  for (const report of docs) {
    await req.payload.update({
      collection: 'sla-reports',
      id: report.id,
      data: {
        targets: (report.targets ?? [])
          .map((target) => relId(target))
          .filter((target) => target !== null && String(target) !== String(id)),
      } as Partial<SlaReport>,
      depth: 0,
      req,
      overrideAccess: true,
    })
  }
}

export const SlaTargets: CollectionConfig = {
  slug: 'sla-targets',
  admin: {
    useAsTitle: 'target',
    group: adminGroup('statistics'),
    defaultColumns: ['subject', 'monitor', 'statusPage', 'target', 'period', 'organization'],
  },
  access: {
    read: orgScoped('sla:read'),
    create: orgScoped('sla:manage'),
    update: orgScoped('sla:manage'),
    delete: orgScoped('sla:manage'),
  },
  hooks: {
    beforeChange: [checkTargetSubject, checkBusinessHours, checkBudgetAlerts],
    beforeDelete: [detachTargetFromReports],
  },
  fields: [
    orgField,
    {
      name: 'subject',
      type: 'select',
      defaultValue: 'monitor',
      options: SLA_SUBJECTS.map((value) => ({ label: value, value })),
      admin: { description: adminT('marmot:slaTargets:subjectDescription') },
    },
    {
      name: 'monitor',
      type: 'relationship',
      relationTo: 'monitors',
      index: true,
      filterOptions: orgFilter,
      admin: { condition: (data) => (data?.subject ?? 'monitor') === 'monitor' },
    },
    {
      // Component and group targets (#274): the status page and the row id of the component
      // (`groups[].monitors[].id`) or the group (`groups[].id`).
      name: 'statusPage',
      type: 'relationship',
      relationTo: 'status-pages',
      index: true,
      filterOptions: orgFilter,
      admin: { condition: (data) => data?.subject === 'component' || data?.subject === 'group' },
    },
    {
      name: 'component',
      type: 'text',
      admin: {
        condition: (data) => data?.subject === 'component' || data?.subject === 'group',
        description: adminT('marmot:slaTargets:componentDescription'),
      },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'target',
          type: 'number',
          required: true,
          min: SLA_TARGET_MIN,
          max: SLA_TARGET_MAX,
          admin: { description: adminT('marmot:slaTargets:targetDescription') },
        },
        {
          name: 'period',
          type: 'select',
          required: true,
          defaultValue: 'month',
          options: SLA_WINDOWS.map((value) => ({ label: value, value })),
        },
        {
          name: 'calculation',
          type: 'select',
          required: true,
          defaultValue: 'duration',
          options: SLA_CALCULATIONS.map((value) => ({ label: value, value })),
          admin: { description: adminT('marmot:slaTargets:calculationDescription') },
        },
      ],
    },
    {
      name: 'excludeMaintenance',
      type: 'checkbox',
      defaultValue: true,
      admin: { description: adminT('marmot:slaTargets:excludeMaintenanceDescription') },
    },
    {
      // Business-hours calendar (#274): only these hours of the organization's time zone count.
      name: 'businessHours',
      type: 'group',
      admin: { description: adminT('marmot:slaTargets:businessHoursDescription') },
      fields: [
        { name: 'enabled', type: 'checkbox', defaultValue: false },
        {
          name: 'days',
          type: 'select',
          hasMany: true,
          defaultValue: ['mon', 'tue', 'wed', 'thu', 'fri'],
          options: SLA_WEEKDAYS.map((value) => ({ label: value, value })),
        },
        {
          type: 'row',
          fields: [
            {
              name: 'start',
              type: 'text',
              defaultValue: '09:00',
              admin: { description: adminT('marmot:slaTargets:businessStartDescription') },
            },
            {
              name: 'end',
              type: 'text',
              defaultValue: '17:00',
              admin: { description: adminT('marmot:slaTargets:businessEndDescription') },
            },
          ],
        },
        {
          name: 'holidays',
          type: 'array',
          maxRows: SLA_MAX_HOLIDAYS,
          admin: { description: adminT('marmot:slaTargets:holidaysDescription') },
          fields: [{ name: 'date', type: 'text', required: true }],
        },
      ],
    },
    {
      // Error budget alerts (#274): notify these channels once per period and threshold when the
      // remaining budget drops below a threshold.
      name: 'budgetAlerts',
      type: 'group',
      fields: [
        {
          name: 'thresholds',
          type: 'number',
          hasMany: true,
          min: 0,
          max: 100,
          maxRows: SLA_MAX_ALERT_THRESHOLDS,
          admin: { description: adminT('marmot:slaTargets:thresholdsDescription') },
        },
        {
          name: 'notifications',
          type: 'relationship',
          relationTo: 'notifications',
          hasMany: true,
          filterOptions: orgFilter,
        },
      ],
    },
    {
      // `{ period, sent }`: the thresholds already alerted on in the current period.
      name: 'budgetAlertState',
      type: 'json',
      access: { create: serverOnly, update: serverOnly },
      admin: {
        readOnly: true,
        description: adminT('marmot:slaTargets:budgetAlertStateDescription'),
      },
    },
  ],
  timestamps: true,
}

// ---- Reports ----------------------------------------------------------------------------------------

const normalizeReport: CollectionBeforeChangeHook<SlaReport> = async ({
  data,
  originalDoc,
  req,
}) => {
  if (typeof data.name === 'string') data.name = data.name.trim()
  const organization = relId(data.organization ?? originalDoc?.organization)

  if (Array.isArray(data.targets)) {
    const ids = [...new Set(data.targets.map((t) => relId(t)).filter((t) => t !== null))]
    if (ids.length > 0) {
      const { docs } = await req.payload.find({
        collection: 'sla-targets',
        where: { id: { in: ids } },
        depth: 0,
        limit: ids.length,
        pagination: false,
        req,
        overrideAccess: true,
        select: { organization: true },
      })
      if (
        docs.length !== ids.length ||
        docs.some((doc) => !sameOrg(relId(doc.organization), organization))
      ) {
        invalid(req, 'sla-reports', 'slaTargetsInvalid', 'targets')
      }
    }
    data.targets = ids as SlaReport['targets']
  }

  if (Array.isArray(data.recipients)) {
    const seen = new Set<string>()
    data.recipients = data.recipients
      .map((row) => ({ ...row, email: String(row?.email ?? '').trim() }))
      .filter((row) => {
        const key = row.email.toLowerCase()
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
  }
  const schedule = data.schedule ?? originalDoc?.schedule ?? 'none'
  const recipients = data.recipients ?? originalDoc?.recipients ?? []
  if (schedule !== 'none' && recipients.length === 0) {
    invalid(req, 'sla-reports', 'slaRecipientsRequired', 'recipients')
  }
  // A new schedule starts with the next period to complete: the one that just ended counts as
  // sent, so creating a monthly report mid-month does not email last month's report at once.
  if (data.schedule !== undefined && data.schedule !== originalDoc?.schedule) {
    data.lastSentPeriod = isSlaSchedule(data.schedule)
      ? (previousSchedulePeriod(
          data.schedule,
          new Date(),
          await loadSlaZone(req.payload, organization, req),
        )?.key ?? null)
      : null
  }
  return data
}

/** Share links reference the report with a NOT NULL foreign key on Postgres. */
const removeReportShares: CollectionBeforeDeleteHook = async ({ id, req }) => {
  await req.payload.delete({
    collection: 'sla-report-shares',
    where: { report: { equals: id } },
    depth: 0,
    req,
    overrideAccess: true,
  })
}

export const SlaReports: CollectionConfig = {
  slug: 'sla-reports',
  admin: {
    useAsTitle: 'name',
    group: adminGroup('statistics'),
    defaultColumns: ['name', 'schedule', 'lastSentAt', 'organization'],
  },
  access: {
    read: orgScoped('sla:read'),
    create: orgScoped('sla:manage'),
    update: orgScoped('sla:manage'),
    delete: orgScoped('sla:manage'),
  },
  hooks: {
    beforeChange: [normalizeReport],
    beforeDelete: [removeReportShares],
  },
  fields: [
    orgField,
    { name: 'name', type: 'text', required: true, maxLength: 100 },
    {
      name: 'targets',
      type: 'relationship',
      relationTo: 'sla-targets',
      hasMany: true,
      filterOptions: orgFilter,
    },
    {
      name: 'schedule',
      type: 'select',
      required: true,
      defaultValue: 'none',
      options: SLA_SCHEDULES.map((value) => ({ label: value, value })),
      admin: { description: adminT('marmot:slaReports:scheduleDescription') },
    },
    {
      name: 'recipients',
      type: 'array',
      maxRows: SLA_MAX_RECIPIENTS,
      fields: [{ name: 'email', type: 'email', required: true }],
    },
    {
      name: 'lastSentPeriod',
      type: 'text',
      access: { create: serverOnly, update: serverOnly },
      admin: { readOnly: true, description: adminT('marmot:slaReports:lastSentPeriodDescription') },
    },
    {
      name: 'lastSentAt',
      type: 'date',
      access: { create: serverOnly, update: serverOnly },
      admin: { readOnly: true },
    },
    {
      name: 'lastError',
      type: 'text',
      access: { create: serverOnly, update: serverOnly },
      admin: { readOnly: true },
    },
  ],
  timestamps: true,
}

// ---- Share links ------------------------------------------------------------------------------------

const checkShareReport: CollectionBeforeChangeHook<SlaReportShare> = async ({
  data,
  originalDoc,
  req,
}) => {
  const organization = relId(data.organization ?? originalDoc?.organization)
  const reportId = relId(data.report ?? originalDoc?.report)
  const report =
    reportId === null
      ? null
      : await req.payload
          .findByID({
            collection: 'sla-reports',
            id: reportId,
            depth: 0,
            req,
            overrideAccess: true,
            select: { organization: true },
          })
          .catch(() => null)
  if (!report || !sameOrg(relId(report.organization), organization)) {
    invalid(req, 'sla-report-shares', 'slaReportNotFound', 'report')
  }
  return data
}

export const SlaReportShares: CollectionConfig = {
  slug: 'sla-report-shares',
  admin: {
    useAsTitle: 'fromDate',
    group: adminGroup('statistics'),
    defaultColumns: ['report', 'fromDate', 'toDate', 'revokedAt', 'organization'],
  },
  access: {
    read: orgScoped('sla:manage'),
    create: orgScoped('sla:manage'),
    update: orgScoped('sla:manage'),
    delete: orgScoped('sla:manage'),
  },
  hooks: {
    beforeChange: [checkShareReport],
  },
  fields: [
    orgField,
    {
      name: 'report',
      type: 'relationship',
      relationTo: 'sla-reports',
      required: true,
      index: true,
    },
    {
      // SHA-256 of the link token; the token itself is shown once and never stored.
      name: 'tokenHash',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      access: {
        read: () => false,
        create: ({ req }) => req.context?.[SLA_SHARE_SERVER_CONTEXT] === true,
        update: () => false,
      },
      admin: { hidden: true },
    },
    {
      type: 'row',
      fields: [
        // Inclusive `YYYY-MM-DD` dates (UTC days) of the shared range.
        { name: 'fromDate', type: 'text', required: true, access: { update: serverOnly } },
        { name: 'toDate', type: 'text', required: true, access: { update: serverOnly } },
      ],
    },
    {
      name: 'createdBy',
      type: 'relationship',
      relationTo: 'users',
      access: { update: serverOnly },
      admin: { readOnly: true },
    },
    {
      name: 'revokedAt',
      type: 'date',
      index: true,
      // Revoking is final: a revoked link cannot be brought back (create a new one instead).
      access: { create: serverOnly, update: ({ doc }) => !doc?.revokedAt },
      admin: { description: adminT('marmot:slaReportShares:revokedAtDescription') },
    },
  ],
  timestamps: true,
}
