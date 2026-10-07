/**
 * Maintenance announcements (issue #154): the lifecycle of one occurrence of a maintenance window,
 * its update timeline and the reminder offsets. Shared by the `maintenance-occurrences` collection,
 * the route handlers, the worker and the client components, so it imports nothing server-only.
 *
 * Model (docs/Maintenance.md → Announcements):
 * - Every concrete window of a `maintenance` document (the single window, each recurring or cron
 *   occurrence, or the run of a manual maintenance) is a `maintenance-occurrences` document with
 *   its own `state` and `updates` timeline, so recurring windows track updates per occurrence.
 * - `state`: scheduled → in-progress → (verifying →) completed, or scheduled → cancelled.
 * - Each update is `{ status, message, postedAt }`, the same shape as incident updates (#105), so
 *   history pages (#107) and feeds (#108) can treat both alike. Every state change appends one.
 */
import { z } from 'zod'

export const OCCURRENCE_STATES = [
  'scheduled',
  'in-progress',
  'verifying',
  'completed',
  'cancelled',
] as const
export type OccurrenceState = (typeof OCCURRENCE_STATES)[number]

/** English labels for the Payload admin select (the Marmot UI translates them). */
export const OCCURRENCE_STATE_LABELS: Record<OccurrenceState, string> = {
  scheduled: 'Scheduled',
  'in-progress': 'In progress',
  verifying: 'Verifying',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

/** States in which the window is running: monitors are in maintenance and alerts suppressed. */
export const OPEN_OCCURRENCE_STATES: readonly OccurrenceState[] = ['in-progress', 'verifying']
/** States that are not final yet. */
export const UNFINISHED_OCCURRENCE_STATES: readonly OccurrenceState[] = [
  'scheduled',
  'in-progress',
  'verifying',
]
export const FINISHED_OCCURRENCE_STATES: readonly OccurrenceState[] = ['completed', 'cancelled']

export const isOpenState = (state: string | null | undefined): boolean =>
  (OPEN_OCCURRENCE_STATES as readonly string[]).includes(state ?? '')
export const isFinishedState = (state: string | null | undefined): boolean =>
  (FINISHED_OCCURRENCE_STATES as readonly string[]).includes(state ?? '')

/**
 * Statuses an update may carry from each state. Posting the current state adds a note; any other
 * allowed status is a transition. Finished occurrences only take notes (e.g. a post-mortem link).
 */
export const OCCURRENCE_TRANSITIONS: Record<OccurrenceState, readonly OccurrenceState[]> = {
  scheduled: ['scheduled', 'in-progress', 'cancelled'],
  'in-progress': ['in-progress', 'verifying', 'completed'],
  verifying: ['verifying', 'in-progress', 'completed'],
  completed: ['completed'],
  cancelled: ['cancelled'],
}

export const canPostStatus = (from: OccurrenceState, to: OccurrenceState): boolean =>
  OCCURRENCE_TRANSITIONS[from]?.includes(to) ?? false

/** Reminder offsets before the start, in minutes (stored as strings: Payload `select` values). */
export const REMINDER_OFFSETS = [
  '15',
  '30',
  '60',
  '120',
  '360',
  '720',
  '1440',
  '2880',
  '10080',
] as const
export type ReminderOffset = (typeof REMINDER_OFFSETS)[number]
export const DEFAULT_REMINDERS: ReminderOffset[] = ['1440', '60']

/** Reminders that are more than this late (worker down, offset added afterwards) are skipped. */
export const REMINDER_GRACE_MINUTES = 30

/** Default of `status-pages.maintenanceVisibilityHours`. */
export const DEFAULT_MAINTENANCE_VISIBILITY_HOURS = 24
export const MAX_MAINTENANCE_VISIBILITY_HOURS = 24 * 90

export const MAX_UPDATE_MESSAGE_LENGTH = 5000

/** Body of `POST /api/orgs/:orgId/maintenance/:id/occurrences/:occurrenceId/updates`. */
export const occurrenceUpdateSchema = z.object({
  status: z.enum(OCCURRENCE_STATES),
  message: z
    .string()
    .trim()
    .max(MAX_UPDATE_MESSAGE_LENGTH)
    .nullish()
    .transform((v) => v ?? ''),
})
export type OccurrenceUpdateInput = z.input<typeof occurrenceUpdateSchema>

/** One entry of an occurrence's timeline, as the API, the UI and the event hook see it. */
export interface OccurrenceUpdate {
  id: string
  status: OccurrenceState
  /** Markdown; empty for automatic transitions (the UI shows a default text per status). */
  message: string
  postedAt: string
}

/** An occurrence as the API and the editor see it. */
export interface OccurrenceSummary {
  id: string
  maintenanceId: string
  state: OccurrenceState
  /** Planned window (ISO). `end` is null for manual maintenances. */
  start: string
  end: string | null
  startedAt: string | null
  completedAt: string | null
  cancelledAt: string | null
  /** Reminder offsets (minutes) already sent or skipped. */
  remindersSent: number[]
  /** Newest first. */
  updates: OccurrenceUpdate[]
}
