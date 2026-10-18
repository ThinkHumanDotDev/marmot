/**
 * Calling again when a phone-call alert (#146) goes unanswered: the status webhook enqueues a
 * delayed `voice-call-retry` job on the notifications queue (id `voice-<callId>-a<attempt>`, so an
 * attempt is never queued twice); the notification worker places the next call unless someone
 * acknowledged meanwhile, the incident is no longer open or the channel was switched off.
 */
import type { JobsOptions, Queue } from 'bullmq'
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import type { Notification } from '@/payload-types'
import { getIncident } from '@/server/incidents/store'
import { getNotificationsQueue, NOTIFICATION_JOB_OPTIONS } from '@/server/notifications/dispatch'

import { placeVoiceCall } from './calls'
import { loadVoiceCall, updateVoiceCall, type VoiceCallState } from './store'

const log = childLogger('voice-calls:retry')

export const VOICE_CALL_RETRY_JOB = 'voice-call-retry' as const

export interface VoiceCallRetryJobData {
  callId: string
  /** The attempt this job places (2 for the first retry). */
  attempt: number
}

export const isVoiceCallJobName = (name: string): name is typeof VOICE_CALL_RETRY_JOB =>
  name === VOICE_CALL_RETRY_JOB

export const voiceCallRetryJobId = (callId: string, attempt: number) =>
  `voice-${callId}-a${attempt}`

export interface VoiceCallRetryJob {
  name: typeof VOICE_CALL_RETRY_JOB
  data: VoiceCallRetryJobData
  opts: JobsOptions & { jobId: string; delay: number }
}

/** Where retry jobs go: BullMQ by default, a recorder in tests. */
export type VoiceCallJobSink = (job: VoiceCallRetryJob) => Promise<void>

const bullSink: VoiceCallJobSink = async (job) => {
  const queue = getNotificationsQueue() as unknown as Queue<
    VoiceCallRetryJobData,
    void,
    typeof VOICE_CALL_RETRY_JOB
  >
  await queue.add(job.name, job.data, job.opts)
}

let sink: VoiceCallJobSink | null = null

/** Replace the job sink (tests); `null` restores BullMQ. */
export function setVoiceCallJobSink(next: VoiceCallJobSink | null): void {
  sink = next
}

/** Queue the next attempt of `state` after its delay. */
export async function scheduleVoiceCallRetry(state: VoiceCallState): Promise<VoiceCallRetryJob> {
  const attempt = state.attempt + 1
  const job: VoiceCallRetryJob = {
    name: VOICE_CALL_RETRY_JOB,
    data: { callId: state.id, attempt },
    opts: {
      ...NOTIFICATION_JOB_OPTIONS,
      delay: Math.max(0, state.retryDelaySeconds) * 1000,
      jobId: voiceCallRetryJobId(state.id, attempt),
    },
  }
  await (sink ?? bullSink)(job)
  log.info({ callId: state.id, attempt, incidentId: state.incidentId }, 'voice call retry queued')
  return job
}

export interface VoiceCallRetryResult {
  outcome: 'called' | 'skipped'
  reason?: string
}

/** Worker side of `voice-call-retry`. Throws when Twilio fails so BullMQ retries. */
export async function processVoiceCallRetry(
  payload: Payload,
  data: VoiceCallRetryJobData,
): Promise<VoiceCallRetryResult> {
  const state = await loadVoiceCall(data.callId)
  if (!state) return { outcome: 'skipped', reason: 'expired' }
  if (state.acknowledged) return { outcome: 'skipped', reason: 'acknowledged' }
  if (data.attempt > state.maxAttempts) return { outcome: 'skipped', reason: 'no-attempts-left' }
  if (state.attempt >= data.attempt) return { outcome: 'skipped', reason: 'stale' }
  if (!state.incidentId) return { outcome: 'skipped', reason: 'no-incident' }

  const incident = await getIncident(payload, state.incidentId)
  if (incident?.status !== 'open') return { outcome: 'skipped', reason: 'not-open' }
  if (state.notificationId) {
    const channel = (await payload
      .findByID({
        collection: 'notifications',
        id: state.notificationId,
        depth: 0,
        overrideAccess: true,
      })
      .catch(() => null)) as Notification | null
    if (!channel?.active) return { outcome: 'skipped', reason: 'channel-unavailable' }
  }

  const next: VoiceCallState = {
    ...state,
    attempt: data.attempt,
    callSid: null,
    plays: 0,
    silentPlays: 0,
    machine: false,
  }
  await updateVoiceCall(state.id, {
    attempt: next.attempt,
    callSid: null,
    plays: 0,
    silentPlays: 0,
    machine: false,
  })
  let sid: string
  try {
    sid = await placeVoiceCall(next)
  } catch (error) {
    // Let BullMQ's retry of this job place the attempt again.
    await updateVoiceCall(state.id, { attempt: state.attempt })
    throw error
  }
  await updateVoiceCall(state.id, { callSid: sid })
  log.info({ callId: state.id, attempt: data.attempt, sid }, 'voice call retried')
  return { outcome: 'called' }
}
