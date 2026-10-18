/**
 * Phone-call alerts (#146): place a Twilio voice call that reads the alert out and asks for a
 * keypress, and render the TwiML of the conversation.
 *
 *   provider `voice-call` ─▶ `startVoiceCall`: store the call (`store.ts`), POST Twilio's Calls API
 *     with `Url` = `/api/notifications/voice/<callId>/twiml` and `StatusCallback` = `…/status`
 *   Twilio answers ─▶ `…/twiml` ─▶ `<Gather>` reading the message ─▶ the keypress goes to `…/gather`:
 *     1 acknowledges the incident (`webhooks.ts`), 2 repeats the message
 *   call ends ─▶ `…/status`: unanswered, busy or voicemail ─▶ `voice-call-retry` job after the
 *     channel's delay (`retry.ts`), while attempts remain and the incident is still open
 *
 * Every webhook is verified with Twilio's signature (`signature.ts`) over the URL Marmot gave
 * Twilio, so `NEXT_PUBLIC_SERVER_URL` must be the public address Twilio can reach.
 */
import { env } from '@/env'
import type { Locale } from '@/i18n/locales'
import { httpRequest } from '@/server/notification-providers/http'
import type { NotificationSendContext } from '@/server/notification-providers/types'
import { serverTranslator } from '@/server/i18n'

import { newVoiceCallId, saveVoiceCall, updateVoiceCall, type VoiceCallState } from './store'

export type VoiceWebhookKind = 'twiml' | 'gather' | 'status'

/** Readings in a row without a keypress before the call says goodbye. */
export const MAX_SILENT_PLAYS = 3
/** Hard cap on readings per attempt, repeats included. */
export const MAX_PLAYS = 10
/** Seconds Twilio lets the phone ring before giving up (`no-answer`). */
export const RING_TIMEOUT_SECONDS = 30

/** `<Say language>` per organization language when the channel does not set one. */
const SAY_LANGUAGES: Record<Locale, string> = {
  en: 'en-US',
  fr: 'fr-FR',
  de: 'de-DE',
  es: 'es-ES',
}

export const sayLanguage = (configured: string | null | undefined, locale: Locale): string =>
  configured?.trim() || SAY_LANGUAGES[locale] || 'en-US'

/** `+14155550123` from `+1 (415) 555-0123`. */
export const normalizePhoneNumber = (value: string): string => value.trim().replace(/[\s().-]/g, '')

/** Absolute URL of one of a call's webhooks, exactly as handed to Twilio (and signed by it). */
export const voiceWebhookUrl = (callId: string, kind: VoiceWebhookKind): string =>
  `${env.NEXT_PUBLIC_SERVER_URL.replace(/\/+$/, '')}/api/notifications/voice/${callId}/${kind}`

/** Text a speech engine can read: no links, emoji or `[…]` brackets. */
export function speakable(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, ' ')
    .replace(/\[\s*([^\]]*?)\s*\]/g, '$1. ')
    .replace(/\s+/g, ' ')
    .replace(/(\.\s*){2,}/g, '. ')
    .replace(/\s+([.,:;!?])/g, '$1')
    .trim()
    .slice(0, 1000)
}

/** What a call reads out before the keypress prompt. */
export function buildSpeech(
  ctx: Pick<
    NotificationSendContext,
    'message' | 'monitor' | 'heartbeat' | 'event' | 'test' | 'incidentId'
  >,
  locale: Locale,
): string {
  const t = serverTranslator(locale)
  if (ctx.test) return t('notifications.voiceCall.test')
  if (ctx.monitor && ctx.incidentId && (ctx.event === 'down' || ctx.event === 'reminder')) {
    const key = ctx.event === 'reminder' ? 'stillDown' : 'down'
    let text = t(`notifications.voiceCall.${key}`, { monitor: speakable(ctx.monitor.name) })
    const cause = ctx.heartbeat?.msg ? speakable(ctx.heartbeat.msg) : ''
    if (cause) text += ` ${t('notifications.voiceCall.cause', { cause })}`
    return text
  }
  return t('notifications.voiceCall.generic', { message: speakable(ctx.message) })
}

const xml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

const say = (state: Pick<VoiceCallState, 'voice' | 'language'>, text: string) =>
  `<Say${state.voice ? ` voice="${xml(state.voice)}"` : ''} language="${xml(state.language)}">${xml(text)}</Say>`

