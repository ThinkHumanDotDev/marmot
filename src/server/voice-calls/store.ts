/**
 * State of phone-call alerts (#146), kept in Redis for `VOICE_CALL_TTL_SECONDS` as a hash under
 * `marmot:voice-call:<callId>`. The call id is random (128 bits) and is the only thing in the webhook
 * URLs Twilio calls back; everything else (what to say, which incident to acknowledge, the auth
 * token that verifies Twilio's signature, how many attempts are left) stays server-side.
 */
import { randomBytes } from 'node:crypto'

import type { Redis } from 'ioredis'

import type { Locale } from '@/i18n/locales'
import { createRedis } from '@/server/redis'

/** Long enough for every retry (at most 5, one hour apart) plus ringing and the conversation. */
export const VOICE_CALL_TTL_SECONDS = 12 * 3600

const KEY_PREFIX = 'marmot:voice-call:'

export const VOICE_CALL_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/

export interface VoiceCallState {
  id: string
  /** Twilio credentials and numbers of the channel at the time of the alert. */
  accountSid: string
  authToken: string
  fromNumber: string
  toNumber: string
  voice: string | null
  /** BCP 47 language of `<Say>`, e.g. `en-US`. */
  language: string
  /** Organization language of the spoken prompts. */
  locale: Locale
  /** What the call reads out before the keypress prompt. */
  speech: string
  /** The monitor incident that pressing 1 acknowledges; `null` for other messages. */
  incidentId: string | null
  organizationId: string | null
  notificationId: string | null
  /** A test call from the channel form: pressing 1 confirms, nothing is acknowledged. */
  test: boolean
  /** 1 for the first call, 2 for the first retry, … */
  attempt: number
  /** Calls placed at most (first call plus retries) while nobody answers. */
  maxAttempts: number
  retryDelaySeconds: number
  /** Twilio's id of the current attempt (`CA…`); callbacks of earlier attempts are ignored. */
  callSid: string | null
  /** Times the message was read out in the current attempt. */
  plays: number
  /** Readings in a row that got no keypress, in the current attempt. */
  silentPlays: number
  /** The current attempt reached voicemail or a fax machine. */
  machine: boolean
  /** Someone pressed 1: no more retries. */
  acknowledged: boolean
}

let client: Redis | undefined

const redis = (): Redis => {
  client ??= createRedis({ maxRetriesPerRequest: 1, commandTimeout: 2_000 })
  return client
}

/** Close the connection (tests, shutdown). */
export async function closeVoiceCallStore(): Promise<void> {
  const current = client
  client = undefined
  if (current) await current.quit().catch(() => current.disconnect())
}

export const newVoiceCallId = (): string => randomBytes(16).toString('base64url')

const encode = (patch: Partial<VoiceCallState>): string[] =>
  Object.entries(patch).flatMap(([field, value]) => [field, JSON.stringify(value ?? null)])

export async function saveVoiceCall(state: VoiceCallState): Promise<void> {
  const key = KEY_PREFIX + state.id
  await redis()
    .multi()
    .del(key)
    .hset(key, ...encode(state))
    .expire(key, VOICE_CALL_TTL_SECONDS)
    .exec()
}

export async function loadVoiceCall(id: string): Promise<VoiceCallState | null> {
  if (!VOICE_CALL_ID_PATTERN.test(id)) return null
  const raw = await redis().hgetall(KEY_PREFIX + id)
  if (!raw?.id) return null
  try {
    return Object.fromEntries(
      Object.entries(raw).map(([field, value]) => [field, JSON.parse(value) as unknown]),
    ) as unknown as VoiceCallState
  } catch {
    return null
  }
}

/** Only touch a call that still exists, so a late update never revives one without a TTL. */
const UPDATE_IF_EXISTS = `if redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('HSET', KEYS[1], unpack(ARGV))
  return 1
end
return 0`

/**
 * Set some fields of a stored call. Each field is written on its own, so concurrent webhooks that
 * touch different fields do not overwrite each other. Resolves `false` when the call expired.
 */
export async function updateVoiceCall(
  id: string,
  patch: Partial<Omit<VoiceCallState, 'id'>>,
): Promise<boolean> {
  const fields = encode(patch)
  if (!VOICE_CALL_ID_PATTERN.test(id) || fields.length === 0) return false
  const updated = await redis().eval(UPDATE_IF_EXISTS, 1, KEY_PREFIX + id, ...fields)
  return updated === 1
}
