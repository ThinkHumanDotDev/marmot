/**
 * Ping-by-email for push monitors (#135): the pure rules shared by the inbound mail ingestion, the
 * monitor validation and the UI. Nothing here touches the database, the network or the clock.
 *
 * A push monitor receives mail at `<push token>@<INBOUND_EMAIL_DOMAIN>`. Each message is classified
 * by keywords matched (case-insensitively) against its subject and plain-text body, in this order:
 *
 * 1. the failure keyword → `fail`
 * 2. the success keyword → `success`
 * 3. the start keyword → `start` (opens a run, like `/api/push/:token/start`)
 * 4. no success keyword configured → `success` (any mail is a ping, the default)
 * 5. otherwise the "unmatched mail" setting: ignore the message, or record a failure.
 */

/** What to do with a message that matches none of the configured keywords. */
export const PUSH_EMAIL_UNMATCHED = ['ignore', 'fail'] as const
export type PushEmailUnmatched = (typeof PUSH_EMAIL_UNMATCHED)[number]

/** Longest keyword accepted. */
export const PUSH_EMAIL_KEYWORD_MAX_LENGTH = 200
/** Characters of the plain-text body kept in the ping log. */
export const PUSH_EMAIL_SNIPPET_LENGTH = 2_000

export interface PushEmailRules {
  pushEmailSuccessKeyword?: string | null
  pushEmailFailureKeyword?: string | null
  pushEmailStartKeyword?: string | null
  pushEmailUnmatched?: PushEmailUnmatched | null
}

export interface PushEmailContent {
  subject?: string | null
  text?: string | null
}

export type PushEmailVerdict =
  | { kind: 'success' | 'fail' | 'start'; matched: 'failure' | 'success' | 'start' | null }
  | { kind: 'ignore'; matched: null }

const keyword = (value: string | null | undefined): string | null =>
  value?.trim().toLowerCase() || null

/** Classify one message under a monitor's rules (see the module comment for the order). */
export function classifyPushEmail(rules: PushEmailRules, mail: PushEmailContent): PushEmailVerdict {
  const haystack = `${mail.subject ?? ''}\n${mail.text ?? ''}`.toLowerCase()
  const failure = keyword(rules.pushEmailFailureKeyword)
  const success = keyword(rules.pushEmailSuccessKeyword)
  const start = keyword(rules.pushEmailStartKeyword)

  if (failure && haystack.includes(failure)) return { kind: 'fail', matched: 'failure' }
  if (success && haystack.includes(success)) return { kind: 'success', matched: 'success' }
  if (start && haystack.includes(start)) return { kind: 'start', matched: 'start' }
  if (!success) return { kind: 'success', matched: null }
  return rules.pushEmailUnmatched === 'fail'
    ? { kind: 'fail', matched: null }
    : { kind: 'ignore', matched: null }
}

/**
 * The push token addressed by `address` when it is on `domain`, else `null`. A `+tag` after the
 * token is ignored (`<token>+nightly@domain`), so one monitor can take mail from several senders.
 */
export function pushTokenFromAddress(address: string, domain: string): string | null {
  const value = address.trim().replace(/^<|>$/g, '')
  const at = value.lastIndexOf('@')
  if (at <= 0) return null
  if (value.slice(at + 1).toLowerCase() !== domain.toLowerCase()) return null
  const local = value.slice(0, at).split('+')[0]
  return /^[A-Za-z0-9_-]{1,128}$/.test(local) ? local : null
}

/** The inbound address of a push token, or `null` when ping-by-email is off. */
export function pushEmailAddress(
  token: string | null | undefined,
  domain: string | null | undefined,
): string | null {
  return token && domain ? `${token}@${domain}` : null
}
