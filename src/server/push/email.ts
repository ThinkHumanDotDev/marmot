/**
 * Ping-by-email for push monitors (#135): applies inbound mail addressed to
 * `<push token>@INBOUND_EMAIL_DOMAIN` as push signals. Transport-agnostic: the worker's SMTP
 * listener (`./smtp.ts`) and the inbound-parse webhook (`/api/inbound-email`, `./inbound-webhook.ts`)
 * both end here.
 *
 * Each message is classified by the monitor's keyword rules (`classifyPushEmail`,
 * `src/lib/push-email.ts`) and recorded through `ingestPushSignal` with source `email`: the subject
 * becomes the message, a snippet of the plain-text body the ping log entry. Ignored mail (no
 * keyword matched, "unmatched mail: ignore") is kept in the ping log as a `log` entry, which does
 * not change the monitor's status.
 */
import { simpleParser, type AddressObject } from 'mailparser'
import type { Payload } from 'payload'

import { childLogger } from '@/lib/logger'
import {
  classifyPushEmail,
  PUSH_EMAIL_SNIPPET_LENGTH,
  pushTokenFromAddress,
} from '@/lib/push-email'
import { PUSH_MSG_MAX_LENGTH, type PushSignalKind } from '@/lib/push-schedule'
import type { Monitor } from '@/payload-types'
import { inboundEmailDomain } from './inbound-config'
import { findPushMonitor } from './index'
import { ingestPushSignal } from './signals'

const log = childLogger('push-email')

export { inboundEmailDomain, isPushEmailEnabled, monitorPushEmailAddress } from './inbound-config'

export interface InboundEmail {
  /** Envelope or header recipients; only those on the inbound domain are considered. */
  recipients: string[]
  subject?: string | null
  text?: string | null
  from?: string | null
}

export type InboundRecipientOutcome =
  | { address: string; status: 'recorded'; kind: PushSignalKind; monitorId: string | number }
  | { address: string; status: 'ignored'; monitorId: string | number }
  | { address: string; status: 'unknown' }

/**
 * The push monitor an address belongs to (active push monitors only), or `null`. Tokens are matched
 * exactly first, then lower-cased (some relays lower-case the local part).
 */
export async function findPushMonitorByAddress(
  payload: Payload,
  address: string,
): Promise<Monitor | null> {
  const domain = inboundEmailDomain()
  if (!domain) return null
  const token = pushTokenFromAddress(address, domain)
  if (!token) return null
  const monitor = await findPushMonitor(payload, token)
  if (monitor || token === token.toLowerCase()) return monitor
  return findPushMonitor(payload, token.toLowerCase())
}

const cut = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value)

/** Apply one message to every push monitor it is addressed to. Unknown addresses are dropped. */
export async function ingestPushEmail(
  payload: Payload,
  mail: InboundEmail,
  options: { now?: Date } = {},
): Promise<InboundRecipientOutcome[]> {
  const seen = new Set<string>()
  const outcomes: InboundRecipientOutcome[] = []
  for (const raw of mail.recipients) {
    const address = raw.trim().toLowerCase()
    if (!address || seen.has(address)) continue
    seen.add(address)
    const monitor = await findPushMonitorByAddress(payload, raw.trim())
    if (!monitor) {
      outcomes.push({ address, status: 'unknown' })
      continue
    }
    if (seen.has(`monitor:${monitor.id}`)) continue
    seen.add(`monitor:${monitor.id}`)

    const subject = mail.subject?.replace(/\s+/g, ' ').trim() || '(no subject)'
    const text = (mail.text ?? '').trim()
    const verdict = classifyPushEmail(monitor, { subject, text })
    const kind: PushSignalKind = verdict.kind === 'ignore' ? 'log' : verdict.kind
    const msg = cut(
      verdict.kind === 'ignore' ? `Ignored: ${subject}` : subject,
      PUSH_MSG_MAX_LENGTH,
    )
    await ingestPushSignal(
      payload,
      monitor,
      {
        kind,
        msg,
        body: text ? cut(text, PUSH_EMAIL_SNIPPET_LENGTH) : null,
        bodyTruncated: text.length > PUSH_EMAIL_SNIPPET_LENGTH,
        source: 'email',
      },
      options,
    )
    log.debug({ monitorId: monitor.id, kind, matched: verdict.matched }, 'email ping received')
    outcomes.push(
      verdict.kind === 'ignore'
        ? { address, status: 'ignored', monitorId: monitor.id }
        : { address, status: 'recorded', kind, monitorId: monitor.id },
    )
  }
  return outcomes
}

const addresses = (field: AddressObject | AddressObject[] | undefined): string[] =>
  (Array.isArray(field) ? field : field ? [field] : []).flatMap((group) =>
    group.value.flatMap((entry) => [
      ...(entry.address ? [entry.address] : []),
      ...(entry.group ?? []).flatMap((member) => (member.address ? [member.address] : [])),
    ]),
  )

/**
 * Parse a raw RFC 5322 message. `envelope` (SMTP `RCPT TO`, a relay's recipient header) takes
 * precedence over the `To`/`Cc` headers, which may not name the monitor address at all (Bcc,
 * forwarding).
 */
export async function parseRawEmail(
  raw: Buffer | string,
  envelope: string[] = [],
): Promise<InboundEmail> {
  const parsed = await simpleParser(raw, {
    skipImageLinks: true,
    skipTextToHtml: true,
    skipTextLinks: true,
  })
  const headerRecipients = [
    ...addresses(parsed.to),
    ...addresses(parsed.cc),
    ...(() => {
      const delivered = parsed.headers.get('delivered-to')
      return typeof delivered === 'string' ? [delivered] : []
    })(),
  ]
  return {
    recipients: envelope.length > 0 ? envelope : headerRecipients,
    subject: parsed.subject ?? null,
    text: parsed.text ?? null,
    from: addresses(parsed.from)[0] ?? null,
  }
}
