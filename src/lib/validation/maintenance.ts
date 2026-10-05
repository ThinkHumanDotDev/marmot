/**
 * Maintenance window schema, shared by the create/edit form (client) and the route handlers
 * (server). Mirrors the `maintenance` collection (`src/collections/Maintenance.ts`) and the form
 * semantics of Uptime Kuma's `src/pages/EditMaintenance.vue`.
 *
 * Keep this module free of server-only imports: it is bundled into client components.
 */
import { Cron } from 'croner'
import { z } from 'zod'

export const MAINTENANCE_STRATEGIES = [
  'manual',
  'single',
  'recurring-interval',
  'recurring-weekday',
  'recurring-day-of-month',
  'cron',
] as const
export type MaintenanceStrategy = (typeof MAINTENANCE_STRATEGIES)[number]

export const MAINTENANCE_STRATEGY_LABELS: Record<MaintenanceStrategy, string> = {
  manual: 'Manual (active until you pause it)',
  single: 'Single maintenance window',
  'recurring-interval': 'Recurring – every N days',
  'recurring-weekday': 'Recurring – days of the week',
  'recurring-day-of-month': 'Recurring – days of the month',
  cron: 'Cron expression',
}

export const RECURRING_STRATEGIES: readonly MaintenanceStrategy[] = [
  'recurring-interval',
  'recurring-weekday',
  'recurring-day-of-month',
]

export const isRecurringStrategy = (strategy: string | null | undefined): boolean =>
  Boolean(strategy && (RECURRING_STRATEGIES as readonly string[]).includes(strategy))

/** Strategies with a date range, a timezone and computed windows (everything but `manual`). */
export const hasSchedule = (strategy: string | null | undefined): boolean =>
  Boolean(strategy && strategy !== 'manual')

export const MAINTENANCE_STATUSES = [
  'inactive',
  'scheduled',
  'under-maintenance',
  'ended',
  'unknown',
] as const
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number]

export const MAINTENANCE_STATUS_LABELS: Record<MaintenanceStatus, string> = {
  inactive: 'Paused',
  scheduled: 'Scheduled',
  'under-maintenance': 'Under maintenance',
  ended: 'Ended',
  unknown: 'Unknown',
}

/** Sunday is 0, like cron and JavaScript. Stored as strings (Payload `select` values). */
export const WEEKDAY_VALUES = ['0', '1', '2', '3', '4', '5', '6'] as const
export type WeekdayValue = (typeof WEEKDAY_VALUES)[number]
export const WEEKDAY_OPTIONS: { value: WeekdayValue; label: string }[] = [
  { value: '1', label: 'Mon' },
  { value: '2', label: 'Tue' },
  { value: '3', label: 'Wed' },
  { value: '4', label: 'Thu' },
  { value: '5', label: 'Fri' },
  { value: '6', label: 'Sat' },
  { value: '0', label: 'Sun' },
]

export const LAST_DAY_VALUES = ['lastDay1', 'lastDay2', 'lastDay3', 'lastDay4'] as const
export type LastDayValue = (typeof LAST_DAY_VALUES)[number]
export const LAST_DAY_LABELS: Record<LastDayValue, string> = {
  lastDay1: 'Last day of the month',
  lastDay2: '2nd last day of the month',
  lastDay3: '3rd last day of the month',
  lastDay4: '4th last day of the month',
}

export const DAY_OF_MONTH_VALUES = [
  ...Array.from({ length: 31 }, (_, i) => String(i + 1)),
  ...LAST_DAY_VALUES,
] as const
export type DayOfMonthValue = (typeof DAY_OF_MONTH_VALUES)[number]

/** `timezone` value meaning "use the organization's / server's timezone" (Uptime Kuma name). */
export const SAME_AS_SERVER = 'SAME_AS_SERVER'

export const MAX_INTERVAL_DAYS = 3650
/** Cron windows longer than a year make no sense; keeps the number field bounded. */
export const MAX_DURATION_MINUTES = 365 * 24 * 60

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
/** `datetime-local` value (`YYYY-MM-DDTHH:mm`, optional seconds) or an ISO instant. */
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/

export const isValidTime = (value: string): boolean => TIME_PATTERN.test(value)

export const isValidDateTime = (value: string): boolean =>
  DATE_TIME_PATTERN.test(value) && !Number.isNaN(new Date(value).getTime())

export function isValidCron(value: string): boolean {
  try {
    // Without a callback nothing is scheduled; the constructor only parses the pattern.
    new Cron(value, { timezone: 'UTC' })
    return true
  } catch {
    return false
  }
}

export function isValidTimezone(value: string): boolean {
  if (value === SAME_AS_SERVER) return true
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

const optionalText = z
  .string()
  .trim()
  .max(2000)
  .nullish()
  .transform((v) => (v ? v : null))

/** `datetime-local` inputs hand back `''` when cleared; store `null`. */
const optionalDateTime = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || isValidDateTime(v), 'Enter a valid date and time')

const relationIdSchema = z.union([z.string().min(1), z.number().int()])

