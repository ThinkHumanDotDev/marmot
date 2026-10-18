/**
 * Twilio webhooks of phone-call alerts (#146): `POST /api/notifications/voice/:callId/{twiml,gather,status}`.
 *
 * Every request must carry a valid `X-Twilio-Signature` for the URL Marmot handed to Twilio and the
 * auth token of the channel that placed the call; anything else is refused (403) before a field of
 * the body is looked at. Unknown or expired call ids are 404.
 */
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import { serverTranslator } from '@/server/i18n'
import { acknowledge } from '@/server/incidents/actions'
import { auditIncidentAction } from '@/server/incidents/audit'
import { getIncident } from '@/server/incidents/store'

import {
  gatherTwiml,
  hangupTwiml,
  MAX_PLAYS,
  MAX_SILENT_PLAYS,
  voiceWebhookUrl,
  type VoiceWebhookKind,
} from './calls'
import { scheduleVoiceCallRetry } from './retry'
import { TWILIO_SIGNATURE_HEADER, validateTwilioSignature } from './signature'
import { loadVoiceCall, updateVoiceCall, type VoiceCallState } from './store'

const log = childLogger('voice-calls:webhooks')

const MAX_BODY_BYTES = 64 * 1024

const TERMINAL_STATUSES = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled'])
const UNANSWERED_STATUSES = new Set(['busy', 'no-answer', 'failed', 'canceled'])

/** `AnsweredBy` values of answering-machine detection that mean nobody picked up. */
const isMachine = (answeredBy: string | null) =>
  !!answeredBy && (answeredBy.startsWith('machine') || answeredBy === 'fax')

const twiml = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/xml; charset=utf-8' } })

const plain = (status: number) => new Response(null, { status })

export const isVoiceWebhookKind = (value: string): value is VoiceWebhookKind =>
  value === 'twiml' || value === 'gather' || value === 'status'

async function readForm(request: Request): Promise<URLSearchParams | null> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return null
  const text = await request.text().catch(() => null)
  if (text === null || text.length > MAX_BODY_BYTES) return null
  return new URLSearchParams(text)
}

/**
 * Handle one webhook. `getPayload` is only called when the request needs the database
 * (acknowledging), so the TwiML and status paths stay cheap.
 */
export async function handleVoiceWebhook(
  request: Request,
  callId: string,
  kind: VoiceWebhookKind,
  getPayload: () => Promise<Payload>,
): Promise<Response> {
  const state = await loadVoiceCall(callId)
  if (!state) return plain(404)
  const params = await readForm(request)
  if (!params) return plain(400)

  const search = new URL(request.url).search
  const url = voiceWebhookUrl(callId, kind) + search
  const signature = request.headers.get(TWILIO_SIGNATURE_HEADER)
  if (!validateTwilioSignature(state.authToken, signature, url, params)) {
    log.warn({ callId, kind }, 'refused a voice webhook with an invalid Twilio signature')
    return plain(403)
  }
  const accountSid = params.get('AccountSid')
  if (accountSid && accountSid !== state.accountSid) return plain(403)

  const callSid = params.get('CallSid')
  // A callback of an earlier attempt (its status arriving late) changes nothing.
  if (callSid && state.callSid && callSid !== state.callSid) {
    return kind === 'status' ? plain(204) : twiml(hangupTwiml(null))
  }

  switch (kind) {
    case 'twiml':
      return answer(state, params)
    case 'gather':
      return gather(state, params, request, getPayload)
    case 'status':
      return status(state, params, getPayload)
  }
}

/** The call was picked up: hang up on voicemail (a retry follows), otherwise read the message. */
async function answer(state: VoiceCallState, params: URLSearchParams): Promise<Response> {
  if (isMachine(params.get('AnsweredBy'))) {
    await updateVoiceCall(state.id, { machine: true })
    return twiml(hangupTwiml(null))
  }
  await updateVoiceCall(state.id, { plays: 1, silentPlays: 1 })
  return twiml(gatherTwiml(state))
}

