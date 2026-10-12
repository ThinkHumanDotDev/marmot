/**
 * Commander reminders of declared incidents (#101). Every write to an open or mitigated incident
 * re-arms `nextReminderAt` (the severity's threshold after the activity: 1 h critical, 4 h major,
 * 24 h minor). The `declared-incident-reminders` job (every five minutes on `marmot:maintenance`)
 * picks up the incidents whose reminder is due, notifies the commander and the following channels
 * (`enqueueDeclaredNotifications(…, 'reminder')`) and schedules the next one with backoff
 * (`reminderDelaySeconds`: the threshold doubles with each reminder, capped at a week).
 */
import type { Queue } from 'bullmq'
import type { Payload } from 'payload'

import {
  ACTIVE_DECLARED_STATUSES,
  reminderDelaySeconds,
  type DeclaredIncidentSeverity,
} from '@/lib/declared-incidents'
import { childLogger } from '@/lib/logger'
import type { DeclaredIncident } from '@/payload-types'

import type { DeclaredIncidentContext } from './hooks'
import { enqueueDeclaredNotifications } from './notify'

const log = childLogger('declared-incidents:reminders')

export const DECLARED_REMINDERS_JOB_NAME = 'declared-incident-reminders'
export const DECLARED_REMINDERS_INTERVAL_MS = 5 * 60_000
const BATCH = 100

/** Upsert the reminder scheduler. Idempotent; called on every worker boot. */
export async function scheduleDeclaredRemindersJob(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    DECLARED_REMINDERS_JOB_NAME,
    { every: DECLARED_REMINDERS_INTERVAL_MS },
    { name: DECLARED_REMINDERS_JOB_NAME, opts: { removeOnComplete: 10, removeOnFail: 50 } },
  )
}

/** Sends the due reminders; returns how many incidents were reminded. */
export async function runDeclaredReminders(
  payload: Payload,
  now: Date = new Date(),
): Promise<number> {
  const { docs } = await payload.find({
    collection: 'declared-incidents',
    where: {
      and: [
        { status: { in: [...ACTIVE_DECLARED_STATUSES] } },
        { nextReminderAt: { less_than_equal: now.toISOString() } },
      ],
    },
    sort: 'nextReminderAt',
    limit: BATCH,
    depth: 0,
    overrideAccess: true,
  })
  let sent = 0
  for (const incident of docs as DeclaredIncident[]) {
    try {
      const remindersSent = (incident.remindersSent ?? 0) + 1
      const delay = reminderDelaySeconds(
        incident.severity as DeclaredIncidentSeverity,
        remindersSent,
      )
      const context: DeclaredIncidentContext = { declaredIncidentReminder: true }
      // Worker write: the organization is the incident's own and stays untouched.
      const updated = (await payload.update({
        collection: 'declared-incidents',
        id: incident.id,
        depth: 0,
        overrideAccess: true,
        context: context as Record<string, unknown>,
        data: {
          organization: incident.organization,
          remindersSent,
          lastReminderAt: now.toISOString(),
          nextReminderAt: new Date(now.getTime() + delay * 1000).toISOString(),
        },
      })) as DeclaredIncident
      await enqueueDeclaredNotifications(payload, updated, 'reminder')
      sent++
    } catch (err) {
      log.error({ err, incidentId: incident.id }, 'failed to remind the incident commander')
    }
  }
  if (sent > 0) log.info({ sent }, 'declared incident reminders sent')
  return sent
}