export const maintenanceFormSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(150),
    description: optionalText,
    strategy: z.enum(MAINTENANCE_STRATEGIES),
    active: z.boolean().default(true),
    dateRange: z
      .object({ start: optionalDateTime, end: optionalDateTime })
      .default({ start: null, end: null }),
    timeRange: z
      .object({
        start: z.string().trim().refine(isValidTime, 'Use HH:mm'),
        end: z.string().trim().refine(isValidTime, 'Use HH:mm'),
      })
      .default({ start: '02:00', end: '03:00' }),
    intervalDay: z.coerce.number().int().min(1).max(MAX_INTERVAL_DAYS).default(1),
    weekdays: z.array(z.enum(WEEKDAY_VALUES)).default([]),
    daysOfMonth: z.array(z.enum(DAY_OF_MONTH_VALUES)).default([]),
    cron: z.string().trim().default('30 3 * * *'),
    duration: z.coerce.number().int().min(1).max(MAX_DURATION_MINUTES).default(60),
    timezone: z
      .string()
      .trim()
      .default(SAME_AS_SERVER)
      .refine(isValidTimezone, 'Unknown time zone'),
    monitors: z.array(relationIdSchema).default([]),
    statusPages: z.array(relationIdSchema).default([]),
  })
  .superRefine((values, ctx) => {
    const { strategy, dateRange } = values
    const start = dateRange.start ? new Date(dateRange.start).getTime() : null
    const end = dateRange.end ? new Date(dateRange.end).getTime() : null

    if (strategy === 'single') {
      if (start === null) {
        ctx.addIssue({ code: 'custom', path: ['dateRange', 'start'], message: 'Start is required' })
      }
      if (end === null) {
        ctx.addIssue({ code: 'custom', path: ['dateRange', 'end'], message: 'End is required' })
      }
    }
    if (start !== null && end !== null && end <= start) {
      ctx.addIssue({
        code: 'custom',
        path: ['dateRange', 'end'],
        message: 'End must be after the start',
      })
    }

    if (isRecurringStrategy(strategy) && values.timeRange.start === values.timeRange.end) {
      ctx.addIssue({
        code: 'custom',
        path: ['timeRange', 'end'],
        message: 'The window must be longer than zero minutes',
      })
    }
    if (strategy === 'recurring-weekday' && values.weekdays.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['weekdays'], message: 'Pick at least one day' })
    }
    if (strategy === 'recurring-day-of-month' && values.daysOfMonth.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['daysOfMonth'], message: 'Pick at least one day' })
    }
    if (strategy === 'cron' && !isValidCron(values.cron)) {
      ctx.addIssue({ code: 'custom', path: ['cron'], message: 'Invalid cron expression' })
    }
  })

export type MaintenanceFormValues = z.output<typeof maintenanceFormSchema>
export type MaintenanceFormInput = z.input<typeof maintenanceFormSchema>

/** `datetime-local` value for a local `Date` (no seconds, no zone). */
export function toDateTimeLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

/** Defaults for the create form: a one-hour single window starting now (Uptime Kuma's defaults). */
export function defaultMaintenanceValues(now: Date = new Date()): MaintenanceFormValues {
  const oneHourLater = new Date(now.getTime() + 60 * 60_000)
  return {
    title: '',
    description: null,
    strategy: 'single',
    active: true,
    dateRange: { start: toDateTimeLocal(now), end: toDateTimeLocal(oneHourLater) },
    timeRange: { start: '02:00', end: '03:00' },
    intervalDay: 1,
    weekdays: [],
    daysOfMonth: [],
    cron: '30 3 * * *',
    duration: 60,
    timezone: SAME_AS_SERVER,
    monitors: [],
    statusPages: [],
  }
}

/** Minimal shape of a stored maintenance document the form needs (ids may be numbers or docs). */
export interface MaintenanceDocLike {
  title: string
  description?: string | null
  strategy: MaintenanceStrategy | string
  active?: boolean | null
  dateRange?: { start?: string | null; end?: string | null } | null
  timeRange?: { start?: string | null; end?: string | null } | null
  intervalDay?: number | null
  weekdays?: (string | number)[] | null
  daysOfMonth?: (string | number)[] | null
  cron?: string | null
  duration?: number | null
  timezone?: string | null
  monitors?: unknown[] | null
  statusPages?: unknown[] | null
}

const idOf = (value: unknown): string | null => {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return String(id)
  }
  return null
}

const idList = (values: unknown[] | null | undefined): string[] =>
  (values ?? []).map(idOf).filter((id): id is string => id !== null)

/** Stored document → form values (relationship ids become strings). */
export function maintenanceToFormValues(doc: MaintenanceDocLike): MaintenanceFormValues {
  const defaults = defaultMaintenanceValues()
  const strategy = (MAINTENANCE_STRATEGIES as readonly string[]).includes(doc.strategy)
    ? (doc.strategy as MaintenanceStrategy)
    : 'single'
  return {
    title: doc.title,
    description: doc.description ?? null,
    strategy,
    active: doc.active !== false,
    dateRange: {
      start: doc.dateRange?.start ?? null,
      end: doc.dateRange?.end ?? null,
    },
    timeRange: {
      start: doc.timeRange?.start || defaults.timeRange.start,
      end: doc.timeRange?.end || defaults.timeRange.end,
    },
    intervalDay: doc.intervalDay ?? 1,
    weekdays: (doc.weekdays ?? [])
      .map(String)
      .filter((v): v is WeekdayValue => (WEEKDAY_VALUES as readonly string[]).includes(v)),
    daysOfMonth: (doc.daysOfMonth ?? [])
      .map(String)
      .filter((v): v is DayOfMonthValue => (DAY_OF_MONTH_VALUES as readonly string[]).includes(v)),
    cron: doc.cron || defaults.cron,
    duration: doc.duration ?? defaults.duration,
    timezone: doc.timezone || SAME_AS_SERVER,
    monitors: idList(doc.monitors),
    statusPages: idList(doc.statusPages),
  }
}