async function replay(state: VoiceCallState, silent: boolean, preface?: string): Promise<Response> {
  const t = serverTranslator(state.locale)
  const silentPlays = silent ? state.silentPlays + 1 : 1
  if (state.plays >= MAX_PLAYS || silentPlays > MAX_SILENT_PLAYS) {
    return twiml(hangupTwiml(state, t('notifications.voiceCall.goodbye')))
  }
  await updateVoiceCall(state.id, { plays: state.plays + 1, silentPlays })
  return twiml(gatherTwiml(state, preface))
}

async function gather(
  state: VoiceCallState,
  params: URLSearchParams,
  request: Request,
  getPayload: () => Promise<Payload>,
): Promise<Response> {
  const t = serverTranslator(state.locale)
  const digits = params.get('Digits') ?? ''
  if (digits === '') return replay(state, true)
  if (digits === '2') return replay(state, false)
  if (digits !== '1') return replay(state, false, t('notifications.voiceCall.invalid'))

  if (state.test) {
    await updateVoiceCall(state.id, { acknowledged: true })
    return twiml(hangupTwiml(state, t('notifications.voiceCall.testConfirmed')))
  }
  if (!state.incidentId) return twiml(hangupTwiml(state, t('notifications.voiceCall.goodbye')))

  const payload = await getPayload()
  const incident = await getIncident(payload, state.incidentId)
  // Whatever the outcome, stop calling back: someone is on the line.
  await updateVoiceCall(state.id, { acknowledged: true })
  if (!incident) return twiml(hangupTwiml(state, t('notifications.voiceCall.goodbye')))
  if (incident.status === 'resolved') {
    return twiml(hangupTwiml(state, t('notifications.voiceCall.alreadyResolved')))
  }
  if (incident.status === 'acknowledged') {
    return twiml(hangupTwiml(state, t('notifications.voiceCall.alreadyAcknowledged')))
  }
  try {
    const summary = await acknowledge(payload, incident, { userId: null, via: 'phone' })
    await auditIncidentAction(payload, request, summary, 'monitor_incident.acknowledged', null, {
      via: 'phone',
      notificationId: state.notificationId,
    })
    log.info({ callId: state.id, incidentId: incident.id }, 'incident acknowledged by phone')
    return twiml(hangupTwiml(state, t('notifications.voiceCall.acknowledged')))
  } catch (err) {
    // Acknowledged or resolved a moment ago (409), or the database failed.
    log.warn({ err, callId: state.id, incidentId: incident.id }, 'phone acknowledgement failed')
    const fresh = await getIncident(payload, state.incidentId).catch(() => null)
    const key =
      fresh?.status === 'resolved'
        ? 'alreadyResolved'
        : fresh?.status === 'acknowledged'
          ? 'alreadyAcknowledged'
          : 'failed'
    return twiml(hangupTwiml(state, t(`notifications.voiceCall.${key}`)))
  }
}

/** The call ended: call again when nobody (or only voicemail) answered and attempts remain. */
async function status(
  state: VoiceCallState,
  params: URLSearchParams,
  getPayload: () => Promise<Payload>,
): Promise<Response> {
  const callStatus = params.get('CallStatus') ?? ''
  if (!TERMINAL_STATUSES.has(callStatus)) return plain(204)
  const unanswered =
    UNANSWERED_STATUSES.has(callStatus) || isMachine(params.get('AnsweredBy')) || state.machine
  if (
    !unanswered ||
    state.acknowledged ||
    !state.incidentId ||
    state.attempt >= state.maxAttempts
  ) {
    return plain(204)
  }
  const incident = await getIncident(await getPayload(), state.incidentId).catch(() => null)
  if (incident?.status !== 'open') return plain(204)
  await scheduleVoiceCallRetry(state)
  return plain(204)
}
