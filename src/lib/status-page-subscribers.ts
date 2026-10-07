/**
 * Status page subscribers (#104): channels, delivery modes, target validation and SMS text helpers.
 * Shared by the collections, the server (signup, rendering, delivery) and the builder/public UI, so
 * it stays free of Payload and Node-only imports.
 */

export const SUBSCRIBER_CHANNELS = ['email', 'sms', 'webhook', 'slack'] as const
export type SubscriberChannel = (typeof SUBSCRIBER_CHANNELS)[number]

export const isSubscriberChannel = (value: unknown): value is SubscriberChannel =>
  typeof value === 'string' && (SUBSCRIBER_CHANNELS as readonly string[]).includes(value)

/** How a subscriber was added. Only self sign-ups need confirming. */
export const SUBSCRIBER_SOURCES = ['self_signup', 'added_by_owner', 'import'] as const
export type SubscriberSource = (typeof SUBSCRIBER_SOURCES)[number]

/** `review`: every announcement waits for an editor; `auto`: sent as soon as it is published. */
export const SUBSCRIBER_DELIVERY_MODES = ['review', 'auto'] as const
export type SubscriberDeliveryMode = (typeof SUBSCRIBER_DELIVERY_MODES)[number]
export const DEFAULT_SUBSCRIBER_DELIVERY_MODE: SubscriberDeliveryMode = 'review'

/**
 * Life cycle of a notification batch (one announcement to every matching subscriber):
 * `pending_review` → (`send`) → `sending` → `sent` | `partially_failed` | `failed`, or
 * `pending_review` → (`discard`) → `discarded`. `retry` moves a finished batch back to `sending`.
 */
export const NOTIFICATION_BATCH_STATES = [
  'pending_review',
  'sending',
  'sent',
  'partially_failed',
  'failed',
  'discarded',
] as const
export type NotificationBatchState = (typeof NOTIFICATION_BATCH_STATES)[number]

export const DELIVERY_STATES = ['queued', 'retrying', 'sent', 'failed', 'skipped'] as const
export type DeliveryState = (typeof DELIVERY_STATES)[number]

/** What a batch announces. */
export const NOTIFICATION_EVENTS = [
  'incident_opened',
  'incident_updated',
  'incident_resolved',
  'maintenance_scheduled',
  'maintenance_reminder',
  'maintenance_started',
  'maintenance_updated',
  'maintenance_completed',
  'maintenance_cancelled',
] as const
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number]

export const isIncidentEvent = (event: NotificationEvent): boolean => event.startsWith('incident_')

/** The four SMS templates (#104): new incident, incident update, new maintenance, maintenance update. */
export const SMS_TEMPLATE_KEYS = [
  'incidentOpened',
  'incidentUpdated',
  'maintenanceScheduled',
  'maintenanceUpdated',
] as const
export type SmsTemplateKey = (typeof SMS_TEMPLATE_KEYS)[number]

export const smsTemplateKeyFor = (event: NotificationEvent): SmsTemplateKey => {
  if (event === 'incident_opened') return 'incidentOpened'
  if (isIncidentEvent(event)) return 'incidentUpdated'
  if (event === 'maintenance_scheduled') return 'maintenanceScheduled'
  return 'maintenanceUpdated'
}

/** Placeholders an SMS template may use. */
export const SMS_TEMPLATE_VARIABLES = ['siteName', 'title', 'status', 'message', 'url'] as const
export type SmsTemplateVariable = (typeof SMS_TEMPLATE_VARIABLES)[number]

export const DEFAULT_SMS_MAX_SEGMENTS = 2
export const MAX_SMS_MAX_SEGMENTS = 10

/** Self sign-ups that never confirm are removed after this many hours. */
export const UNCONFIRMED_SUBSCRIBER_TTL_HOURS = 72
/** SMS verification codes. */
export const SMS_CODE_LENGTH = 6
export const SMS_CODE_TTL_MINUTES = 15
export const SMS_CODE_MAX_ATTEMPTS = 5

export const MAX_SUBSCRIBER_HEADERS = 10
export const MAX_TARGET_LENGTH = 2048

/**
 * Channels a page offers to visitors: its enabled channels, SMS only with a Twilio channel set.
 * Empty when subscriptions are off.
 */