const response = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`

/** TwiML that reads the message and waits for a key; silence goes back to `…/gather` without digits. */
export function gatherTwiml(state: VoiceCallState, preface?: string): string {
  const t = serverTranslator(state.locale)
  const prompt = state.incidentId
    ? t('notifications.voiceCall.promptAcknowledge')
    : state.test
      ? t('notifications.voiceCall.promptTest')
      : t('notifications.voiceCall.promptRepeat')
  const action = xml(voiceWebhookUrl(state.id, 'gather'))
  return response(
    (preface ? say(state, preface) : '') +
      `<Gather input="dtmf" numDigits="1" timeout="8" action="${action}" method="POST">` +
      say(state, `${state.speech} ${prompt}`) +
      `</Gather><Redirect method="POST">${action}</Redirect>`,
  )
}

/** TwiML that says `text` (when given) and hangs up. */
export function hangupTwiml(
  state: Pick<VoiceCallState, 'voice' | 'language'> | null,
  text?: string,
): string {
  return response(`${state && text ? say(state, text) : ''}<Hangup/>`)
}

/** Twilio's answer to a create-call request (only what Marmot reads). */
interface TwilioCall {
  sid?: string
}

/** Place the current attempt of `state` with Twilio; resolves with the call SID. */
export async function placeVoiceCall(state: VoiceCallState): Promise<string> {
  const body = new URLSearchParams()
  body.append('To', state.toNumber)
  body.append('From', state.fromNumber)
  body.append('Url', voiceWebhookUrl(state.id, 'twiml'))
  body.append('Method', 'POST')
  body.append('StatusCallback', voiceWebhookUrl(state.id, 'status'))
  body.append('StatusCallbackMethod', 'POST')
  body.append('StatusCallbackEvent', 'completed')
  body.append('Timeout', String(RING_TIMEOUT_SECONDS))
  // Voicemail counts as unanswered, so detect answering machines when a retry could follow.
  if (state.incidentId && state.maxAttempts > state.attempt)
    body.append('MachineDetection', 'Enable')

  let call: TwilioCall
  try {
    const res = await httpRequest(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(state.accountSid)}/Calls.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
          Authorization: `Basic ${Buffer.from(`${state.accountSid}:${state.authToken}`).toString('base64')}`,
        },
        rawBody: body.toString(),
      },
    )
    call = (await res.json().catch(() => ({}))) as TwilioCall
  } catch (error) {
    throw new Error(`Twilio: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!call.sid) throw new Error('Twilio: the response did not include a call SID')
  return call.sid
}

export interface VoiceCallConfig {
  accountSid: string
  authToken: string
  fromNumber: string
  toNumber: string
  voice?: string
  language?: string
  retries: number
  retryDelaySeconds: number
}

/** Store and place a call for one notification; resolves with a short success text. */
export async function startVoiceCall(
  config: VoiceCallConfig,
  ctx: NotificationSendContext,
): Promise<string> {
  const locale = ctx.locale ?? 'en'
  const incidentId = ctx.test ? null : (ctx.incidentId ?? null)
  const state: VoiceCallState = {
    id: newVoiceCallId(),
    accountSid: config.accountSid.trim(),
    authToken: config.authToken.trim(),
    fromNumber: normalizePhoneNumber(config.fromNumber),
    toNumber: normalizePhoneNumber(config.toNumber),
    voice: config.voice?.trim() || null,
    language: sayLanguage(config.language, locale),
    locale,
    speech: buildSpeech({ ...ctx, incidentId }, locale),
    incidentId,
    organizationId: ctx.organizationId ?? null,
    notificationId: ctx.notificationId ?? null,
    test: Boolean(ctx.test),
    attempt: 1,
    // Only an incident someone has to acknowledge is worth calling back for.
    maxAttempts: incidentId ? 1 + config.retries : 1,
    retryDelaySeconds: config.retryDelaySeconds,
    callSid: null,
    plays: 0,
    silentPlays: 0,
    machine: false,
    acknowledged: false,
  }
  await saveVoiceCall(state)
  const sid = await placeVoiceCall(state)
  await updateVoiceCall(state.id, { callSid: sid })
  return serverTranslator(locale)('notifications.voiceCall.placed', { sid })
}
