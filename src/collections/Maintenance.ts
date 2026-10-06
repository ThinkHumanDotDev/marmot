import {
  ValidationError,
  type CollectionAfterChangeHook,
  type CollectionAfterDeleteHook,
  type CollectionBeforeChangeHook,
  type CollectionBeforeValidateHook,
  type CollectionConfig,
  type CollectionSlug,
  type PayloadRequest,
  type Where,
} from 'payload'

import { orgScoped } from '@/access/org-scoped'
import { env } from '@/env'
import { childLogger } from '@/lib/logger'
import {
  DAY_OF_MONTH_VALUES,
  LAST_DAY_LABELS,
  LAST_DAY_VALUES,
  MAINTENANCE_STATUS_LABELS,
  MAINTENANCE_STATUSES,
  MAINTENANCE_STRATEGIES,
  MAINTENANCE_STRATEGY_LABELS,
  MAX_DURATION_MINUTES,
  MAX_INTERVAL_DAYS,
  SAME_AS_SERVER,
  WEEKDAY_OPTIONS,
  isRecurringStrategy,
  isValidTimezone,
  type LastDayValue,
} from '@/lib/validation/maintenance'
import type { Maintenance as MaintenanceDoc } from '@/payload-types'
import { buildCron, getMaintenanceStatus, validateCron } from '@/server/maintenance/status'
import { getOrganizationTimezone } from '@/server/maintenance/timezone'

const log = childLogger('maintenance')