export function offeredChannels(
  settings:
    | { enabled?: boolean | null; channels?: readonly string[] | null; smsChannel?: unknown }
    | null
    | undefined,
): SubscriberChannel[] {
  if (!settings?.enabled) return []
  return (settings.channels ?? [])
    .filter(isSubscriberChannel)
    .filter((channel) => channel !== 'sms' || Boolean(settings.smsChannel))
}

// ---------------------------------------------------------------------------------------------
// Targets

/** Pragmatic address check (the confirmation email is the real test). */
const EMAIL = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/

export const normalizeEmail = (value: string): string => value.trim().toLowerCase()
export const isEmailAddress = (value: string): boolean => value.length <= 254 && EMAIL.test(value)

/** E.164: `+` then 8 to 15 digits. Spaces, dashes, dots and brackets are dropped first. */
export const normalizePhone = (value: string): string => {
  const trimmed = value.trim()
  const digits = trimmed.replace(/[\s().-]/g, '')
  return digits.startsWith('00') ? `+${digits.slice(2)}` : digits
}
export const isPhoneNumber = (value: string): boolean => /^\+[1-9]\d{7,14}$/.test(value)

const parseUrl = (value: string): URL | null => {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

export const isWebhookUrl = (value: string): boolean => {
  const url = parseUrl(value)
  return Boolean(
    url &&
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.hostname &&
    !url.username &&
    !url.password,
  )
}

/** Slack incoming webhook (`https://hooks.slack.com/services/…`), the only kind the Slack channel takes. */
export const isSlackWebhookUrl = (value: string): boolean => {
  const url = parseUrl(value)
  return Boolean(
    url &&
    url.protocol === 'https:' &&
    (url.hostname === 'hooks.slack.com' || url.hostname === 'hooks.slack-gov.com') &&
    /^\/(services|workflows|triggers)\/.+/.test(url.pathname),
  )
}

/** Discord channel webhook; webhook subscribers pointing at one get Discord's native format. */
export const isDiscordWebhookUrl = (value: string): boolean => {
  const url = parseUrl(value)
  return Boolean(
    url &&
    url.protocol === 'https:' &&
    /^((canary|ptb)\.)?discord(app)?\.com$/.test(url.hostname) &&
    url.pathname.startsWith('/api/webhooks/'),
  )
}

export type TargetCheck = { ok: true; target: string } | { ok: false; error: 'invalidTarget' }

/** Normalises and validates a subscriber target for its channel. */
export function normalizeTarget(channel: SubscriberChannel, raw: unknown): TargetCheck {
  if (typeof raw !== 'string') return { ok: false, error: 'invalidTarget' }
  const value = raw.trim()
  if (!value || value.length > MAX_TARGET_LENGTH) return { ok: false, error: 'invalidTarget' }
  switch (channel) {
    case 'email': {
      const email = normalizeEmail(value)
      return isEmailAddress(email)
        ? { ok: true, target: email }
        : { ok: false, error: 'invalidTarget' }
    }
    case 'sms': {
      const phone = normalizePhone(value)
      return isPhoneNumber(phone)
        ? { ok: true, target: phone }
        : { ok: false, error: 'invalidTarget' }
    }
    case 'webhook':
      return isWebhookUrl(value)
        ? { ok: true, target: value }
        : { ok: false, error: 'invalidTarget' }
    case 'slack':
      return isSlackWebhookUrl(value)
        ? { ok: true, target: value }
        : { ok: false, error: 'invalidTarget' }
  }
}

/**
 * Masked target for lists that do not need the full value (logs, the delivery log):
 * `j***@example.com`, `+4479******12`, `https://hooks.slack.com/…`.
 */
export function maskTarget(channel: SubscriberChannel, target: string): string {
  if (channel === 'email') {
    const [local = '', domain = ''] = target.split('@')
    return `${local.slice(0, 1)}***@${domain}`
  }
  if (channel === 'sms') {
    return target.length > 6
      ? `${target.slice(0, 5)}${'*'.repeat(target.length - 7)}${target.slice(-2)}`
      : '***'
  }
  const url = parseUrl(target)
  return url ? `${url.protocol}//${url.host}/…` : '…'
}

// ---------------------------------------------------------------------------------------------
// Components

/** `null`/empty = every component. Unknown ids are dropped; duplicates removed. */
export function normalizeComponentSelection(value: unknown, known: ReadonlySet<string>): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    const id = typeof entry === 'string' || typeof entry === 'number' ? String(entry) : ''
    if (id && known.has(id) && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * Does a subscriber scoped to `subscribed` (empty = everything) receive an announcement about
 * `affected` (empty = the whole page)? Page-wide announcements reach everyone; otherwise at least one
 * affected component must be subscribed.
 */
export function subscriberWantsComponents(
  subscribed: readonly string[] | null | undefined,
  affected: readonly string[] | null | undefined,
): boolean {
  if (!subscribed || subscribed.length === 0) return true
  if (!affected || affected.length === 0) return true
  const wanted = new Set(subscribed.map(String))
  return affected.some((id) => wanted.has(String(id)))
}

// ---------------------------------------------------------------------------------------------
// SMS

/** GSM 03.38 basic character set plus the extension table (each extension char costs two septets). */
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
const GSM_EXTENDED = '^{}\\[~]|€\f'

const isGsm = (text: string): boolean =>
  [...text].every((ch) => GSM_BASIC.includes(ch) || GSM_EXTENDED.includes(ch))

const gsmLength = (text: string): number =>
  [...text].reduce((n, ch) => n + (GSM_EXTENDED.includes(ch) ? 2 : 1), 0)

/** Characters (septets for GSM-7, UTF-16 units for UCS-2) that fit in `segments` SMS. */
export function smsCapacity(gsm: boolean, segments: number): number {
  if (segments <= 1) return gsm ? 160 : 70
  return segments * (gsm ? 153 : 67)
}

/** Number of SMS segments `text` is sent as. */
export function smsSegments(text: string): number {
  const gsm = isGsm(text)
  const length = gsm ? gsmLength(text) : text.length
  if (length <= (gsm ? 160 : 70)) return 1
  return Math.ceil(length / (gsm ? 153 : 67))
}

/**
 * Truncates `text` with an ellipsis so it fits in `maxSegments` SMS. The `url` (when present at
 * the end) is kept intact: only the part before it is shortened.
 */
export function truncateSms(text: string, maxSegments: number, keepSuffix = ''): string {
  const segments = Math.max(1, Math.min(MAX_SMS_MAX_SEGMENTS, Math.floor(maxSegments) || 1))
  if (smsSegments(text) <= segments) return text
  const suffix = keepSuffix && text.endsWith(keepSuffix) ? keepSuffix : ''
  const head = suffix ? text.slice(0, text.length - suffix.length) : text
  const gsm = isGsm(text)
  const ellipsis = gsm ? '...' : '…'
  const capacity = smsCapacity(gsm, segments)
  const measure = (s: string) => (gsm ? gsmLength(s) : s.length)
  const budget = capacity - measure(suffix) - measure(ellipsis)
  if (budget <= 0) return [...text].slice(0, capacity).join('')
  let out = ''
  for (const ch of head) {
    if (measure(out + ch) > budget) break
    out += ch
  }
  return `${out.trimEnd()}${ellipsis}${suffix}`
}

/** Replaces `{{ name }}` placeholders; unknown names render empty. */
export function renderSmsTemplate(
  template: string,
  values: Partial<Record<SmsTemplateVariable, string>>,
): string {
  return template
    .replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_, name: string) =>
      (SMS_TEMPLATE_VARIABLES as readonly string[]).includes(name)
        ? (values[name as SmsTemplateVariable] ?? '')
        : '',
    )
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

/** STOP keywords (Twilio's defaults) that unsubscribe an SMS subscriber. */
export const SMS_STOP_KEYWORDS = [
  'STOP',
  'STOPALL',
  'UNSUBSCRIBE',
  'CANCEL',
  'END',
  'QUIT',
  'OPTOUT',
  'REVOKE',
] as const

export const isSmsStopKeyword = (body: string): boolean =>
  (SMS_STOP_KEYWORDS as readonly string[]).includes(body.trim().toUpperCase())