const relId = (value: unknown): string | number | null => {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

const fail = (message: string, path: string): never => {
  throw new ValidationError({ collection: 'maintenance', errors: [{ message, path }] })
}

/**
 * Schedule consistency (Uptime Kuma `Maintenance.jsonToBean` + `validateCron`): a single window
 * needs both dates, recurring strategies need a usable day list, cron patterns must parse.
 */
const validateSchedule: CollectionBeforeValidateHook<MaintenanceDoc> = ({ data, originalDoc }) => {
  if (!data) return data
  const merged = { ...originalDoc, ...data } as Partial<MaintenanceDoc>
  const strategy = merged.strategy

  if (strategy === 'single') {
    if (!merged.dateRange?.start) fail('Start is required for a single window.', 'dateRange.start')
    if (!merged.dateRange?.end) fail('End is required for a single window.', 'dateRange.end')
  }
  if (merged.dateRange?.start && merged.dateRange?.end) {
    const start = new Date(merged.dateRange.start).getTime()
    const end = new Date(merged.dateRange.end).getTime()
    if (Number.isNaN(start)) fail('Invalid start date.', 'dateRange.start')
    if (Number.isNaN(end)) fail('Invalid end date.', 'dateRange.end')
    if (end <= start) fail('End must be after the start.', 'dateRange.end')
  }

  if (strategy === 'cron' || isRecurringStrategy(strategy)) {
    const pattern = buildCron(merged as MaintenanceDoc)
    if (!pattern) {
      if (strategy === 'recurring-weekday') fail('Pick at least one weekday.', 'weekdays')
      if (strategy === 'recurring-day-of-month') fail('Pick at least one day.', 'daysOfMonth')
      fail('The schedule is incomplete.', strategy === 'cron' ? 'cron' : 'timeRange')
    }
    try {
      validateCron(pattern as string)
    } catch (error) {
      fail(
        `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`,
        'cron',
      )
    }
  }

  if (merged.timezone && !isValidTimezone(merged.timezone)) {
    fail(`Unknown time zone "${merged.timezone}".`, 'timezone')
  }
  return data
}

/** Every referenced document must belong to the maintenance's organization. */
async function assertSameOrganization(
  req: PayloadRequest,
  collection: CollectionSlug,
  ids: unknown[] | null | undefined,
  organization: string | number | null,
  path: string,
  label: string,
) {
  const wanted = new Set(
    (ids ?? [])
      .map(relId)
      .filter((id): id is string | number => id !== null)
      .map(String),
  )
  if (wanted.size === 0) return
  const { docs } = await req.payload.find({
    collection,
    where: { id: { in: [...wanted] } },
    depth: 0,
    limit: wanted.size,
    pagination: false,
    req,
    overrideAccess: true,
  })
  const foreign = docs.filter(
    (doc) =>
      String(relId((doc as { organization?: unknown }).organization)) !== String(organization),
  )
  if (foreign.length > 0 || docs.length !== wanted.size) {
    fail(`Every ${label} must belong to the same organization.`, path)
  }
}

/** Reference checks, then the persisted status for the stored document. */
const prepare: CollectionBeforeChangeHook<MaintenanceDoc> = async ({ data, originalDoc, req }) => {
  if (req.context?.skipMaintenanceHooks) return data
  const organization = relId(data.organization ?? originalDoc?.organization)

  if (data.monitors !== undefined) {
    await assertSameOrganization(
      req,
      'monitors',
      data.monitors,
      organization,
      'monitors',
      'monitor',
    )
  }
  if (data.statusPages !== undefined) {
    await assertSameOrganization(
      req,
      'status-pages',
      data.statusPages,
      organization,
      'statusPages',
      'status page',
    )
  }

  const merged = { ...originalDoc, ...data } as MaintenanceDoc
  const serverTimezone = await getOrganizationTimezone(req.payload, organization, req)
  data.status = getMaintenanceStatus(merged, new Date(), { serverTimezone })
  return data
}

async function publishList(doc: MaintenanceDoc, req: PayloadRequest) {
  if (req.context?.skipMaintenanceHooks || env.MARMOT_DISABLE_ENGINE_HOOKS) return
  const organization = relId(doc.organization)
  if (organization === null) return
  try {
    const { emitOrgMaintenanceList } = await import('@/server/maintenance/realtime')
    await emitOrgMaintenanceList(req.payload, organization)
  } catch (err) {
    log.warn({ err, maintenanceId: doc.id }, 'failed to publish the maintenance list')
  }
}

const afterChange: CollectionAfterChangeHook<MaintenanceDoc> = async ({ doc, req }) => {
  await publishList(doc, req)
  return doc
}

const afterDelete: CollectionAfterDeleteHook<MaintenanceDoc> = async ({ doc, req }) => {
  await publishList(doc, req)
  return doc
}

const onlyWhen = (strategies: readonly string[]) => (data: Partial<MaintenanceDoc>) =>
  strategies.includes(data?.strategy ?? '')

const dayOfMonthLabel = (value: string): string =>
  (LAST_DAY_VALUES as readonly string[]).includes(value)
    ? LAST_DAY_LABELS[value as LastDayValue]
    : value

/**
 * Maintenance windows (Uptime Kuma feature set). While a window is running, the monitors listed in
 * `monitors` (and the children of listed groups) produce MAINTENANCE heartbeats instead of being
 * checked, and the status pages listed in `statusPages` show a banner. `status` is written by the
 * hooks on save and refreshed every minute by the worker (`src/server/maintenance/job.ts`).
 */
export const Maintenance: CollectionConfig = {
  slug: 'maintenance',
  admin: {
    useAsTitle: 'title',
    group: 'Monitoring',
    defaultColumns: ['title', 'strategy', 'status', 'active', 'organization'],
  },
  access: {
    read: orgScoped('maintenance:read'),
    create: orgScoped('maintenance:create'),
    update: orgScoped('maintenance:update'),
    delete: orgScoped('maintenance:delete'),
  },
  indexes: [{ fields: ['organization', 'active'] }],
  hooks: {
    beforeValidate: [validateSchedule],
    beforeChange: [prepare],
    afterChange: [afterChange],
    afterDelete: [afterDelete],
  },
  fields: [
    {
      name: 'organization',
      type: 'relationship',
      relationTo: 'organizations',
      required: true,
      index: true,
      admin: { position: 'sidebar' },
    },
    { name: 'title', type: 'text', required: true },
    { name: 'description', type: 'textarea', admin: { description: 'Shown on status pages.' } },
    {
      type: 'row',
      fields: [
        {
          name: 'strategy',
          type: 'select',
          required: true,
          defaultValue: 'single',
          options: MAINTENANCE_STRATEGIES.map((value) => ({
            value,
            label: MAINTENANCE_STRATEGY_LABELS[value],
          })),
        },
        {
          name: 'timezone',
          type: 'text',
          defaultValue: SAME_AS_SERVER,
          admin: {
            description: `IANA time zone the schedule is written in, or ${SAME_AS_SERVER} for the organization's zone.`,
          },
        },
      ],
    },
    {
      name: 'active',
      type: 'checkbox',
      defaultValue: true,
      index: true,
      admin: { position: 'sidebar', description: 'Paused maintenances never run.' },
    },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'unknown',
      index: true,
      options: MAINTENANCE_STATUSES.map((value) => ({
        value,
        label: MAINTENANCE_STATUS_LABELS[value],
      })),
      admin: {
        position: 'sidebar',
        readOnly: true,
        description: 'Maintained by the server; recomputed every minute.',
      },
    },

    // ---- Schedule -------------------------------------------------------------------------------
    {
      name: 'dateRange',
      type: 'group',
      admin: {
        condition: (data) => data?.strategy !== 'manual',
        description:
          'Single window: when it runs. Recurring/cron: optional effective range. Wall-clock in the time zone above (YYYY-MM-DDTHH:mm).',
      },
      fields: [
        {
          type: 'row',
          fields: [
            { name: 'start', type: 'text', admin: { placeholder: '2026-01-31T22:00' } },
            { name: 'end', type: 'text', admin: { placeholder: '2026-02-01T02:00' } },
          ],
        },
      ],
    },
    {
      name: 'timeRange',
      type: 'group',
      admin: {
        condition: onlyWhen(['recurring-interval', 'recurring-weekday', 'recurring-day-of-month']),
        description: 'Daily window (HH:mm); an end before the start runs past midnight.',
      },
      fields: [
        {
          type: 'row',
          fields: [
            { name: 'start', type: 'text', defaultValue: '02:00' },
            { name: 'end', type: 'text', defaultValue: '03:00' },
          ],
        },
      ],
    },
    {
      name: 'intervalDay',
      type: 'number',
      defaultValue: 1,
      min: 1,
      max: MAX_INTERVAL_DAYS,
      admin: {
        condition: onlyWhen(['recurring-interval']),
        description: 'Run every N days, counted from the start date.',
      },
    },
    {
      name: 'weekdays',
      type: 'select',
      hasMany: true,
      options: WEEKDAY_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
      admin: { condition: onlyWhen(['recurring-weekday']) },
    },
    {
      name: 'daysOfMonth',
      type: 'select',
      hasMany: true,
      options: DAY_OF_MONTH_VALUES.map((value) => ({ value, label: dayOfMonthLabel(value) })),
      admin: {
        condition: onlyWhen(['recurring-day-of-month']),
        description:
          'Only "Last day of the month" has a cron equivalent; 2nd–4th last are ignored.',
      },
    },
    {
      type: 'row',
      admin: { condition: onlyWhen(['cron']) },
      fields: [
        {
          name: 'cron',
          type: 'text',
          defaultValue: '30 3 * * *',
          admin: { description: 'Five-field cron expression, evaluated in the time zone.' },
        },
        {
          name: 'duration',
          type: 'number',
          defaultValue: 60,
          min: 1,
          max: MAX_DURATION_MINUTES,
          admin: { description: 'Minutes each occurrence lasts.' },
        },
      ],
    },

    // ---- Targets --------------------------------------------------------------------------------
    {
      name: 'monitors',
      type: 'relationship',
      relationTo: 'monitors',
      hasMany: true,
      filterOptions: ({ data }): Where | boolean =>
        data?.organization ? { organization: { equals: data.organization } } : true,
      admin: {
        description: 'Affected monitors: checks are skipped and MAINTENANCE heartbeats written.',
      },
    },
    {
      name: 'statusPages',
      type: 'relationship',
      relationTo: 'status-pages',
      hasMany: true,
      filterOptions: ({ data }): Where | boolean =>
        data?.organization ? { organization: { equals: data.organization } } : true,
      admin: { description: 'Status pages that announce this maintenance.' },
    },
  ],
  timestamps: true,
}
